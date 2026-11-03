import { AuditLogEvent as A, Client, Events, GatewayIntentBits as I, PermissionFlagsBits as P } from 'discord.js'
import { attachModeration, temporaryBan } from './moderation.js'
import { createHash } from 'node:crypto'
import { sendModuleLog } from './recovery.js'

export const requiredPermissions = P.ViewAuditLog | P.ManageRoles | P.KickMembers | P.ModerateMembers | P.BanMembers | P.ManageChannels | P.ViewChannel | P.SendMessages | P.ManageMessages | P.ManageGuild
const dangerous = P.Administrator | P.ManageGuild | P.ManageRoles | P.ManageChannels | P.BanMembers | P.KickMembers | P.ManageWebhooks | P.ModerateMembers
const tracked = new Set([A.ChannelDelete,A.RoleDelete,A.MemberBanAdd,A.MemberKick,A.BotAdd])
const rateByAction = new Map([
  [A.MemberKick,'moderation'], [A.MemberBanAdd,'moderation'],
  [A.RoleCreate,'roleCreate'], [A.RoleDelete,'roleDelete'],
  [A.ChannelCreate,'channelCreate'], [A.ChannelDelete,'channelDelete'],
  [A.WebhookCreate,'webhookCreate']
])
const flags = value => typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : 0n
const invitePattern = /(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)[\w-]+/i

function messageSignals(message, repeats, now, window, cfg) {
  const body = message.content ?? ''
  const text = body.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ')
  let duplicate = 0
  let multiUser = 0
  if (text.length >= 5) {
    const digest = createHash('sha256').update(text).digest('base64url')
    const key = message.guildId + ':' + digest
    const recent = (repeats.get(key) ?? []).filter(hit => hit.at > now-window)
    recent.push({id:message.author.id,at:now})
    repeats.set(key,recent.slice(-100))
    duplicate = recent.filter(hit => hit.id === message.author.id).length
    multiUser = new Set(recent.map(hit => hit.id)).size
  }
  const letters = body.match(/[a-z]/gi)?.length ?? 0
  const urls = body.match(/https?:\/\/[^\s]+/gi) ?? []
  const entries = value => value.toLowerCase().split(',').map(item => item.trim()).filter(Boolean)
  const domains = entries(cfg.nsfwDomains)
  return {
    mentions:message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 10 : 0),
    files:message.attachments.size,
    images:message.attachments.filter(file => file.contentType?.startsWith('image/')).size,
    stickers:message.stickers.size,
    invites:Number(invitePattern.test(body)),
    links:urls.length,
    badWords:entries(cfg.badWords).filter(word => text.includes(word)).length,
    scam:Number(urls.length > 0 && /\b(?:free nitro|claim your nitro|verify your wallet|steam gift)\b/i.test(body)),
    nsfw:urls.filter(url => {
      const hostname = URL.parse(url)?.hostname.toLowerCase()
      return hostname && domains.some(domain => hostname === domain || hostname.endsWith('.' + domain))
    }).length,
    caps:letters >= 10 ? Math.round((body.match(/[A-Z]/g)?.length ?? 0)*100/letters) : 0,
    newlines:(body.match(/\n/g) ?? []).length,
    length:body.length,
    emoji:(body.match(/<a?:\w+:\d+>|\p{Extended_Pictographic}/gu) ?? []).length,
    headers:(body.match(/^\s{0,3}#{1,3} /gm) ?? []).length,
    duplicate,multiUser
  }
}

export function isDestructive(entry,guild) {
  if (tracked.has(entry.action)) return true
  if (entry.action === A.RoleCreate || entry.action === A.RoleUpdate) {
    return entry.changes.some(change => change.key === 'permissions' && Boolean(flags(change.new) & ~flags(change.old) & dangerous))
  }
  if (entry.action === A.MemberRoleUpdate) {
    return entry.changes.some(change => change.key === '$add' && Array.isArray(change.new) && change.new.some(role => Boolean((guild.roles.cache.get(role.id)?.permissions.bitfield ?? 0n) & dangerous)))
  }
  return false
}

export function recordHit(history, key, now, window, threshold) {
  const hits = (history.get(key) ?? []).filter(at => at > now - window)
  hits.push(now)
  history.set(key,hits.slice(-Math.max(threshold,100)))
  return hits.length
}

export function attachProtection(client, db) {
  const audits = new Map()
  const joins = new Map()
  const messages = new Map()
  const repeats = new Map()
  const checkpointJoins = new Map()
  const recentAccounts = new Map()
  const raids = new Map()
  const seen = new Map()
  const responses = new Set()
  const cleanup = setInterval(() => {
    const now = Date.now()
    for (const history of [audits,joins,messages]) for (const [key,hits] of history) if (hits.at(-1) <= now-120000) history.delete(key)
    for (const active of [raids,seen]) for (const [key,until] of active) if (until <= now) active.delete(key)
    for (const [key,hits] of repeats) if (hits.at(-1).at <= now-60000) repeats.delete(key)
    for (const [key,hits] of checkpointJoins) if (hits.at(-1) <= now-3600000) checkpointJoins.delete(key)
    for (const [key,hits] of recentAccounts) if (hits.at(-1).at <= now-60000) recentAccounts.delete(key)
  },60000)
  cleanup.unref()
  const log = (guild,kind,text) => {
    db.event(guild.id,kind,text)
    if (kind === 'automod' || (['nuke','raid','checkpoint'].includes(kind) &&
        /^(?:Protection error|Response |Timed out|Removed role|Some or all|(?:kick|ban|tempban) completed)/.test(text))) {
      void sendModuleLog(guild,db,kind,text)
    }
  }
  const run = async (guild,kind,handler) => {
    try { await handler() } catch (error) {
      try { log(guild,kind,'Protection error (' + (error.code || error.name) + ')') }
      catch { console.error('Could not write security event') }
    }
  }
  const alert = (guild,kind,cfg,detail) => {
    if (!cfg.alertChannel) return
    void run(guild,kind,async () => {
      const roles = [...new Set(cfg.alertRoles)].filter(id => id !== guild.id && guild.roles.cache.has(id))
      const channel = await guild.channels.fetch(cfg.alertChannel)
      if (!channel?.isSendable() || channel.guildId !== guild.id) throw new Error('Invalid alert channel')
      await channel.send({
        content:[detail,...roles.map(id => '<@&' + id + '>')].join(' '),
        allowedMentions:{parse:[],roles}
      })
    })
  }
  const enforce = async (member,kind,cfg) => {
    const reason = 'Blackridge ' + kind + ' threshold reached'
    const action = cfg.action
    if (action === 'kick' && member.kickable) await member.kick(reason)
    else if (action === 'ban' && member.bannable) await member.ban({reason})
    else if (action === 'tempban' && member.bannable) await temporaryBan(member,cfg.tempBanMinutes,db,reason)
    else if (['timeout','quarantine'].includes(action) && member.moderatable) {
      const minutes = action === 'timeout' ? cfg.timeoutMinutes : cfg.quarantineMinutes
      const until = Math.max(Date.now()+minutes*60000,member.communicationDisabledUntilTimestamp ?? 0)
      await member.disableCommunicationUntil(until,reason)
      log(member.guild,kind,'Timed out ' + member.id + ' for ' + minutes + ' minute(s) or longer')
      return
    } else {
      log(member.guild,kind,'Response blocked by Discord permissions or role hierarchy for ' + member.id)
      return
    }
    log(member.guild,kind,action + ' completed for ' + member.id)
  }
  client.on(Events.MessageCreate,message => {
    if (!message.inGuild() || !message.member || message.author.bot || message.webhookId || message.member.permissions.has(P.ManageMessages)) return
    const guild = message.guild
    void run(guild,'automod',async () => {
      const cfg = db.config(guild.id,'automod')
      if (!cfg.enabled) return
      const key = guild.id + ':' + message.author.id
      const now = Date.now()
      if (cfg.filters && Object.values(cfg.filters).some(rule => rule.action !== 'off')) {
        const signals = messageSignals(message,repeats,now,cfg.window*1000,cfg)
        const severity = {log:0,delete:1,timeout:2}
        const matches = Object.entries(cfg.filters).filter(([name,rule]) => rule.action !== 'off' && signals[name] >= rule.limit)
        if (matches.length) {
          const [,rule] = matches.reduce((a,b) => severity[b[1].action] > severity[a[1].action] ? b : a)
          log(guild,'automod','Matched ' + matches.map(([name]) => name).join(', ') + ' · member ' + message.author.id)
          if (rule.action === 'delete') {
            if (message.deletable) await message.delete()
            else log(guild,'automod','Message deletion blocked by Discord permissions')
          }
          if (rule.action === 'timeout') await enforce(message.member,'automod',{...cfg,action:'timeout'})
          return
        }
      }
      if (recordHit(messages,key,now,cfg.window*1000,cfg.threshold) < cfg.threshold) return
      messages.delete(key)
      log(guild,'automod','Message rate exceeded by ' + message.author.id)
      if (cfg.action !== 'log') await enforce(message.member,'automod',cfg)
    })
  })
  client.on(Events.MessageDelete,message => {
    if (!message.inGuild() || message.partial || message.author?.bot || message.webhookId) return
    const guild = message.guild
    void run(guild,'automod',async () => {
      const cfg = db.config(guild.id,'automod')
      const rule = cfg.filters?.ghost
      if (!cfg.enabled || rule?.action !== 'log') return
      const count = message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 10 : 0)
      if (count >= rule.limit) log(guild,'automod','Deleted message with mentions · author ' + message.author.id)
    })
  })
  client.on(Events.GuildAuditLogEntryCreate,(entry,guild) => void run(guild,'nuke',async () => {
    const cfg = db.config(guild.id,'nuke')
    const actor = entry.executorId
    const now = Date.now()
    const category = rateByAction.get(entry.action)
    const rate = cfg.rates?.[category]
    const policy = rate ?? cfg
    if (!cfg.enabled || !actor || actor === guild.ownerId || actor === client.user.id ||
        cfg.trusted.split(',').some(id => id.trim() === actor) || seen.has(entry.id) ||
        !policy.enabled || now - entry.createdTimestamp > policy.window*1000 ||
        (!rate && !isDestructive(entry,guild))) return
    seen.set(entry.id,now+120000)
    const key = guild.id + ':' + actor
    const bucket = rate ? key + ':' + category : key
    const count = recordHit(audits,bucket,now,policy.window*1000,policy.threshold)
    if (count < policy.threshold || responses.has(key)) return
    audits.delete(bucket)
    const detail = A[entry.action] + ' by ' + actor + ' · ' + count + ' tracked actions'
    log(guild,'nuke',detail + ' · threshold reached')
    alert(guild,'nuke',cfg,'Blackridge Anti-Nuke: ' + detail)
    if (cfg.action === 'log') return
    responses.add(key)
    try {
      const member = await guild.members.fetch({user:actor,force:true})
      const current = db.config(guild.id,'nuke')
      if (!current.enabled || current.action !== cfg.action || current.trusted.split(',').some(id => id.trim() === actor)) {
        log(guild,'nuke','Response skipped after a policy change for ' + actor)
        return
      }
      if (cfg.action !== 'strip') {
        await enforce(member,'nuke',current)
        return
      }
      const roles = member.roles.cache.filter(role => role.id !== guild.id && role.editable && Boolean(role.permissions.bitfield & dangerous))
      let removed = 0
      for (const role of roles.values()) {
        await member.roles.remove(role,'Blackridge Anti-Nuke threshold reached')
        removed++
        log(guild,'nuke','Removed role ' + role.id + ' from ' + actor)
      }
      const remaining = member.roles.cache.some(role => !roles.has(role.id) && Boolean(role.permissions.bitfield & dangerous))
      if (!removed || remaining) log(guild,'nuke','Some or all dangerous permissions could not be removed from ' + actor)
    } finally { responses.delete(key) }
  }))
  client.on(Events.GuildMemberAdd,member => void run(member.guild,'raid',async () => {
    const guild = member.guild
    const cfg = db.config(guild.id,'raid')
    if (!cfg.enabled || member.user.bot || member.id === guild.ownerId) return
    const now = Date.now()
    const count = recordHit(joins,guild.id,now,cfg.window*1000,cfg.threshold)
    const active = (raids.get(guild.id) ?? 0) > now
    if (!active) {
      if (count < cfg.threshold) return
      raids.set(guild.id,now+cfg.duration*1000)
      const detail = count + ' joins in ' + cfg.window + 's · protection active for ' + cfg.duration + 's'
      log(guild,'raid',detail)
      alert(guild,'raid',cfg,'Blackridge raid detected: ' + detail)
    }
    if (cfg.age && now - member.user.createdTimestamp > cfg.age*86400000) return
    if (cfg.action === 'log') { log(guild,'raid','Flagged join from ' + member.id); return }
    await enforce(member,'raid',cfg)
  }))
  client.on(Events.GuildMemberAdd,member => void run(member.guild,'checkpoint',async () => {
    if (member.user.bot) return
    const cfg = db.config(member.guild.id,'checkpoint')
    if (!cfg.enabled) return
    const now = Date.now()
    const joined = recordHit(checkpointJoins,member.guild.id + ':' + member.id,now,3600000,3)
    const accounts = (recentAccounts.get(member.guild.id) ?? []).filter(hit => hit.at > now-60000 && hit.id !== member.id)
    const name = member.user.username?.toLowerCase().replace(/[\d_.]+$/g,'') ?? ''
    const similar = accounts.filter(hit => Math.abs(hit.created-member.user.createdTimestamp) <= 3600000 &&
      ((name.length >= 3 && name === hit.name) || (member.user.avatar && member.user.avatar === hit.avatar))).length >= 2
    accounts.push({id:member.id,at:now,created:member.user.createdTimestamp,name,avatar:member.user.avatar})
    recentAccounts.set(member.guild.id,accounts.slice(-100))
    const score = (member.user.avatar ? 0 : cfg.avatarPoints) +
      (now-member.user.createdTimestamp < cfg.age*86400000 ? cfg.agePoints : 0) +
      (joined >= 3 ? cfg.rejoinPoints : 0) + (similar ? cfg.similarPoints : 0) +
      (invitePattern.test(member.displayName ?? '') ? cfg.inviteNamePoints : 0)
    const rule = (cfg.rules?.length ? cfg.rules : [{score:cfg.threshold,action:'log'}])
      .filter(rule => score >= rule.score).sort((a,b) => b.score-a.score)[0]
    if (!rule) return
    const detail = 'Checkpoint flagged ' + member.id + ' with risk score ' + score
    log(member.guild,'checkpoint',detail)
    alert(member.guild,'checkpoint',cfg,detail)
    if (rule.action !== 'log' && member.id !== member.guild.ownerId) await enforce(member,'checkpoint',{...cfg,action:rule.action})
  }))
  return () => clearInterval(cleanup)
}

export function startBot(token,db) {
  const intents = [I.Guilds,I.GuildModeration,I.GuildMembers,I.GuildMessages]
  if (process.env.ENABLE_MESSAGE_CONTENT === 'true') intents.push(I.MessageContent)
  const client = new Client({intents})
  attachProtection(client,db)
  attachModeration(client,db)
  client.once(Events.ClientReady,() => console.log('Discord bot connected'))
  client.on(Events.Error,error => console.error('Discord client error:',error.name))
  client.login(token).catch(error => console.error('Discord login failed:',error.name))
  return client
}


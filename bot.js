import { AuditLogEvent as A, Client, Events, GatewayIntentBits as I, PermissionFlagsBits as P } from 'discord.js'
import { attachModeration, temporaryBan } from './moderation.js'

export const requiredPermissions = P.ViewAuditLog | P.ManageRoles | P.KickMembers | P.ModerateMembers | P.BanMembers | P.ManageChannels | P.ViewChannel | P.SendMessages
const dangerous = P.Administrator | P.ManageGuild | P.ManageRoles | P.ManageChannels | P.BanMembers | P.KickMembers | P.ManageWebhooks | P.ModerateMembers
const tracked = new Set([A.ChannelDelete,A.RoleDelete,A.MemberBanAdd,A.MemberKick,A.BotAdd])
const rateByAction = new Map([
  [A.MemberKick,'moderation'], [A.MemberBanAdd,'moderation'],
  [A.RoleCreate,'roleCreate'], [A.RoleDelete,'roleDelete'],
  [A.ChannelCreate,'channelCreate'], [A.ChannelDelete,'channelDelete'],
  [A.WebhookCreate,'webhookCreate']
])
const flags = value => typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : 0n

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
  const raids = new Map()
  const seen = new Map()
  const responses = new Set()
  const cleanup = setInterval(() => {
    const now = Date.now()
    for (const history of [audits,joins,messages]) for (const [key,hits] of history) if (hits.at(-1) <= now-120000) history.delete(key)
    for (const active of [raids,seen]) for (const [key,until] of active) if (until <= now) active.delete(key)
  },60000)
  cleanup.unref()
  const log = (guild,kind,text) => db.event(guild.id,kind,text)
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
      if (recordHit(messages,key,Date.now(),cfg.window*1000,cfg.threshold) < cfg.threshold) return
      messages.delete(key)
      log(guild,'automod','Message rate exceeded by ' + message.author.id)
      if (cfg.action !== 'log') await enforce(message.member,'automod',cfg)
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
    const score = (member.user.avatar ? 0 : cfg.avatarPoints) +
      (Date.now()-member.user.createdTimestamp < cfg.age*86400000 ? cfg.agePoints : 0)
    if (score < cfg.threshold) return
    const detail = 'Checkpoint flagged ' + member.id + ' with risk score ' + score
    log(member.guild,'checkpoint',detail)
    alert(member.guild,'checkpoint',cfg,detail)
  }))
  return () => clearInterval(cleanup)
}

export function startBot(token,db) {
  const client = new Client({intents:[I.Guilds,I.GuildModeration,I.GuildMembers,I.GuildMessages]})
  attachProtection(client,db)
  attachModeration(client,db)
  client.once(Events.ClientReady,() => console.log('Discord bot connected'))
  client.on(Events.Error,error => console.error('Discord client error:',error.name))
  client.login(token).catch(error => console.error('Discord login failed:',error.name))
  return client
}


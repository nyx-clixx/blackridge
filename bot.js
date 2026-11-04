import { AuditLogEvent as A, Client, Events, GatewayIntentBits as I, PermissionFlagsBits as P } from 'discord.js'
import { attachModeration, temporaryBan } from './moderation.js'
import { attachVerification } from './verification.js'
import { createHash } from 'node:crypto'
import { hasQuarantineOverwrite, sendModuleLog, setQuarantineOverwrite } from './recovery.js'
import { guildPlan, matchesPermit, premiumFilters, premiumGuards } from './store.js'
import { logCard, messageCard, safeText } from './messages.js'
import { onDomainList, startDomainFeeds } from './domain-feeds.js'

export const requiredPermissions = P.ViewAuditLog | P.ManageRoles | P.KickMembers | P.ModerateMembers | P.BanMembers | P.ManageChannels | P.ViewChannel | P.SendMessages | P.ManageMessages | P.ManageGuild | P.ReadMessageHistory | P.EmbedLinks | P.AttachFiles
const dangerous = P.Administrator | P.ManageGuild | P.ManageRoles | P.ManageChannels | P.BanMembers | P.KickMembers | P.ManageWebhooks | P.ModerateMembers
const tracked = new Set([A.ChannelDelete,A.RoleDelete,A.MemberBanAdd,A.MemberKick,A.BotAdd])
const rateByAction = new Map([
  [A.MemberKick,'moderation'], [A.MemberBanAdd,'moderation'],
  [A.RoleCreate,'roleCreate'], [A.RoleDelete,'roleDelete'],
  [A.ChannelCreate,'channelCreate'], [A.ChannelDelete,'channelDelete'],
  [A.WebhookCreate,'webhookCreate']
])
const flags = value => typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : 0n
const watchedPermissions = ['Administrator','KickMembers','BanMembers','ManageGuild','ManageRoles','ManageChannels','ManageWebhooks','MentionEveryone']
const permissionMask = rule => (rule.permissions ?? watchedPermissions).reduce((bits,key) => bits | P[key],0n)
const responsePriority = ['log','strip','quarantine','kick','tempban','ban']
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
  const malicious = entries(cfg.maliciousDomains)
  const hosts = urls.map(url => URL.parse(url)?.hostname.toLowerCase().replace(/\.$/,'')).filter(Boolean)
  const blocked = (kind,list) => hosts.filter(host => onDomainList(kind,host) ||
    list.some(domain => host === domain || host.endsWith('.' + domain))).length
  return {
    mentions:message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 10 : 0),
    files:message.attachments.size,
    images:message.attachments.filter(file => file.contentType?.startsWith('image/')).size,
    stickers:message.stickers.size,
    invites:Number(invitePattern.test(body)),
    links:urls.length,
    badWords:entries(cfg.badWords).filter(word => text.includes(word)).length,
    scam:Number(urls.length > 0 && /\b(?:free nitro|claim your nitro|verify your wallet|steam gift)\b/i.test(body)),
    nsfw:blocked('nsfw',domains),
    malicious:blocked('malicious',malicious),
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
  const longAudits = new Map()
  const onboarding = new Map()
  const joins = new Map()
  const messages = new Map()
  const repeats = new Map()
  const checkpointJoins = new Map()
  const recentAccounts = new Map()
  const raids = new Map()
  const seen = new Map()
  const responses = new Map()
  const quarantineChanges = new Set()
  const bypasses = (guild,kind) => {
    const config = db.config(guild.id,'permits')
    return config.enabled ? config.entries.filter(permit => permit.bypasses.includes(kind)) : []
  }
  const bypass = (guild,kind,id,member) => bypasses(guild,kind).some(permit => matchesPermit(permit,id,guild.id,member?.roles.cache))
  const cleanup = setInterval(() => {
    const now = Date.now()
    for (const history of [audits,joins,messages]) for (const [key,hits] of history) if (hits.at(-1) <= now-120000) history.delete(key)
    for (const [key,hits] of longAudits) if (hits.at(-1) <= now-3600000) longAudits.delete(key)
    for (const [key,cached] of onboarding) if (cached.until <= now) onboarding.delete(key)
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
      await channel.send(logCard(kind,detail,roles))
    })
  }
  const enforce = async (member,kind,cfg) => {
    const reason = 'Blackridge ' + kind + ' threshold reached'
    const action = cfg.action
    const notify = (title,icon) => {
      void member.user?.send?.(messageCard(title,'**Server** '+safeText(member.guild.name)+'\n**Reason** '+safeText(reason),{icon,tone:'warning'})).catch(() => {})
    }
    if (action === 'kick' && member.kickable) await member.kick(reason)
    else if (action === 'ban' && member.bannable) await member.ban({reason})
    else if (action === 'tempban' && member.bannable) await temporaryBan(member,cfg.tempBanMinutes,db,reason)
    else if (action === 'quarantine' && kind === 'nuke') {
      await isolate(member,cfg,reason)
      return
    } else if (['timeout','quarantine'].includes(action) && member.moderatable) {
      const minutes = action === 'timeout' ? cfg.timeoutMinutes : cfg.quarantineMinutes
      const until = Math.max(Date.now()+minutes*60000,member.communicationDisabledUntilTimestamp ?? 0)
      await member.disableCommunicationUntil(until,reason)
      notify('Server Timeout','timer')
      log(member.guild,kind,'Timed out ' + member.id + ' for ' + minutes + ' minute(s) or longer')
      return
    } else {
      log(member.guild,kind,'Response blocked by Discord permissions or role hierarchy for ' + member.id)
      return
    }
    db.recordModeration(member.guild.id,member.id,action,reason)
    notify(({kick:'Server Kick',ban:'Server Ban',tempban:'Temporary Ban'})[action],action === 'tempban' ? 'timer' : 'hammer')
    log(member.guild,kind,action + ' completed for ' + member.id)
  }
  async function isolate(member,cfg,reason,kind = 'nuke') {
    const guild = member.guild
    const key = guild.id + ':' + member.id
    const journalKey = 'quarantine:' + member.id
    if (quarantineChanges.has(key)) return
    quarantineChanges.add(key)
    try {
      const previous = db.recovery(guild.id,journalKey)
      const roleId = previous?.role ?? db.recovery(guild.id,'quarantineRole')?.role
      const role = roleId && guild.roles.cache.get(roleId)
      const held = member.roles.cache.filter(item => item.id !== guild.id && item.id !== roleId)
      const channels = guild.channels.cache.filter(channel => channel.permissionOverwrites)
      const hasChannelBypass = channels.some(channel => {
        const memberOverride = channel.permissionOverwrites.cache.get(member.id)
        return memberOverride?.allow.has(P.ViewChannel,false)
      })
      if (!member.manageable || !role?.editable || role.permissions.bitfield !== 0n ||
          held.some(item => !item.editable) || hasChannelBypass ||
          guild.roles.everyone.permissions.has(P.Administrator,false) ||
          channels.some(channel => !hasQuarantineOverwrite(channel,role))) {
        log(guild,kind,'Response blocked for ' + member.id + ' · quarantine role, channel overrides, or role hierarchy need attention')
        return
      }
      const originals = {...previous?.originals}
      for (const item of held.values()) originals[item.id] ??= String(item.permissions.bitfield)
      const until = Math.max(Date.now()+cfg.quarantineMinutes*60000,member.communicationDisabledUntilTimestamp ?? 0)
      db.saveRecovery(guild.id,journalKey,{role:role.id,originals,removeRole:previous?.removeRole ?? !member.roles.cache.has(role.id)})
      db.quarantineMember(guild.id,member.id,role.id,until)
      await member.roles.add(role,reason)
      for (const item of held.values()) await member.roles.remove(item,reason)
      log(guild,kind,'Quarantined ' + member.id + ' · removed ' + held.size + ' role(s)')
      const isolated = await guild.members.fetch({user:member.id,force:true})
      if (isolated.moderatable) await isolated.disableCommunicationUntil(until,reason)
    } finally { quarantineChanges.delete(key) }
  }
  const escalate = async (message,cfg,points) => {
    if (!message.member || !points) return false
    const rule = db.escalation(message.guild.id,message.author.id,message.id,points,cfg.pointRules)
    if (!rule) return false
    log(message.guild,'automod','Point escalation: ' + rule.action + ' for ' + message.author.id + ' · ' + rule.points + ' points in ' + rule.hours + ' hours')
    await enforce(message.member,'automod',{...cfg,action:rule.action})
    return true
  }
  client.on(Events.MessageCreate,message => {
    if (!message.inGuild() || !message.member || message.author.bot || message.webhookId || message.member.permissions.has(P.ManageMessages)) return
    const guild = message.guild
    void run(guild,'automod',async () => {
      const cfg = db.config(guild.id,'automod')
      if (!cfg.enabled) return
      if (bypass(guild,'automod',message.author.id,message.member)) return
      const key = guild.id + ':' + message.author.id
      const now = Date.now()
      if (cfg.filters && Object.values(cfg.filters).some(rule => rule.action !== 'off')) {
        const signals = messageSignals(message,repeats,now,cfg.window*1000,cfg)
        const severity = {log:0,delete:1,timeout:2}
        const matches = Object.entries(cfg.filters).filter(([name,rule]) => rule.action !== 'off' &&
          (guildPlan(message.guild.id) !== 'free' || !premiumFilters.includes(name)) && signals[name] >= rule.limit)
        if (matches.length) {
          const [,rule] = matches.reduce((a,b) => severity[b[1].action] > severity[a[1].action] ? b : a)
          log(guild,'automod','Matched ' + matches.map(([name]) => name).join(', ') + ' · member ' + message.author.id)
          const escalated = await escalate(message,cfg,matches.reduce((total,[,match]) => total+(match.points ?? 0),0))
          if (rule.action === 'delete') {
            if (message.deletable) await message.delete()
            else log(guild,'automod','Message deletion blocked by Discord permissions')
          }
          if (!escalated && rule.action === 'timeout') await enforce(message.member,'automod',{...cfg,action:'timeout'})
          return
        }
      }
      if (recordHit(messages,key,now,cfg.window*1000,cfg.threshold) < cfg.threshold) return
      messages.delete(key)
      log(guild,'automod','Message rate exceeded by ' + message.author.id)
      if (!await escalate(message,cfg,cfg.spamPoints) && cfg.action !== 'log') await enforce(message.member,'automod',cfg)
    })
  })
  client.on(Events.ChannelCreate,channel => {
    if (!channel.guild || !channel.permissionOverwrites) return
    const id = db.recovery(channel.guild.id,'quarantineRole')?.role
    const role = id && channel.guild.roles.cache.get(id)
    if (role?.editable && role.permissions.bitfield === 0n) {
      void run(channel.guild,'nuke',() => setQuarantineOverwrite(channel,role))
    }
  })
  client.on(Events.MessageDelete,message => {
    if (!message.inGuild() || message.partial || message.author?.bot || message.webhookId) return
    const guild = message.guild
    void run(guild,'automod',async () => {
      const cfg = db.config(guild.id,'automod')
      const rule = cfg.filters?.ghost
      if (guildPlan(message.guild.id) === 'free') return
      if (!cfg.enabled || !['log','timeout'].includes(rule?.action)) return
      const member = message.member ?? guild.members.cache.get(message.author.id)
      if (bypass(guild,'automod',message.author.id,member)) return
      const count = message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 10 : 0)
      if (count >= rule.limit) {
        log(guild,'automod','Deleted message with mentions · author ' + message.author.id)
        if (!await escalate(message,cfg,rule.points) && rule.action === 'timeout' && member)
          await enforce(member,'automod',{...cfg,action:'timeout'})
      }
    })
  })
  async function publicRole(guild,id,rule) {
    if (id === guild.id || rule.roles?.includes(id)) return true
    if (rule.onboarding === false) return false
    let cached = onboarding.get(guild.id)
    if (!cached || cached.until <= Date.now()) {
      const pending = guild.fetchOnboarding().then(data => new Set(data.enabled
        ? [...data.prompts.values()].flatMap(prompt => [...prompt.options.values()].flatMap(option => [...option.roles.keys()]))
        : [])).catch(error => {
        if (error.status === 404) return new Set()
        log(guild,'nuke','Could not read Discord Onboarding roles')
        return new Set()
      })
      cached = {until:Date.now()+30000,pending}
      onboarding.set(guild.id,cached)
    }
    return (await cached.pending).has(id)
  }
  async function guardHits(entry,guild,cfg,actor) {
    const hits = []
    const guards = cfg.guards ?? {}
    const changed = key => entry.changes.find(change => change.key === key)
    const addedBits = key => flags(changed(key)?.new) & ~flags(changed(key)?.old)
    const hit = (key,undo) => {
      if (guards[key]?.enabled && (guildPlan(guild.id) !== 'free' || !premiumGuards.includes(key))) hits.push({key,rule:guards[key],undo})
    }
    if (entry.action === A.GuildUpdate && (guards.identity?.identity ?? ['icon_hash','name','vanity_url_code']).some(changed)) hit('identity')
    if (entry.action === A.BotAdd) hit('botAdd')
    if (entry.action === A.EmojiDelete) hit('emojiDelete')
    if (entry.action === A.StickerDelete) hit('stickerDelete')
    if (entry.action === A.SoundboardSoundDelete) hit('soundboardDelete')
    const rename = entry.action === A.ChannelUpdate ? 'channelRename' : entry.action === A.RoleUpdate ? 'roleRename' : null
    if (rename && guards[rename]?.enabled) {
      const channel = rename === 'channelRename'
      const targets = channel ? guards[rename].channels : guards[rename].roles
      const name = changed('name')
      if (targets?.includes(entry.targetId) && typeof name?.old === 'string' && typeof name.new === 'string' && name.old !== name.new) {
        hit(rename,async () => {
          const manager = channel ? guild.channels : guild.roles
          const target = await manager.fetch(entry.targetId,{force:true})
          if (target?.name === name.new) await target.setName(name.old,'Blackridge protected name')
        })
      }
    }
    if (entry.action === A.MemberRoleUpdate && (guards.gate?.enabled || guards.assignments?.enabled)) {
      const added = changed('$add')?.new
      if (Array.isArray(added) && added.length) {
        const gates = (guards.gate?.gates ?? []).filter(gate => added.some(role => role.id === gate.role))
        if (guards.gate?.enabled && gates.length) {
          const grantor = await guild.members.fetch({user:actor,force:true})
          const unauthorized = gates.filter(gate => !gate.required.some(id => id !== guild.id && id !== gate.role &&
            grantor.roles.cache.has(id) && (actor !== entry.targetId || !added.some(role => role.id === id))))
          if (unauthorized.length) hit('gate',async () => {
            const target = await guild.members.fetch({user:entry.targetId,force:true})
            for (const id of new Set(unauthorized.map(gate => gate.role))) {
              if (target.roles.cache.has(id)) await target.roles.remove(id,'Blackridge Role Gate')
            }
          })
        }
        if (guards.assignments?.enabled && added.some(({id}) =>
          (guild.roles.cache.get(id)?.permissions.bitfield ?? 0n) & permissionMask(guards.assignments))) hit('assignments')
      }
    }
    if (entry.action === A.RoleUpdate || entry.action === A.RoleCreate) {
      const bits = addedBits('permissions')
      if (entry.action === A.RoleUpdate && guards.rolePermissions?.enabled && (bits & permissionMask(guards.rolePermissions))) hit('rolePermissions')
      const rule = guards.publicRoles
      if (rule?.enabled && (bits & permissionMask(rule)) && await publicRole(guild,entry.targetId,rule)) hit('publicRoles',async () => {
        const role = await guild.roles.fetch(entry.targetId,{force:true})
        if (!role || (!role.editable && role.id !== guild.id)) throw new Error('Role is not manageable')
        await role.setPermissions(role.permissions.bitfield & ~(bits & permissionMask(rule)),'Blackridge Public Role Permissions')
      })
    }
    if ([A.ChannelOverwriteCreate,A.ChannelOverwriteUpdate].includes(entry.action)) {
      const rule = guards.publicRoles
      const roleId = entry.extra?.id
      const bits = rule?.enabled ? addedBits('allow') & permissionMask(rule) : 0n
      if (bits && roleId && (roleId === guild.id || guild.roles.cache.has(roleId)) && await publicRole(guild,roleId,rule)) hit('publicRoles',async () => {
        const channel = await guild.channels.fetch(entry.targetId,{force:true})
        const overwrite = channel?.permissionOverwrites?.cache.get(roleId)
        if (!overwrite) return
        const restore = Object.fromEntries(watchedPermissions.filter(key => bits & P[key] & overwrite.allow.bitfield)
          .map(key => [key,flags(changed('deny')?.old) & P[key] ? false : null]))
        if (Object.keys(restore).length) await channel.permissionOverwrites.edit(roleId,restore,{reason:'Blackridge Public Role Permissions'})
      })
    }
    return hits
  }
  client.on(Events.GuildAuditLogEntryCreate,(entry,guild) => void run(guild,'nuke',async () => {
    const cfg = db.config(guild.id,'nuke')
    const actor = entry.executorId
    const now = Date.now()
    const category = rateByAction.get(entry.action)
    const rate = cfg.rates?.[category]
    const policy = rate ?? cfg
    if (!cfg.enabled || !actor || actor === guild.ownerId || actor === client.user.id ||
        cfg.trusted.split(',').some(id => id.trim() === actor) || seen.has(entry.id) ||
        now - entry.createdTimestamp > 120000) return
    if (bypass(guild,'nuke',actor,null)) return
    seen.set(entry.id,now+120000)
    const key = guild.id + ':' + actor
    const bucket = rate ? key + ':' + category : key
    let rateHit
    if (policy.enabled && (rate || isDestructive(entry,guild))) {
      if (rate && rate.minute !== undefined) {
        const minute = rate.minute && recordHit(longAudits,bucket + ':minute',now,60000,rate.minute)
        const hour = rate.hour && recordHit(longAudits,bucket + ':hour',now,3600000,rate.hour)
        if ((minute && minute === rate.minute) || (hour && hour === rate.hour)) rateHit = {key:category,rule:rate}
      } else if (now - entry.createdTimestamp <= policy.window*1000) {
        const count = recordHit(audits,bucket,now,policy.window*1000,policy.threshold)
        if (count >= policy.threshold) {
          audits.delete(bucket)
          rateHit = {key:category ?? 'general',rule:policy,count}
        }
      }
    }
    const hits = Object.values(cfg.guards ?? {}).some(rule => rule.enabled) ? await guardHits(entry,guild,cfg,actor) : []
    if (rateHit) hits.push(rateHit)
    if (!hits.length) return
    const detail = A[entry.action] + ' by ' + actor + ' · ' + (rateHit?.count ? rateHit.count + ' tracked actions · ' : '') + hits.map(hit => hit.key).join(', ')
    const previous = responses.get(key)
    let release
    const response = new Promise(resolve => { release = resolve })
    responses.set(key,response)
    try {
      if (previous) await previous
      const needsMember = hits.some(({rule}) => (rule.action ?? cfg.action) !== 'log' || rule.escalateAfter) ||
        bypasses(guild,'nuke').some(permit => permit.roles.length)
      const member = needsMember ? await guild.members.fetch({user:actor,force:true}) : null
      const current = db.config(guild.id,'nuke')
      if (!current.enabled || current.action !== cfg.action || JSON.stringify(current.guards) !== JSON.stringify(cfg.guards) ||
          JSON.stringify(current.rates) !== JSON.stringify(cfg.rates) || current.trusted.split(',').some(id => id.trim() === actor) ||
          bypass(guild,'nuke',actor,member)) return
      let action = 'log'
      for (const hit of hits) {
        const rule = hit.rule
        const count = rule.escalateAfter ? db.nukeDetection(guild.id,actor,hit.key,entry.id,now) : 0
        const response = count && count >= rule.escalateAfter ? rule.escalateTo ?? 'ban' : rule.action ?? cfg.action
        if (responsePriority.indexOf(response) > responsePriority.indexOf(action)) action = response
        if (response !== 'log' && hit.undo) {
          try { await hit.undo() } catch { log(guild,'nuke','Could not reverse ' + hit.key + ' for ' + actor) }
        }
      }
      log(guild,'nuke',detail + ' · threshold reached')
      alert(guild,'nuke',cfg,'Blackridge Anti-Nuke: ' + detail)
      if (action === 'log') return
      if (action !== 'strip') {
        await enforce(member,'nuke',{...current,action})
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
    } finally {
      release()
      if (responses.get(key) === response) responses.delete(key)
    }
  }))
  client.on(Events.GuildAuditLogEntryCreate,(entry,guild) => {
    if (entry.action !== A.BotAdd || !entry.executorId || !entry.targetId ||
        entry.executorId === client.user.id || entry.targetId === client.user.id) return
    void run(guild,'checkpoint',async () => {
      const cfg = db.config(guild.id,'checkpoint')
      if (!cfg.enabled || ![cfg.verifiedBot,cfg.unverifiedBot].some(rule => rule && rule.action !== 'off')) return
      const key = 'checkpoint:' + entry.id
      const now = Date.now()
      if (seen.has(key) || now-entry.createdTimestamp > 120000) return
      seen.set(key,now+120000)
      const inviter = await guild.members.fetch({user:entry.executorId,force:true})
      if (bypass(guild,'checkpoint',inviter.id,inviter)) return
      const target = await guild.members.fetch({user:entry.targetId,force:true})
      if (!target.user.bot) return
      const flags = await target.user.fetchFlags(true)
      const verified = flags.has('VerifiedBot')
      const current = db.config(guild.id,'checkpoint')
      const rule = verified ? current.verifiedBot : current.unverifiedBot
      if (!current.enabled || !rule || rule.action === 'off' || bypass(guild,'checkpoint',inviter.id,inviter)) return
      const detail = 'Checkpoint detected a ' + (verified ? 'verified' : 'non-verified') + ' bot added by ' + inviter.id
      log(guild,'checkpoint',detail)
      alert(guild,'checkpoint',current,detail)
      await enforce(target,'checkpoint',{...current,action:rule.action})
      if (rule.quarantine && inviter.id !== guild.ownerId) {
        await isolate(inviter,current,'Blackridge Checkpoint bot addition','checkpoint')
      }
    })
  })
  client.on(Events.GuildMemberAdd,member => void run(member.guild,'raid',async () => {
    const guild = member.guild
    const cfg = db.config(guild.id,'raid')
    if (!cfg.enabled || member.user.bot || member.id === guild.ownerId || bypass(guild,'raid',member.id,member)) return
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
    if (!cfg.enabled || bypass(member.guild,'checkpoint',member.id,member)) return
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
  let sweeping = false
  const quarantineSweep = setInterval(async () => {
    if (sweeping || !client.isReady()) return
    sweeping = true
    try {
      for (const row of db.dueQuarantines()) {
        const guild = client.guilds.cache.get(row.guild)
        const key = row.guild + ':' + row.user
        if (!guild?.available || quarantineChanges.has(key)) continue
        quarantineChanges.add(key)
        try {
          const member = await guild.members.fetch({user:row.user,force:true})
          const journalKey = 'quarantine:' + row.user
          const journal = db.recovery(guild.id,journalKey)
          if (journal?.role === row.role) {
            for (const [id,permissions] of Object.entries(journal.originals)) {
              const role = guild.roles.cache.get(id)
              if (member.roles.cache.has(id)) continue
              if (role?.editable && String(role.permissions.bitfield) === permissions) {
                await member.roles.add(role,'Blackridge quarantine expired')
              } else log(guild,'nuke','Skipped restoring role ' + id + ' for ' + row.user)
            }
            if (journal.removeRole && member.roles.cache.has(row.role)) await member.roles.remove(row.role,'Blackridge quarantine expired')
            db.clearRecovery(guild.id,journalKey)
          } else if (!journal && member.roles.cache.has(row.role)) await member.roles.remove(row.role,'Blackridge quarantine expired')
          db.removeQuarantine(row)
        } catch (error) {
          if (error.code === 10007) {
            if (db.recovery(guild.id,'quarantine:' + row.user)?.role === row.role) db.clearRecovery(guild.id,'quarantine:' + row.user)
            db.removeQuarantine(row)
          }
        } finally { quarantineChanges.delete(key) }
      }
    } catch { console.error('Quarantine expiry check failed') }
    finally { sweeping = false }
  },30000)
  quarantineSweep.unref()
  return () => { clearInterval(cleanup); clearInterval(quarantineSweep) }
}

export function createBotClient() {
  const intents = [I.Guilds,I.GuildModeration,I.GuildMembers,I.GuildMessages]
  if (process.env.ENABLE_MESSAGE_CONTENT === 'true') intents.push(I.MessageContent)
  return new Client({intents})
}
export function mountBot(client,db,ownsGuild,allowInactiveReviews=false) {
  const view = new Proxy(client,{
    get(target,property) {
      if (property === 'guilds') return {cache:target.guilds.cache.filter(guild => ownsGuild(guild.id))}
      if (property === 'on' || property === 'once') return (event,handler) => target[property](event,(...args) => {
        const first = args[0]
        const id = event === Events.GuildAuditLogEntryCreate ? args[1]?.id
          : event === Events.GuildCreate ? first?.id : first?.guildId ?? first?.guild?.id
        const oldReview = allowInactiveReviews && event === Events.InteractionCreate && first?.customId?.startsWith('blackridge-review:')
        if (!id || ownsGuild(id) || oldReview) handler(...args)
      })
      const value = Reflect.get(target,property,target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  const cleanup = [attachProtection(view,db),attachModeration(view,db,id => client.guilds.cache.get(id)),attachVerification(view,db)]
  return () => cleanup.forEach(stop => stop())
}
export function startBot(token,db,ownsGuild = () => true) {
  startDomainFeeds()
  const client = createBotClient()
  const cleanup = mountBot(client,db,ownsGuild,true)
  const destroy = client.destroy.bind(client)
  client.destroy = () => { cleanup(); return destroy() }
  client.once(Events.ClientReady,() => console.log('Discord bot connected'))
  client.on(Events.Error,error => console.error('Discord client error:',error.name))
  client.login(token).catch(error => console.error('Discord login failed:',error.name))
  return client
}

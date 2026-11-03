import { AuditLogEvent as A, Client, Events, GatewayIntentBits as I, PermissionFlagsBits as P } from 'discord.js'

export const requiredPermissions = P.ViewAuditLog | P.ManageRoles | P.KickMembers | P.ModerateMembers
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
  const raids = new Map()
  const seen = new Map()
  const responses = new Set()
  const cleanup = setInterval(() => {
    const now = Date.now()
    for (const history of [audits,joins]) for (const [key,hits] of history) if (hits.at(-1) <= now-120000) history.delete(key)
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
    if (cfg.action === 'log') return
    responses.add(key)
    try {
      const member = await guild.members.fetch({user:actor,force:true})
      const current = db.config(guild.id,'nuke')
      if (!current.enabled || current.action !== cfg.action || current.trusted.split(',').some(id => id.trim() === actor)) {
        log(guild,'nuke','Response skipped after a policy change for ' + actor)
        return
      }
      if (cfg.action === 'kick') {
        if (!member.kickable) { log(guild,'nuke','Kick blocked by Discord permissions or role hierarchy for ' + actor); return }
        await member.kick('Blackridge Anti-Nuke threshold reached')
        log(guild,'nuke','Kicked ' + actor)
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
      if (cfg.alertChannel) {
        const roles = [...new Set(cfg.alertRoles)].filter(id => id !== guild.id && guild.roles.cache.has(id))
        void run(guild,'raid',async () => {
          const channel = await guild.channels.fetch(cfg.alertChannel)
          if (!channel?.isSendable() || channel.guildId !== guild.id) throw new Error('Invalid raid alert channel')
          await channel.send({
            content: ['Blackridge raid detected: ' + detail, ...roles.map(id => '<@&' + id + '>')].join(' '),
            allowedMentions:{parse:[],roles}
          })
        })
      }
    }
    if (cfg.age && now - member.user.createdTimestamp > cfg.age*86400000) return
    if (cfg.action === 'log') { log(guild,'raid','Flagged join from ' + member.id); return }
    if (cfg.action === 'kick' && member.kickable) {
      await member.kick('Blackridge Anti-Raid protection active')
      log(guild,'raid','Kicked ' + member.id)
    } else if (cfg.action === 'timeout' && member.moderatable) {
      await member.timeout(cfg.timeoutMinutes*60000,'Blackridge Anti-Raid protection active')
      log(guild,'raid','Timed out ' + member.id + ' for ' + cfg.timeoutMinutes + ' minute(s)')
    } else log(guild,'raid','Response blocked by Discord permissions or role hierarchy for ' + member.id)
  }))
  return () => clearInterval(cleanup)
}

export function startBot(token,db) {
  const client = new Client({intents:[I.Guilds,I.GuildModeration,I.GuildMembers]})
  attachProtection(client,db)
  client.once(Events.ClientReady,() => console.log('Discord bot connected'))
  client.on(Events.Error,error => console.error('Discord client error:',error.name))
  client.login(token).catch(error => console.error('Discord login failed:',error.name))
  return client
}


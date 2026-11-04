import { ChannelType as C, PermissionFlagsBits as P, Routes } from 'discord.js'
import { z } from 'zod'

const snowflake = z.string().regex(/^\d{17,20}$/)
const lockdownInput = z.strictObject({
  confirm:z.literal('ENABLE LOCKDOWN'), all:z.boolean(), channels:z.array(snowflake).max(500),
  verification:z.boolean(), invites:z.boolean(), dms:z.boolean()
})
const textTypes = new Set([C.GuildText,C.GuildAnnouncement,C.GuildForum,C.GuildMedia])
const voiceTypes = new Set([C.GuildVoice,C.GuildStageVoice])
const restorableTypes = new Set([...textTypes,...voiceTypes,C.GuildCategory])
const textBits = ['SendMessages','AddReactions','CreatePublicThreads','CreatePrivateThreads','SendMessagesInThreads']
const quarantineBits = Object.fromEntries([...textBits,'Speak'].map(key => [key,false]))
export function setQuarantineOverwrite(channel,role) {
  return channel.permissionOverwrites.edit(role,quarantineBits,{reason:'Blackridge quarantine role'})
}
const invalid = message => Object.assign(new Error(message),{status:400})
const incidentPath = guild => '/guilds/' + guild.id + '/incident-actions'
const guildRaw = guild => guild.client.rest.get(Routes.guild(guild.id))
const timestamp = value => value ? new Date(value).toISOString() : null

export async function sendModuleLog(guild,db,kind,detail) {
  const id = db.config(guild.id,kind).alertChannel
  if (!id) return
  try {
    const channel = await guild.channels.fetch(id)
    if (channel?.isSendable() && channel.guildId === guild.id) await channel.send({content:detail.slice(0,1800),allowedMentions:{parse:[]}})
  } catch { console.error('Discord module log delivery failed:',kind) }
}

export function recoveryTools(db,bot) {
  const busy = new Set()
  const run = async (guild,operation) => {
    if (busy.has(guild.id)) throw invalid('Another recovery operation is running.')
    busy.add(guild.id)
    try { return await operation() } finally { busy.delete(guild.id) }
  }
  const record = (guild,kind,actor,detail) => {
    const line = detail + ' · initiated by ' + actor
    db.event(guild.id,kind,line)
    void sendModuleLog(guild,db,kind,line)
  }
  const scope = async guild => {
    const [channels,roles] = await Promise.all([guild.channels.fetch(),guild.roles.fetch()])
    return {channels,roles}
  }
  async function enable(guild,actor,input) {
    const parsed = lockdownInput.safeParse(input)
    if (!parsed.success) throw invalid('Confirm lockdown and select valid controls.')
    const cfg = parsed.data
    if (db.recovery(guild.id,'lockdown')) throw invalid('Lift the existing lockdown first.')
    const channels = await guild.channels.fetch()
    const raw = await guildRaw(guild)
    const steps = []
    const notices = []
    const selected = cfg.all ? [...channels.keys()] : [...new Set(cfg.channels)]
    for (const id of selected) {
      const channel = channels.get(id)
      if (!channel || (!textTypes.has(channel.type) && !voiceTypes.has(channel.type))) continue
      const keys = [...(textTypes.has(channel.type) || channel.type === C.GuildVoice ? textBits : []),...(voiceTypes.has(channel.type) ? ['Speak'] : [])]
      const overwrite = channel.permissionOverwrites.cache.get(guild.id)
      const before = Object.fromEntries(keys.filter(key => !overwrite?.deny.has(P[key],false)).map(key => [key,overwrite?.allow.has(P[key],false) ? true : null]))
      if (Object.keys(before).length) steps.push({kind:'channel',id,before})
    }
    if (cfg.verification && raw.verification_level < 4) steps.push({kind:'verification',before:raw.verification_level,applied:4})
    for (const [option,key] of [['invites','invites_disabled_until'],['dms','dms_disabled_until']]) {
      if (!cfg[option]) continue
      if (!Object.hasOwn(raw,'incidents_data')) { notices.push(option + ' could not be safely snapshotted for this server.'); continue }
      const before = timestamp(raw.incidents_data?.[key])
      if (!before || Date.parse(before) < Date.now()+3600000) steps.push({kind:'incident',key,before,applied:new Date(Date.now()+3600000).toISOString()})
    }
    if (!steps.length) throw invalid(notices.join(' ') || 'No eligible settings to change.')
    const journal = {at:Date.now(),steps:[],notices}
    db.saveRecovery(guild.id,'lockdown',journal)
    record(guild,'lockdown',actor,'Lockdown started')
    for (const step of steps) {
      journal.steps.push(step)
      db.saveRecovery(guild.id,'lockdown',journal)
      try {
        if (step.kind === 'channel') await channels.get(step.id).permissionOverwrites.edit(guild.id,Object.fromEntries(Object.keys(step.before).map(key => [key,false])),{reason:'Blackridge lockdown'})
        if (step.kind === 'verification') await guild.setVerificationLevel(step.applied,'Blackridge lockdown')
        if (step.kind === 'incident') await guild.client.rest.put(incidentPath(guild),{body:{[step.key]:step.applied}})
        record(guild,'lockdown',actor,'Applied ' + step.kind + ' ' + (step.id ?? step.key ?? ''))
      } catch {
        journal.notices.push('Could not confirm ' + step.kind + ' ' + (step.id ?? step.key ?? '') + '.')
        record(guild,'lockdown',actor,'Could not confirm ' + step.kind + ' ' + (step.id ?? step.key ?? ''))
      }
      db.saveRecovery(guild.id,'lockdown',journal)
    }
    return journal.notices
  }
  async function lift(guild,actor) {
    const journal = db.recovery(guild.id,'lockdown')
    if (!journal) throw invalid('No recorded lockdown.')
    const {channels,roles} = await scope(guild)
    const raw = await guildRaw(guild)
    const failures = []
    for (const step of [...journal.steps].reverse()) {
      try {
        if (step.kind === 'channel') {
          const channel = channels.get(step.id)
          const current = channel?.permissionOverwrites.cache.get(guild.id)
          const restore = Object.fromEntries(Object.entries(step.before).filter(([key]) => current?.deny.has(P[key],false)))
          if (Object.keys(restore).length) await channel.permissionOverwrites.edit(guild.id,restore,{reason:'Blackridge lockdown lifted'})
        }
        if (step.kind === 'role') {
          const role = roles.get(step.id)
          if (role && (role.permissions.bitfield & BigInt(step.before)) !== BigInt(step.before)) {
            if (!role.editable) throw new Error('Role hierarchy changed')
            await role.setPermissions(role.permissions.bitfield | BigInt(step.before),'Blackridge lockdown lifted')
          }
        }
        if (step.kind === 'verification' && raw.verification_level === step.applied) await guild.setVerificationLevel(step.before,'Blackridge lockdown lifted')
        if (step.kind === 'incident' && !Object.hasOwn(raw,'incidents_data')) throw new Error('Incident state unavailable')
        if (step.kind === 'incident' && timestamp(raw.incidents_data?.[step.key]) === step.applied) {
          await guild.client.rest.put(incidentPath(guild),{body:{[step.key]:Date.parse(step.before)>Date.now() ? step.before : null}})
        }
        journal.steps.splice(journal.steps.indexOf(step),1)
        db.saveRecovery(guild.id,'lockdown',journal)
        record(guild,'lockdown',actor,'Processed recovery for ' + step.kind + ' ' + (step.id ?? step.key ?? ''))
      } catch {
        failures.push(step.kind + ' ' + (step.id ?? step.key ?? '') + ' still needs recovery.')
        record(guild,'lockdown',actor,'Recovery failed for ' + step.kind + ' ' + (step.id ?? step.key ?? ''))
      }
    }
    if (!journal.steps.length) db.clearRecovery(guild.id,'lockdown')
    record(guild,'lockdown',actor,failures.length ? 'Lockdown recovery incomplete' : 'Lockdown lifted')
    return failures
  }
  async function backup(guild,actor) {
    const {channels,roles} = await scope(guild)
    const raw = await guildRaw(guild)
    db.saveBackup(guild.id,{
      settings:{name:raw.name,verificationLevel:raw.verification_level,defaultMessageNotifications:raw.default_message_notifications,explicitContentFilter:raw.explicit_content_filter},
      roles:roles.map(role => ({id:role.id,name:role.name,color:role.color,permissions:String(role.permissions.bitfield),position:role.rawPosition,managed:role.managed})),
      channels:channels.filter(channel => restorableTypes.has(channel.type)).map(channel => ({
        id:channel.id,name:channel.name,type:channel.type,parent:channel.parentId,position:channel.rawPosition,
        overwrites:channel.permissionOverwrites.cache.map(entry => ({id:entry.id,type:entry.type,allow:String(entry.allow.bitfield),deny:String(entry.deny.bitfield)}))
      }))
    })
    record(guild,'backup',actor,'Backup saved')
  }
  async function quarantine(guild,actor,id) {
    if (id !== '' && !snowflake.safeParse(id).success) throw invalid('Select a valid quarantine role.')
    const {channels,roles} = await scope(guild)
    const role = id ? roles.get(id) : await guild.roles.create({name:'Blackridge Quarantine',permissions:0n,reason:'Blackridge quarantine setup'})
    if (!role?.editable || role.id === guild.id || role.permissions.bitfield !== 0n) throw invalid('Use a manageable role with no server permissions.')
    const targets = channels.filter(channel => channel?.permissionOverwrites)
    if (targets.some(channel => channel.permissionOverwrites.cache.get(role.id)?.allow.bitfield)) {
      throw invalid('The quarantine role must have no channel permission grants.')
    }
    const notices = []
    db.saveRecovery(guild.id,'quarantineSetup',{role:role.id})
    for (const channel of targets.values()) {
      try { await setQuarantineOverwrite(channel,role) }
      catch { notices.push('Could not configure #' + channel.name) }
    }
    if (!notices.length) db.saveRecovery(guild.id,'quarantineRole',{role:role.id})
    record(guild,'nuke',actor,notices.length ? 'Quarantine role setup incomplete' : 'Quarantine role configured')
    return notices
  }
  async function restore(guild,actor,id) {
    const snapshot = db.backup(guild.id,id)
    if (!snapshot) throw invalid('Backup not found.')
    if (db.recovery(guild.id,'lockdown')) throw invalid('Lift lockdown before restoring a backup.')
    const {channels,roles} = await scope(guild)
    const notices = []
    const progress = db.recovery(guild.id,'restore:' + id) ?? {roles:{},channels:{}}
    const persist = () => db.saveRecovery(guild.id,'restore:' + id,progress)
    const resolve = (items,mapping,id) => items.get(mapping[id] || id)
    async function recreate(items,mapping,item,create) {
      if (Object.hasOwn(mapping,item.id)) return null
      // A lost API response must not cause a second object to be created on retry.
      mapping[item.id] = null
      persist()
      const restored = await create()
      mapping[item.id] = restored.id
      items.set(restored.id,restored)
      persist()
      return restored
    }
    record(guild,'backup',actor,'Restore started for backup ' + id)
    for (const item of snapshot.roles) {
      if (item.managed || item.id === guild.id) continue
      const options = {name:item.name,colors:{primaryColor:item.color},permissions:BigInt(item.permissions),reason:'Blackridge backup restore'}
      try {
        const role = resolve(roles,progress.roles,item.id)
        if (role?.editable) await role.edit(options)
        else if (role || !await recreate(roles,progress.roles,item,() => guild.roles.create(options))) {
          notices.push('Skipped role ' + item.id + ' due to hierarchy or an unresolved previous recreation.')
        }
      }
      catch { notices.push('Could not restore role ' + item.id) }
    }
    const ordered = [...snapshot.channels].sort((a,b) => Number(b.type === C.GuildCategory)-Number(a.type === C.GuildCategory))
    for (const item of ordered) {
      const channel = resolve(channels,progress.channels,item.id)
      if (channel && (!channel.manageable || channel.type !== item.type)) { notices.push('Skipped unmanageable channel ' + item.id); continue }
      const parent = item.parent === null ? null : resolve(channels,progress.channels,item.parent)
      const overwrites = item.overwrites.filter(entry => entry.type === 0)
      if ((item.parent && parent?.type !== C.GuildCategory) ||
          overwrites.some(entry => entry.id !== guild.id && !resolve(roles,progress.roles,entry.id)) ||
          (!channel && item.overwrites.some(entry => entry.type === 1))) {
        notices.push('Skipped channel ' + item.id + ' because a category or permission dependency needs manual recovery.')
        continue
      }
      const currentMembers = channel?.permissionOverwrites.cache.filter(entry => entry.type === 1)
      const permissionOverwrites = [
        ...overwrites.map(entry => ({id:progress.roles[entry.id] || entry.id,type:entry.type,allow:BigInt(entry.allow),deny:BigInt(entry.deny)})),
        ...(currentMembers?.values() ?? [])
      ]
      try {
        const options = {name:item.name,parent:parent?.id ?? null,permissionOverwrites,reason:'Blackridge backup restore'}
        if (channel) await channel.edit(options)
        else if (!await recreate(channels,progress.channels,item,() => guild.channels.create({...options,type:item.type}))) {
          notices.push('Skipped channel ' + item.id + ' due to an unresolved previous recreation.')
        }
      } catch { notices.push('Could not restore channel ' + item.id) }
    }
    try { await guild.edit({...snapshot.settings,reason:'Blackridge backup restore'}) }
    catch { notices.push('Could not restore server settings') }
    record(guild,'backup',actor,'Restore finished for backup ' + id + ' · ' + notices.length + ' skipped or failed changes')
    return notices
  }
  const tick = async () => {
    for (const {guild:id} of db.scheduledBackups()) {
      const schedule = db.recovery(id,'backupSchedule')
      const guild = bot?.guilds.cache.get(id)
      if (!guild?.available || schedule.next > Date.now() || busy.has(id)) continue
      try {
        await run(guild,async () => {
          await backup(guild,'automatic schedule')
          db.saveRecovery(id,'backupSchedule',{...schedule,next:Date.now()+schedule.hours*3600000})
        })
      } catch { console.error('Scheduled backup failed') }
    }
  }
  const timer = setInterval(() => { void tick().catch(() => console.error('Backup scheduler failed')) },60000)
  timer.unref()
  return {run,scope,enable,lift,backup,restore,quarantine}
}


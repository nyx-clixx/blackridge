import { randomUUID } from 'node:crypto'
import { ApplicationCommandType, AuditLogEvent, ChannelType, Events, MessageFlags, PermissionFlagsBits as P, SlashCommandBuilder } from 'discord.js'
import { commandNames, matchesPermit } from './store.js'
import { sendModuleLog } from './recovery.js'
import { appealMarker, attachAppeals, privateAppealChannel, sendBanNotice } from './appeals.js'
import { actionCard, memberAction, mention, messageCard, safeText, timestamp } from './messages.js'
import { grantVerification } from './verification.js'

const channelCommands = new Set(['lock-channel','unlock-channel'])
const timedCommands = new Set(['timeout','tempban'])
const permissions = {
  ban:P.BanMembers, tempban:P.BanMembers, unban:P.BanMembers, kick:P.KickMembers,
  timeout:P.ModerateMembers, warn:P.ModerateMembers, 'lock-channel':P.ManageChannels, 'unlock-channel':P.ManageChannels,
  purge:P.ManageMessages, history:P.ModerateMembers, info:P.ModerateMembers, 'force-verify':P.ManageRoles, slowmode:P.ManageChannels
}
const commands = commandNames.map(name => {
  const builder = new SlashCommandBuilder().setName(name).setDescription('Blackridge ' + name + ' moderation action')
  if (name === 'force-verify') builder.setDescription('Verify a member without a button or CAPTCHA')
  if (name === 'slowmode') return builder.setDescription('Set slowmode for this channel')
    .addStringOption(option => option.setName('state').setDescription('Turn slowmode on or off').setRequired(true)
      .addChoices({name:'On',value:'on'},{name:'Off',value:'off'}))
    .addIntegerOption(option => option.setName('seconds').setDescription('Seconds between messages when on').setMinValue(1).setMaxValue(21600))
  if (name === 'purge') return builder.setDescription('Delete recent messages in this channel').addIntegerOption(option =>
    option.setName('amount').setDescription('Number of recent messages to delete').setRequired(true).setMinValue(1).setMaxValue(100))
  if (name === 'info') return builder.setDescription('View account and server information for a Discord user')
    .addUserOption(option => option.setName('member').setDescription('Discord user to inspect').setRequired(true))
  if (name === 'history') return builder.setDescription('View recorded warns, kicks, and bans for a user')
    .addUserOption(option => option.setName('member').setDescription('Choose a member'))
    .addStringOption(option => option.setName('user-id').setDescription('Discord ID, including users who left').setMinLength(17).setMaxLength(20))
  if (name === 'unban') {
    builder.addStringOption(option => option.setName('user-id').setDescription('Discord ID of the banned user').setRequired(true).setMinLength(17).setMaxLength(20))
  } else if (!channelCommands.has(name)) {
    builder.addUserOption(option => option.setName('member').setDescription('Server member').setRequired(true))
    if (timedCommands.has(name)) builder.addIntegerOption(option => option.setName('minutes').setDescription('Duration in minutes').setMinValue(1).setMaxValue(1440).setRequired(true))
  }
  if (name === 'ban') builder.addBooleanOption(option => option.setName('appeal').setDescription('Allow the member to appeal this ban'))
  return builder.addStringOption(option => option.setName('reason').setDescription('Reason for the action').setMaxLength(250))
})
const reportCommand = 'Report to Moderators'
const commandSync = new Map()
export function syncModerationCommands(guild,db,forceDisabled = false,{reportsOnly = false} = {}) {
  const previous = commandSync.get(guild.id) ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(async () => {
    const enabled = !forceDisabled && db.config(guild.id,'moderation').enabled
    if (enabled && !reportsOnly) for (const command of commands) await guild.commands.create(command)
    const obsolete = enabled ? ['lock','unlock'] : [...commandNames,'lock','unlock']
    const reportsEnabled = !forceDisabled && db.config(guild.id,'reports').enabled
    const registered = await guild.commands.fetch()
    const report = [...registered.values()].find(command => command.type === ApplicationCommandType.Message && command.name === reportCommand)
    if (reportsEnabled && !report) await guild.commands.create({name:reportCommand,type:ApplicationCommandType.Message})
    if (!reportsEnabled && report) await report.delete()
    if (reportsOnly) return
    for (const command of registered.values()) {
      if (command.type === ApplicationCommandType.ChatInput && obsolete.includes(command.name)) await command.delete()
    }
  }).finally(() => { if (commandSync.get(guild.id) === operation) commandSync.delete(guild.id) })
  commandSync.set(guild.id,operation)
  return operation
}

export function canModerate(actor, ownerId, name, permit, channelPermissions) {
  if (!Object.hasOwn(permissions,name)) return false
  if (actor.id === ownerId) return true
  const delegated = Array.isArray(permit)
    ? permit.some(entry => entry.commands.includes(name) && matchesPermit(entry,actor.id,actor.guild.id,actor.roles.cache))
    : permit.users.includes(actor.id) || actor.roles.cache.some(role => role.id !== actor.guild.id && permit.roles.includes(role.id))
  return Boolean(delegated && actor.permissions.has(permissions[name]) && channelPermissions?.has(permissions[name]))
}

export async function temporaryBan(member, minutes, db, reason) {
  const marker = 'Blackridge temporary ban ' + randomUUID()
  db.tempBan(member.guild.id,member.id,marker,Date.now()+minutes*60000)
  // Keep the record if Discord's response is ambiguous. Expiry checks the actual ban marker.
  await member.ban({reason:marker + ' · ' + reason})
}

export function attachModeration(client,db,lookupGuild) {
  attachAppeals(client,db,lookupGuild)
  const channelChanges = new Set()
  const reports = new Map()
  const reportCooldown = new Map()
  async function reportMessage(message,reporter,method) {
    const guild = message.guild
    if (!guild || reporter.bot || message.author?.id === reporter.id) return 'Choose a message from another member.'
    const config = db.config(guild.id,'reports')
    if (!config.enabled) return 'The Report System is disabled.'
    if (message.channelId === config.channel) return 'Reports cannot be filed from the review channel.'
    const now = Date.now()
    for (const [key,until] of reports) if (until <= now) reports.delete(key)
    for (const [key,until] of reportCooldown) if (until <= now) reportCooldown.delete(key)
    const key = guild.id + ':' + message.id
    const sender = guild.id + ':' + reporter.id
    if (reports.has(key)) return 'This message was recently reported.'
    if (reportCooldown.has(sender) || reports.size >= 5000) return 'Please wait before sending another report.'
    reports.set(key,now+10*60000)
    reportCooldown.set(sender,now+5000)
    try {
      const channel = await privateAppealChannel(guild,config.channel)
      const current = db.config(guild.id,'reports')
      if (!channel || !current.enabled || current.channel !== config.channel) throw new Error('Review channel unavailable')
      const url = 'https://discord.com/channels/' + guild.id + '/' + message.channelId + '/' + message.id
      await channel.send(messageCard('Message Report','[Open the reported message](' + url + ')',{
        icon:'warning',userId:message.author?.id,fields:[
          ['Reported Member',message.author ? mention(message.author.id) : 'Unknown'],
          ['Reported By',mention(reporter.id)],['Source Channel',mention(message.channelId,'channel')],['Method',method]
        ]
      }))
      db.event(guild.id,'reports','Message reported by ' + reporter.id + ' · message ' + message.id)
      return 'Report sent to the server’s moderators.'
    } catch {
      reports.delete(key)
      return 'The report could not be delivered to the review channel.'
    }
  }
  client.on(Events.MessageReactionAdd,async (reaction,user) => {
    const guild = reaction.message.guild
    if (!guild || user.bot) return
    const config = db.config(guild.id,'reports')
    const emoji = config.emoji.match(/:(\d{17,20})>$/)?.[1] ?? config.emoji
    const normalize = value => value?.replace(/\uFE0F/g,'')
    if (!config.enabled || !emoji || normalize(emoji) !== normalize(reaction.emoji.id ?? reaction.emoji.name)) return
    try {
      const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message
      await reportMessage(message,user,'Emoji Reaction')
    } catch { /* The source message may have been deleted. */ }
  })
  client.on(Events.InteractionCreate,async interaction => {
    if (!interaction.isMessageContextMenuCommand?.() || !interaction.inCachedGuild() || interaction.commandName !== reportCommand) return
    try {
      await interaction.deferReply({flags:MessageFlags.Ephemeral})
      const result = await reportMessage(interaction.targetMessage,interaction.user,'Message Menu')
      await interaction.editReply(messageCard('Report Message',result,{icon:'warning'}))
    } catch (error) { console.error('Message report failed:',error.code ?? error.name) }
  })
  client.on(Events.GuildAuditLogEntryCreate,(entry,guild) => {
    if (!db.config(guild.id,'moderation').enabled || !entry.targetId || !entry.executorId) return
    const data = {userId:entry.targetId,actor:entry.executorId,reason:entry.reason,at:entry.createdTimestamp}
    if (entry.action === AuditLogEvent.MemberRoleUpdate) {
      const changes = (entry.changes ?? []).flatMap(change => {
        if (!['$add','$remove'].includes(change.key) || !Array.isArray(change.new)) return []
        const roles = change.new.map(role=>mention(role.id,'role')).join(', ')
        return roles ? [mention(entry.targetId)+(change.key === '$add' ? ' was granted ' : ' lost ')+roles+'.'] : []
      })
      if (changes.length) {
        const {options} = memberAction('warn',data)
        void sendModuleLog(guild,db,'moderation',{title:'Member Roles Updated',body:changes.join('\n'),options:{...options,icon:'user'}})
      }
      return
    }
    if (entry.executorId === client.user.id) return
    if (entry.action === AuditLogEvent.MemberUpdate) {
      const change = entry.changes?.find(change=>change.key === 'communication_disabled_until')
      if (!change) return
      const until = Date.parse(change.new)
      if (Number.isFinite(until)) void sendModuleLog(guild,db,'moderation',memberAction('timeout',{...data,until}))
      else if (change.old && change.new == null) void sendModuleLog(guild,db,'moderation',memberAction('untimeout',data))
      return
    }
    const action = entry.action === AuditLogEvent.MemberKick ? 'kick' : entry.action === AuditLogEvent.MemberBanAdd ? 'ban' : null
    if (!action) return
    try {
      db.recordModeration(guild.id,entry.targetId,action,entry.reason ?? 'No reason supplied',entry.createdTimestamp,entry.id)
      void sendModuleLog(guild,db,'moderation',memberAction(action,data))
    }
    catch (error) { console.error('Could not record Discord moderation history:',error.code ?? error.name) }
  })
  const register = async guild => {
    try { await syncModerationCommands(guild,db) }
    catch (error) { console.error('Command registration failed:',error.code ?? error.name) }
  }
  client.once(Events.ClientReady,async () => {
    for (const guild of client.guilds.cache.values()) await register(guild)
  })
  client.on(Events.GuildCreate,register)
  let expiring = false
  const sweep = setInterval(async () => {
    if (expiring || !client.isReady()) return
    expiring = true
    try {
      for (const row of db.dueBans()) {
        const guild = client.guilds.cache.get(row.guild)
        if (!guild?.available) continue
        try {
          const ban = await guild.bans.fetch({user:row.user,force:true})
          if (ban.reason?.startsWith(row.marker + ' · ')) await guild.bans.remove(row.user,'Blackridge temporary ban expired')
          db.removeTempBan(row.guild,row.user,row.marker)
        } catch (error) {
          if (error.code === 10026) db.removeTempBan(row.guild,row.user,row.marker)
        }
      }
    } catch (error) { console.error('Temporary ban cleanup failed:',error.code ?? error.name) }
    finally { expiring = false }
  },30000).unref()

  client.on(Events.InteractionCreate,async interaction => {
    if (!interaction.isChatInputCommand() || !interaction.inCachedGuild() || !commandNames.includes(interaction.commandName)) return
    const {guild,commandName:name} = interaction
    const respond = body => interaction.editReply(messageCard('Moderation Notice',body,{icon:'info'}))
    try {
      await interaction.deferReply({flags:MessageFlags.Ephemeral})
      if (!db.config(guild.id,'moderation').enabled) return await respond('Moderation is off in this server.')
      const actor = await guild.members.fetch({user:interaction.user.id,force:true})
      const owner = guild.ownerId === actor.id
      const permits = db.config(guild.id,'permits')
      const permit = permits.enabled ? permits.entries : []
      if (!canModerate(actor,guild.ownerId,name,permit,interaction.channel?.permissionsFor(actor))) {
        return await respond('You do not have access to this command.')
      }
      if (name === 'slowmode') {
        const channel = await guild.channels.fetch(interaction.channelId,{force:true})
        if (!channel?.setRateLimitPerUser) return await respond('Use this command in a channel that supports slowmode.')
        if (!canModerate(actor,guild.ownerId,name,permit,channel.permissionsFor(actor))) return await respond('You do not have access in this channel.')
        const on = interaction.options.getString('state',true) === 'on'
        const seconds = on ? interaction.options.getInteger('seconds') : 0
        if (seconds === null) return await respond('Choose a time in seconds when turning slowmode on.')
        await channel.setRateLimitPerUser(seconds,'Blackridge slowmode by ' + actor.id)
        const detail = 'slowmode · channel ' + channel.id + ' · moderator ' + actor.id + ' · ' + (on ? seconds + ' seconds' : 'Off')
        db.event(guild.id,'moderation',detail)
        const card = {title:'Slowmode ' + (on ? 'Enabled' : 'Disabled'),body:mention(channel.id,'channel') + (on ? ' now has a ' + seconds + '-second cooldown.' : ' no longer has a cooldown.'),options:{icon:'timer',fields:[['Moderator',mention(actor.id)]]}}
        void sendModuleLog(guild,db,'moderation',card)
        return await interaction.editReply(actionCard(card))
      }
      if (name === 'purge') {
        const channel = await guild.channels.fetch(interaction.channelId,{force:true})
        if (!channel?.bulkDelete) return await respond('Use this command in a server text channel.')
        if (!canModerate(actor,guild.ownerId,name,permit,channel.permissionsFor(actor))) return await respond('You do not have access in this channel.')
        const amount = interaction.options.getInteger('amount',true)
        const deleted = await channel.bulkDelete(amount,true)
        const detail = 'purge · ' + deleted.size + ' messages · channel ' + channel.id + ' · moderator ' + actor.id
        db.event(guild.id,'moderation',detail)
        const result = {title:'Messages Purged',body:'Deleted **'+deleted.size+'** of '+amount+' requested messages in '+mention(channel.id,'channel')+'.',
          options:{icon:'trash',fields:[['Moderator',mention(actor.id)],['Limit','Messages older than 14 days are skipped.']]}}
        void sendModuleLog(guild,db,'moderation',result)
        return await interaction.editReply(actionCard(result))
      }
      if (name === 'info') {
        const user = interaction.options.getUser('member',true)
        const [flags,member] = await Promise.all([
          user.fetchFlags().catch(() => null),guild.members.fetch({user:user.id,force:true}).catch(() => null)
        ])
        const humanize = key => key.replace(/([a-z])([A-Z])/g,'$1 $2')
        const permissions = member?.permissions.toArray().map(humanize).join(', ')
        const badges = flags?.toArray().map(humanize).join(', ')
        return await interaction.editReply(messageCard('User Information',
          '**Username** · '+safeText(user.username)+'\n**User ID** · `'+user.id+'`\n**Account Created** · '+timestamp(user.createdTimestamp)+' ('+timestamp(user.createdTimestamp,'R')+')'+
          '\n**Public Discord Badges** · '+(flags ? safeText(badges || 'None') : 'Unavailable')+
          '\n**Account Type** · '+(user.bot ? 'Bot' : 'User')+
          '\n**Joined Server** · '+(member?.joinedTimestamp ? timestamp(member.joinedTimestamp) : 'Unavailable')+
          '\n**Server Permissions** · '+(member ? safeText(permissions || 'None') : 'Unavailable'),
          {icon:'user',userId:user.id}))
      }
      if (name === 'history') {
        const member = interaction.options.getUser('member')
        const supplied = interaction.options.getString('user-id')?.trim()
        const id = member?.id ?? supplied
        if ((member && supplied) || !/^\d{17,20}$/.test(id ?? '')) return await respond('Choose a member or enter one Discord user ID.')
        const cases = db.history(guild.id,id)
        if (!cases.length) return await respond('No warnings, kicks, or bans recorded by Blackridge for that user in this server.')
        const rows = cases.map(item => new Date(item.at).toISOString() + ' | ' + item.action + ' | ' + item.detail.replace(/[\r\n]+/g,' '))
        const summary = cases.slice(0,10).map(item => '• **' + item.action + '** · <t:' + Math.floor(item.at/1000) + ':f>').join('\n')
        return await interaction.editReply(messageCard('Moderation History','Member `'+id+'` · '+cases.length+' recorded\n'+summary,
          {icon:'user',files:[{attachment:Buffer.from(rows.join('\n')),name:'moderation-history.txt'}]}))
      }
      const reason = interaction.options.getString('reason') || 'No reason supplied'
      let notice
      let action
      if (channelCommands.has(name)) {
        const key = interaction.channelId
        if (channelChanges.has(key)) return await respond('A channel change is already in progress.')
        channelChanges.add(key)
        try {
          const channel = await guild.channels.fetch(key,{force:true})
          if (channel?.type !== ChannelType.GuildText) return await respond('Use this command in a server text channel.')
          if (!canModerate(actor,guild.ownerId,name,permit,channel.permissionsFor(actor))) return await respond('You do not have access in this channel.')
          const current = channel.permissionOverwrites.cache.get(guild.id)
          if (name === 'lock-channel') {
            if (current?.allow.has(P.SendMessages) || current?.deny.has(P.SendMessages)) return await respond('This channel already has an explicit everyone send rule.')
            db.lock(guild.id,channel.id)
          } else {
            if (!db.hasLock(guild.id,channel.id)) return await respond('Blackridge has no recorded lock for this channel.')
            if (!current?.deny.has(P.SendMessages)) {
              db.unlock(guild.id,channel.id)
              return await respond('The Blackridge lock was already removed.')
            }
          }
          await channel.permissionOverwrites.edit(guild.roles.everyone,{SendMessages:name === 'lock-channel' ? false : null},{reason})
          if (name === 'unlock-channel') db.unlock(guild.id,channel.id)
        } finally { channelChanges.delete(key) }
      } else if (name === 'unban') {
        const id = interaction.options.getString('user-id',true).trim()
        if (!/^\d{17,20}$/.test(id)) return await respond('Enter a valid Discord user ID.')
        const pending = db.pendingTempBan(guild.id,id)
        try { await guild.bans.remove(id,reason) }
        catch (error) {
          if (error.code === 10026) return await respond('That user is not banned.')
          throw error
        }
        if (pending) db.removeTempBan(guild.id,id,pending.marker)
        action = memberAction(name,{userId:id,actor:actor.id,reason})
        db.event(guild.id,'moderation','unban · member ' + id + ' · moderator ' + actor.id + ' · ' + reason)
      } else {
        const target = await guild.members.fetch({user:interaction.options.getUser('member',true).id,force:true})
        if (target.id === actor.id || target.id === guild.ownerId || target.id === client.user.id ||
            (!owner && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0)) {
          return await respond('You cannot moderate that member.')
        }
        const minutes = interaction.options.getInteger('minutes')
        let until
        if (name === 'ban' && target.bannable) {
          const appeal = interaction.options.getBoolean('appeal') === true && !db.appealBlacklisted(guild.id,target.id) ? randomUUID() : null
          await target.ban({reason:appeal ? appealMarker(appeal)+reason : reason})
          if (appeal) db.inviteAppeal(appeal,guild.id,target.id,db.config(guild.id,'appeals').questions)
          notice = sendBanNotice(guild,target.user,reason,appeal)
        }
        else if (name === 'tempban' && target.bannable) await temporaryBan(target,minutes,db,reason)
        else if (name === 'kick' && target.kickable) await target.kick(reason)
        else if (name === 'timeout' && target.moderatable) {
          const timedOut = await target.timeout(minutes*60000,reason)
          until = timedOut.communicationDisabledUntilTimestamp
        }
        else if (name === 'force-verify') {
          const error = await grantVerification(db,target,db.config(guild.id,'verification'),'Blackridge force verification by '+actor.id)
          if (error) return await respond(error)
        }
        else if (name !== 'warn') return await respond('Blackridge lacks permission or role priority for this action.')
        if (name === 'tempban') until = db.pendingTempBan(guild.id,target.id)?.expires
        action = memberAction(name,{userId:target.id,actor:actor.id,reason,until})
        if (name !== 'ban') notice = target.user.send(actionCard(memberAction(name,{userId:target.id,server:guild.name,reason,until,dm:true}))).then(() => true,() => false)
        db.event(guild.id,'moderation',name + ' · member ' + target.id + ' · moderator ' + actor.id + ' · ' + reason)
      }
      if (channelCommands.has(name)) {
        db.event(guild.id,'moderation',name + ' · channel ' + interaction.channelId + ' · moderator ' + actor.id)
        const locked = name === 'lock-channel'
        action = {title:locked ? 'Channel Locked' : 'Channel Unlocked',body:mention(interaction.channelId,'channel')+' was '+(locked ? 'locked.' : 'unlocked.'),
          options:{icon:locked ? 'locked' : 'unlocked',fields:[['Moderator',mention(actor.id)],['Reason',safeText(reason)]]}}
      }
      void sendModuleLog(guild,db,'moderation',action)
      const fields = [...action.options.fields]
      if (notice && !await notice) fields.push(['DM Delivery','Discord did not deliver the member DM.'])
      await interaction.editReply(actionCard(action,{fields}))
    } catch (error) {
      console.error('Moderation command failed:',error.code ?? error.name)
      if (interaction.deferred) await respond('The action could not be completed.').catch(() => {})
    }
  })
  return () => clearInterval(sweep)
}

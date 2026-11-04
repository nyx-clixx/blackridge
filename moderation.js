import { randomUUID } from 'node:crypto'
import { ApplicationCommandType, AuditLogEvent, ChannelType, Events, MessageFlags, PermissionFlagsBits as P, SlashCommandBuilder } from 'discord.js'
import { commandNames, matchesPermit } from './store.js'
import { sendModuleLog } from './recovery.js'
import { appealMarker, attachAppeals, sendBanNotice } from './appeals.js'

const channelCommands = new Set(['lock-channel','unlock-channel'])
const timedCommands = new Set(['timeout','tempban'])
const permissions = {
  ban:P.BanMembers, tempban:P.BanMembers, unban:P.BanMembers, kick:P.KickMembers,
  timeout:P.ModerateMembers, warn:P.ModerateMembers, 'lock-channel':P.ManageChannels, 'unlock-channel':P.ManageChannels,
  purge:P.ManageMessages, history:P.ModerateMembers
}
const commands = commandNames.map(name => {
  const builder = new SlashCommandBuilder().setName(name).setDescription('Blackridge ' + name + ' moderation action')
  if (name === 'purge') return builder.setDescription('Delete recent messages in this channel').addIntegerOption(option =>
    option.setName('amount').setDescription('Number of recent messages to delete').setRequired(true).setMinValue(1).setMaxValue(100))
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
const commandSync = new Map()
export function syncModerationCommands(guild,db) {
  const previous = commandSync.get(guild.id) ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(async () => {
    const enabled = db.config(guild.id,'moderation').enabled
    if (enabled) for (const command of commands) await guild.commands.create(command)
    const obsolete = enabled ? ['lock','unlock'] : [...commandNames,'lock','unlock']
    for (const command of (await guild.commands.fetch()).values()) {
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

export function attachModeration(client,db) {
  attachAppeals(client,db)
  const channelChanges = new Set()
  client.on(Events.GuildAuditLogEntryCreate,(entry,guild) => {
    if (!db.config(guild.id,'moderation').enabled || !entry.targetId || !entry.executorId || entry.executorId === client.user.id) return
    const action = entry.action === AuditLogEvent.MemberKick ? 'kick' : entry.action === AuditLogEvent.MemberBanAdd ? 'ban' : null
    if (!action) return
    try { db.recordModeration(guild.id,entry.targetId,action,entry.reason ?? 'No reason supplied',entry.createdTimestamp,entry.id) }
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
  setInterval(async () => {
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
    try {
      await interaction.deferReply({flags:MessageFlags.Ephemeral})
      if (!db.config(guild.id,'moderation').enabled) return await interaction.editReply('Moderation is off in this server.')
      const actor = await guild.members.fetch({user:interaction.user.id,force:true})
      const owner = guild.ownerId === actor.id
      const permits = db.config(guild.id,'permits')
      const permit = permits.enabled ? permits.entries : []
      if (!canModerate(actor,guild.ownerId,name,permit,interaction.channel?.permissionsFor(actor))) {
        return await interaction.editReply('You do not have access to this command.')
      }
      if (name === 'purge') {
        const channel = await guild.channels.fetch(interaction.channelId,{force:true})
        if (!channel?.bulkDelete) return await interaction.editReply('Use this command in a server text channel.')
        if (!canModerate(actor,guild.ownerId,name,permit,channel.permissionsFor(actor))) return await interaction.editReply('You do not have access in this channel.')
        const amount = interaction.options.getInteger('amount',true)
        const deleted = await channel.bulkDelete(amount,true)
        const detail = 'purge · ' + deleted.size + ' messages · channel ' + channel.id + ' · moderator ' + actor.id
        db.event(guild.id,'moderation',detail)
        void sendModuleLog(guild,db,'moderation',detail)
        return await interaction.editReply('Deleted ' + deleted.size + ' of ' + amount + ' requested messages. Messages older than 14 days are skipped.')
      }
      if (name === 'history') {
        const member = interaction.options.getUser('member')
        const supplied = interaction.options.getString('user-id')?.trim()
        const id = member?.id ?? supplied
        if ((member && supplied) || !/^\d{17,20}$/.test(id ?? '')) return await interaction.editReply('Choose a member or enter one Discord user ID.')
        const cases = db.history(guild.id,id)
        if (!cases.length) return await interaction.editReply('No warnings, kicks, or bans recorded by Blackridge for that user in this server.')
        const rows = cases.map(item => new Date(item.at).toISOString() + ' | ' + item.action + ' | ' + item.detail.replace(/[\r\n]+/g,' '))
        const summary = cases.slice(0,10).map(item => '• **' + item.action + '** · <t:' + Math.floor(item.at/1000) + ':f>').join('\n')
        return await interaction.editReply({content:'**Moderation history** for `' + id + '` · ' + cases.length + ' recorded\n' + summary,
          allowedMentions:{parse:[]},files:[{attachment:Buffer.from(rows.join('\n')),name:'moderation-history.txt'}]})
      }
      const reason = interaction.options.getString('reason') || 'No reason supplied'
      let notice
      if (channelCommands.has(name)) {
        const key = interaction.channelId
        if (channelChanges.has(key)) return await interaction.editReply('A channel change is already in progress.')
        channelChanges.add(key)
        try {
          const channel = await guild.channels.fetch(key,{force:true})
          if (channel?.type !== ChannelType.GuildText) return await interaction.editReply('Use this command in a server text channel.')
          if (!canModerate(actor,guild.ownerId,name,permit,channel.permissionsFor(actor))) return await interaction.editReply('You do not have access in this channel.')
          const current = channel.permissionOverwrites.cache.get(guild.id)
          if (name === 'lock-channel') {
            if (current?.allow.has(P.SendMessages) || current?.deny.has(P.SendMessages)) return await interaction.editReply('This channel already has an explicit everyone send rule.')
            db.lock(guild.id,channel.id)
          } else {
            if (!db.hasLock(guild.id,channel.id)) return await interaction.editReply('Blackridge has no recorded lock for this channel.')
            if (!current?.deny.has(P.SendMessages)) {
              db.unlock(guild.id,channel.id)
              return await interaction.editReply('The Blackridge lock was already removed.')
            }
          }
          await channel.permissionOverwrites.edit(guild.roles.everyone,{SendMessages:name === 'lock-channel' ? false : null},{reason})
          if (name === 'unlock-channel') db.unlock(guild.id,channel.id)
        } finally { channelChanges.delete(key) }
      } else if (name === 'unban') {
        const id = interaction.options.getString('user-id',true).trim()
        if (!/^\d{17,20}$/.test(id)) return await interaction.editReply('Enter a valid Discord user ID.')
        const pending = db.pendingTempBan(guild.id,id)
        try { await guild.bans.remove(id,reason) }
        catch (error) {
          if (error.code === 10026) return await interaction.editReply('That user is not banned.')
          throw error
        }
        if (pending) db.removeTempBan(guild.id,id,pending.marker)
        db.event(guild.id,'moderation','unban · member ' + id + ' · moderator ' + actor.id + ' · ' + reason)
      } else {
        const target = await guild.members.fetch({user:interaction.options.getUser('member',true).id,force:true})
        if (target.id === actor.id || target.id === guild.ownerId || target.id === client.user.id ||
            (!owner && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0)) {
          return await interaction.editReply('You cannot moderate that member.')
        }
        const minutes = interaction.options.getInteger('minutes')
        if (name === 'ban' && target.bannable) {
          const appeal = interaction.options.getBoolean('appeal') === true ? randomUUID() : null
          await target.ban({reason:appeal ? appealMarker(appeal)+reason : reason})
          if (appeal) db.inviteAppeal(appeal,guild.id,target.id,db.config(guild.id,'appeals').questions)
          notice = sendBanNotice(guild,target.user,reason,appeal)
        }
        else if (name === 'tempban' && target.bannable) await temporaryBan(target,minutes,db,reason)
        else if (name === 'kick' && target.kickable) await target.kick(reason)
        else if (name === 'timeout' && target.moderatable) await target.timeout(minutes*60000,reason)
        else if (name !== 'warn') return await interaction.editReply('Blackridge lacks permission or role priority for this action.')
        db.event(guild.id,'moderation',name + ' · member ' + target.id + ' · moderator ' + actor.id + ' · ' + reason)
      }
      if (channelCommands.has(name)) db.event(guild.id,'moderation',name + ' · channel ' + interaction.channelId + ' · moderator ' + actor.id)
      void sendModuleLog(guild,db,'moderation','/' + name + ' completed · moderator ' + actor.id + ' · channel ' + interaction.channelId)
      await interaction.editReply({content:'Recorded /' + name + '.' + (notice && !await notice ? ' Discord did not deliver the ban DM.' : ''),allowedMentions:{parse:[]}})
    } catch (error) {
      console.error('Moderation command failed:',error.code ?? error.name)
      if (interaction.deferred) await interaction.editReply('The action could not be completed.').catch(() => {})
    }
  })
}

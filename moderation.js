import { randomUUID } from 'node:crypto'
import { ApplicationCommandType, ChannelType, Events, MessageFlags, PermissionFlagsBits as P, SlashCommandBuilder } from 'discord.js'
import { commandNames, matchesPermit } from './store.js'
import { sendModuleLog } from './recovery.js'

const channelCommands = new Set(['lock-channel','unlock-channel'])
const timedCommands = new Set(['timeout','tempban'])
const permissions = {
  ban:P.BanMembers, tempban:P.BanMembers, unban:P.BanMembers, kick:P.KickMembers,
  timeout:P.ModerateMembers, warn:P.ModerateMembers, 'lock-channel':P.ManageChannels, 'unlock-channel':P.ManageChannels
}
const commands = commandNames.map(name => {
  const builder = new SlashCommandBuilder().setName(name).setDescription('Blackridge ' + name + ' moderation action')
  if (name === 'unban') {
    builder.addStringOption(option => option.setName('user-id').setDescription('Discord ID of the banned user').setRequired(true).setMinLength(17).setMaxLength(20))
  } else if (!channelCommands.has(name)) {
    builder.addUserOption(option => option.setName('member').setDescription('Server member').setRequired(true))
    if (timedCommands.has(name)) builder.addIntegerOption(option => option.setName('minutes').setDescription('Duration in minutes').setMinValue(1).setMaxValue(1440).setRequired(true))
  }
  return builder.addStringOption(option => option.setName('reason').setDescription('Reason for the action').setMaxLength(250))
})

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
  const channelChanges = new Set()
  const register = async guild => {
    try {
      for (const command of commands) await guild.commands.create(command)
      for (const command of (await guild.commands.fetch()).values()) {
        if (command.type === ApplicationCommandType.ChatInput && ['lock','unlock'].includes(command.name)) await command.delete()
      }
    }
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
      const actor = await guild.members.fetch({user:interaction.user.id,force:true})
      const owner = guild.ownerId === actor.id
      const permit = db.config(guild.id,'permits').entries
      if (!canModerate(actor,guild.ownerId,name,permit,interaction.channel?.permissionsFor(actor))) {
        return await interaction.editReply('You do not have access to this command.')
      }
      const reason = interaction.options.getString('reason') || 'No reason supplied'
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
        if (name === 'ban' && target.bannable) await target.ban({reason})
        else if (name === 'tempban' && target.bannable) await temporaryBan(target,minutes,db,reason)
        else if (name === 'kick' && target.kickable) await target.kick(reason)
        else if (name === 'timeout' && target.moderatable) await target.timeout(minutes*60000,reason)
        else if (name !== 'warn') return await interaction.editReply('Blackridge lacks permission or role priority for this action.')
        db.event(guild.id,'moderation',name + ' · member ' + target.id + ' · moderator ' + actor.id + ' · ' + reason)
      }
      if (channelCommands.has(name)) db.event(guild.id,'moderation',name + ' · channel ' + interaction.channelId + ' · moderator ' + actor.id)
      void sendModuleLog(guild,db,'moderation','/' + name + ' completed · moderator ' + actor.id + ' · channel ' + interaction.channelId)
      await interaction.editReply({content:'Recorded /' + name + '.',allowedMentions:{parse:[]}})
    } catch (error) {
      console.error('Moderation command failed:',error.code ?? error.name)
      if (interaction.deferred) await interaction.editReply('The action could not be completed.').catch(() => {})
    }
  })
}


import { isTextDestination } from './text-channel.js'
import { randomInt, randomUUID } from 'node:crypto'
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, MessageFlags, ModalBuilder, PermissionFlagsBits as P, TextInputBuilder, TextInputStyle } from 'discord.js'
import png from 'pngjs'
import { sendModuleLog } from './recovery.js'
import { mention, messageCard } from './messages.js'

const prefix = 'blackridge-verify:'
const reason = 'Blackridge member verification'
const roleChanges = new Set()
function quarantined(db,guild,member) {
  const roles = [db.recovery(guild.id,'quarantineRole')?.role,db.recovery(guild.id,'quarantine:'+member.id)?.role]
  return roles.some(role => role && (member.roles.cache.has(role) || db.hasQuarantine(guild.id,member.id,role)))
}
const forbidden = Object.entries(P).reduce((bits,[name,permission]) =>
  /^(Administrator|Manage|Moderate|Kick|Ban|MentionEveryone|ViewAuditLog)/.test(name) ? bits | permission : bits,0n)
const digits = ['111101101101111','010110010010111','111001111100111','111001111001111',
  '101101111001001','111100111001111','111100111101111','111001001001001','111101111101111','111101111001111']

function captcha() {
  const answer = Array.from({length:6},() => randomInt(2,10)).join('')
  const image = new png.PNG({width:276,height:76})
  const pixel = (x,y,r,g,b) => {
    if (x < 0 || x >= image.width || y < 0 || y >= image.height) return
    const i = (y*image.width+x)*4
    image.data.set([r,g,b,255],i)
  }
  for (let y=0;y<image.height;y++) for (let x=0;x<image.width;x++) {
    const shade = randomInt(15,42)
    pixel(x,y,shade,shade,shade+14)
  }
  for (const [i,digit] of [...answer].entries()) {
    const x = 12+i*44+randomInt(-3,4)
    const y = 16+randomInt(-5,6)
    const tilt = randomInt(-2,3)
    for (const [cell,on] of [...digits[Number(digit)]].entries()) {
      if (on === '0') continue
      for (let dy=0;dy<8;dy++) for (let dx=0;dx<9;dx++)
        pixel(x+(cell%3)*9+dx+Math.trunc((Math.floor(cell/3)-2)*tilt),y+Math.floor(cell/3)*8+dy,210,230,255)
    }
  }
  for (let i=0;i<5;i++) {
    const start = randomInt(10,66), end = randomInt(10,66)
    for (let x=0;x<image.width;x++) pixel(x,Math.round(start+(end-start)*x/image.width),89,118,155)
  }
  return {answer,image:png.PNG.sync.write(image)}
}
const button = (id,label) => new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(prefix+id).setLabel(label).setStyle(ButtonStyle.Primary))

async function memberRole(guild,id,db) {
  const role = id && await guild.roles.fetch(id,{force:true})
  const blocked = [db.recovery(guild.id,'quarantineRole')?.role,db.recovery(guild.id,'quarantineSetup')?.role]
  if (!role?.editable || role.id === guild.id || blocked.includes(role.id) || (role.permissions.bitfield & forbidden)) return null
  if (guild.channels.cache.some(channel => (channel.permissionOverwrites?.cache.get(role.id)?.allow.bitfield ?? 0n) & forbidden)) return null
  return role
}
export async function grantVerification(db,member,config,auditReason=reason) {
  const {guild} = member
  if (!config.enabled) return 'Verification is disabled in this server.'
  if (member.user.bot || member.pending || member.isCommunicationDisabled() || quarantined(db,guild,member))
    return 'This member cannot be verified while they are pending, timed out, or quarantined.'
  if (member.roles.cache.has(config.verifiedRole)) return 'This member is already verified.'
  const key = guild.id+':'+member.id
  if (roleChanges.has(key)) return 'Verification is already in progress for this member.'
  roleChanges.add(key)
  try {
    const verified = await memberRole(guild,config.verifiedRole,db)
    const unverified = await memberRole(guild,config.unverifiedRole,db)
    if (!verified || (config.unverifiedRole && (!unverified || unverified.id === verified.id)))
      return 'Check the verification role configuration and Blackridge’s role permissions.'
    if (JSON.stringify(config) !== JSON.stringify(db.config(guild.id,'verification')) || quarantined(db,guild,member))
      return 'Verification settings changed. Try again.'
    await member.roles.add(verified,auditReason)
    if (unverified && member.roles.cache.has(unverified.id)) {
      try { await member.roles.remove(unverified,auditReason) }
      catch (error) {
        await member.roles.remove(verified,auditReason+' rollback').catch(() => {})
        throw error
      }
    }
    return null
  } finally { roleChanges.delete(key) }
}

export async function publishVerification(guild,db) {
  const config = db.config(guild.id,'verification')
  if (!config.enabled || !config.channel || config.verifiedRole === config.unverifiedRole) return null
  const channel = await guild.channels.fetch(config.channel,{force:true})
  if (!isTextDestination(channel) ||
      !await memberRole(guild,config.verifiedRole,db) ||
      (config.unverifiedRole && !await memberRole(guild,config.unverifiedRole,db))) return null
  const saved = db.recovery(guild.id,'verificationPanel')
  const payload = messageCard('Verification Required','Press **Verify** to unlock member access. ' +
    (config.mode === 'captcha' ? 'You’ll receive a private image challenge.' : 'Blackridge will assign your member role.'),
    {icon:'shield',actions:[button('start','Verify')]})
  if (saved?.channel === channel.id) {
    const previous = await channel.messages.fetch(saved.message).catch(error => {
      if (error.code !== 10008) throw error
      return null
    })
    if (previous?.author.id === guild.client.user.id)
      return previous.edit(previous.flags.has(MessageFlags.IsComponentsV2) ? payload : {...payload,content:null,embeds:[]})
  }
  const message = await channel.send(payload)
  db.saveRecovery(guild.id,'verificationPanel',{channel:channel.id,message:message.id})
  return message
}

export function attachVerification(client,db) {
  const sessions = new Map()
  const busy = new Set()
  const cleanup = setInterval(() => {
    const now = Date.now()
    for (const [key,session] of sessions) if (session.until <= now) sessions.delete(key)
  },60000)
  cleanup.unref()
  const log = (guild,member,outcome) => {
    const message = 'Verification ' + outcome + ' for ' + member.id
    db.event(guild.id,'verification',message)
    const title = {passed:'Member Verified',failed:'Verification Failed','kicked after failed attempts':'Member Kicked After Verification Failure'}[outcome] ?? 'Verification'
    void sendModuleLog(guild,db,'verification',{title,body:mention(member.id)+(outcome === 'passed' ? ' completed verification.' : ' did not pass verification.'),
      options:{icon:outcome === 'passed' ? 'check' : 'warning',userId:member.id}})
  }
  client.on(Events.GuildMemberAdd,async member => {
    const {guild} = member
    const config = db.config(guild.id,'verification')
    if (!config.enabled || !config.unverifiedRole || member.user.bot || quarantined(db,guild,member) || member.roles.cache.has(config.verifiedRole)) return
    const key = guild.id + ':' + member.id
    if (roleChanges.has(key)) return
    roleChanges.add(key)
    try {
      const role = await memberRole(guild,config.unverifiedRole,db)
      if (role && role.id !== config.verifiedRole &&
          JSON.stringify(config) === JSON.stringify(db.config(guild.id,'verification')) &&
          !quarantined(db,guild,member) && !member.roles.cache.has(config.verifiedRole)) await member.roles.add(role,reason)
    } catch (error) { console.error('Unverified role assignment failed:',error.code ?? error.name) }
    finally { roleChanges.delete(key) }
  })
  client.on(Events.InteractionCreate,async interaction => {
    if (!interaction.inCachedGuild() || !(interaction.isButton() || interaction.isModalSubmit()) ||
        !interaction.customId.startsWith(prefix)) return
    const {guild,user} = interaction
    const key = guild.id + ':' + user.id
    const action = interaction.customId.slice(prefix.length)
    const ephemeral = {flags:MessageFlags.Ephemeral}
    const reply = (body,success=false) => {
      const card = messageCard(success ? 'Verified' : 'Verification',body,
        {icon:success ? 'check' : 'shield',tone:success ? 'success' : 'info',ephemeral:!interaction.deferred})
      return interaction.deferred ? interaction.editReply(card) : interaction.reply(card)
    }
    if (busy.has(key)) { await reply('Verification is already in progress.').catch(() => {}); return }
    busy.add(key)
    try {
      const config = db.config(guild.id,'verification')
      const panel = db.recovery(guild.id,'verificationPanel')
      if (!config.enabled || config.channel !== interaction.channelId || panel?.channel !== config.channel)
        return await reply('This verification panel is inactive.')
      const now = Date.now()
      let session = sessions.get(key)
      const policy = JSON.stringify(config)
      if (session && (session.until <= now || (!session.blocked && (session.panel !== panel.message || session.policy !== policy)))) {
        sessions.delete(key)
        session = null
      }
      if (session?.blocked) return await reply('Too many attempts. Try again in 10 minutes.')
      if (action.startsWith('answer:') && interaction.isButton()) {
        if (config.mode !== 'captcha' || !session || action !== 'answer:'+session.id) return await reply('This challenge expired. Press Verify to start again.')
        const input = new TextInputBuilder().setCustomId('code').setLabel('Six digits in the image')
          .setStyle(TextInputStyle.Short).setMinLength(6).setMaxLength(6).setRequired(true)
        return await interaction.showModal(new ModalBuilder().setCustomId(prefix+'submit:'+session.id)
          .setTitle('Enter Verification Code').addComponents(new ActionRowBuilder().addComponents(input)))
      }
      const start = action === 'start' && interaction.isButton() && interaction.message.id === panel.message
      const submit = interaction.isModalSubmit() && config.mode === 'captcha' && session && action === 'submit:'+session.id
      if (!start && !submit) return await reply('This challenge expired. Press Verify to start again.')
      await interaction.deferReply(ephemeral)
      const member = await guild.members.fetch({user:user.id,force:true})
      if (member.user.bot || member.pending || member.isCommunicationDisabled() || quarantined(db,guild,member))
        return await reply('Verification is unavailable for your account right now.')
      if (member.roles.cache.has(config.verifiedRole)) return await reply('You are already verified.')
      if (now-user.createdTimestamp < config.minAge*86400000) return await reply('Your Discord account is too new to verify in this server.')
      if (start && config.mode === 'captcha') {
        if (session?.issued > now-5000) return await reply('Wait a few seconds before requesting another challenge.')
        const challenge = captcha()
        session = {id:randomUUID(),answer:challenge.answer,panel:panel.message,policy,failures:session?.failures ?? 0,issued:now,until:now+config.minutes*60000}
        sessions.set(key,session)
        return await interaction.editReply(messageCard('Verification Challenge','Read the six digits, then press **Enter Code**.',{
          icon:'shield',actions:[button('answer:'+session.id,'Enter Code')],media:'verification.png',files:[{attachment:challenge.image,name:'verification.png'}]}))
      }
      if (policy !== JSON.stringify(db.config(guild.id,'verification')) ||
          panel.message !== db.recovery(guild.id,'verificationPanel')?.message)
        return await reply('Verification settings changed. Press Verify to try again.')
      if (submit && interaction.fields.getTextInputValue('code').trim() !== session.answer) {
        session.failures++
        if (session.failures < config.attempts) return await reply('That code is incorrect. Try again. Attempts left: ' + (config.attempts-session.failures) + '.')
        sessions.set(key,{blocked:true,until:now+600000})
        log(guild,member,'failed')
        if (config.failure === 'kick' && member.kickable) {
          await member.kick(reason+' attempts exhausted')
          db.recordModeration(guild.id,member.id,'kick',reason+' attempts exhausted')
          log(guild,member,'kicked after failed attempts')
          return await reply('Verification failed and you were removed from the server.')
        }
        return await reply('Verification failed. Try again in 10 minutes.')
      }
      const error = await grantVerification(db,member,config)
      if (error) return await reply(error)
      sessions.delete(key)
      log(guild,member,'passed')
      await reply('Welcome to the server!',true)
    } catch (error) {
      console.error('Verification failed:',error.code ?? error.name)
      await reply('Verification could not be completed. Try again or contact a server administrator.').catch(() => {})
    } finally { busy.delete(key) }
  })
  return () => clearInterval(cleanup)
}

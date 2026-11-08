import { enqueueDiscordLog } from './discord-logs.js'
import { isTextDestination } from './text-channel.js'
import { ActionRowBuilder, CheckboxBuilder, LabelBuilder, ButtonBuilder, ButtonStyle, Events, MessageFlags, ModalBuilder, PermissionFlagsBits as P, TextInputBuilder, TextInputStyle } from 'discord.js'
import { matchesPermit } from './store.js'
import { actionCard, memberAction, mention, messageCard, safeText } from './messages.js'

const prefix = 'blackridge-appeal:'
const reviewPrefix = 'blackridge-review:'
const lifetime = 30*86400000
export const appealMarker = id => '[Blackridge appeal ' + id + '] '
export const appealDecisions = ['accepted','rejected','blacklisted']
const reviews = new Set()
const questionLabel = question => typeof question === 'string' ? question : question.label
const invalid = (message,status=409) => Object.assign(new Error(message),{status})
export function canReviewAppeals(guild,member,db) {
  if (!member) return false
  if (guild.ownerId === member.id) return true
  const permits = db.config(guild.id,'permits')
  return permits.enabled && member.permissions.has(P.BanMembers) &&
    permits.entries.some(entry => entry.appealsManager && matchesPermit(entry,member.id,guild.id,member.roles.cache))
}
export async function privateAppealChannel(guild,id) {
  if (!id) return null
  const channel = await guild.channels.fetch(id,{force:true})
  if (channel?.guildId !== guild.id || !isTextDestination(channel) ||
      !channel.permissionOverwrites?.cache.get(guild.id)?.deny.has(P.ViewChannel) ||
      channel.permissionsFor(guild.roles.everyone)?.has(P.ViewChannel) ||
      !channel.permissionsFor(guild.members.me)?.has(P.ViewChannel | P.SendMessages)) return null
  return channel
}

function logAppeal(guild,db,title,body,userId) {
  const channel = db.config(guild.id,'appeals').alertChannel
  enqueueDiscordLog(guild,channel,messageCard(title,body,{icon:'inbox',userId}),privateAppealChannel)
}
function reviewCard(row) {
  const questions = JSON.parse(row.questions)
  const answers = JSON.parse(row.answers)
  const transcript = questions.map((question,i) => questionLabel(question)+'\n'+answers[i]).join('\n\n')
  const details = questions.map((question,i) => '**'+safeText(questionLabel(question))+'**\n'+safeText(answers[i])).join('\n\n')
  const heading = mention(row.user)+' submitted a ban appeal. · **'+row.status.toUpperCase()+'**\n\n'
  const actions = row.status === 'pending' ? [new ActionRowBuilder().addComponents(
    ...[['accepted','Accept & Unban',ButtonStyle.Success],['rejected','Reject',ButtonStyle.Secondary],['blacklisted','Blacklist',ButtonStyle.Danger]]
      .map(([decision,label,style]) => new ButtonBuilder().setCustomId(reviewPrefix+decision+':'+row.id).setLabel(label).setStyle(style))
  )] : []
  const long = (heading+details).length > 3400
  return messageCard('Ban Appeal',heading+(long ? 'See the attached appeal answers.' : details),{
    icon:'inbox',userId:row.user,at:row.submitted,actions,
    files:long ? [{attachment:Buffer.from(transcript),name:'appeal-answers.txt'}] : []
  })
}
async function postReview(guild,db,id) {
  const channel = await privateAppealChannel(guild,db.config(guild.id,'appeals').channel)
  if (!channel) return
  const row = db.appeal(id)
  const message = await channel.send(reviewCard(row))
  db.saveAppealDelivery(id,channel.id,message.id)
}
export async function reviewBanAppeal(guild,db,id,decision,actor) {
  if (!appealDecisions.includes(decision)) throw invalid('Choose a valid decision.',400)
  const key = guild.id+':'+id
  if (reviews.has(key)) throw invalid('This appeal is already being reviewed.')
  reviews.add(key)
  try {
    const row = db.appeal(id)
    if (!row || row.guild !== guild.id || row.status !== 'pending') throw invalid('Pending appeal not found.',404)
    if (decision === 'accepted') {
      if (db.appealBlacklisted(guild.id,row.user)) throw invalid('This applicant is blacklisted from appeals.')
      if (!await hasAppealableBan(guild,row)) throw invalid('The original ban is no longer active. This appeal cannot lift a different ban.')
      await guild.bans.remove(row.user,'Blackridge appeal accepted by '+actor)
    }
    if (!db.reviewAppeal(id,guild.id,decision)) throw invalid('This appeal was already reviewed.')
    db.event(guild.id,'appeals','Ban appeal '+decision+' for '+row.user+' by '+actor)
    void logAppeal(guild,db,'Ban Appeal Reviewed','Appeal ' + decision + '.',row.user)
    const delivery = db.appealDelivery(id)
    if (delivery) {
      try {
        const channel = await privateAppealChannel(guild,delivery.channel)
        const message = await channel?.messages.fetch(delivery.message)
        if (message?.author.id === guild.client.user.id) {
          await message.edit({...reviewCard(db.appeal(id)),attachments:[]})
        }
      } catch { console.error('Could not refresh Discord appeal card') }
    }
    void guild.client.users.fetch(row.user).then(user => user.send(messageCard('Appeal Reviewed',
      'Your appeal for **'+safeText(guild.name)+'** was '+(decision === 'blacklisted' ? 'rejected. Future appeals for this server are disabled.' : decision+'.'),
      {icon:decision === 'accepted' ? 'check' : 'mail',tone:decision === 'accepted' ? 'success' : 'warning'}))).catch(() => {})
  } finally { reviews.delete(key) }
}

export async function sendBanNotice(guild,user,reason,id) {
  const components = id ? [new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId(prefix+id).setLabel('Appeal Ban').setStyle(ButtonStyle.Primary))] : []
  try {
    const action = memberAction('ban',{userId:user.id,server:guild.name,reason,dm:true})
    if (id) action.options.fields.push(['Appeal','You can appeal this ban within 30 days.'])
    await user.send(actionCard(action,{actions:components}))
    return true
  } catch { return false }
}

export async function hasAppealableBan(guild,row) {
  try {
    const ban = await guild.bans.fetch({user:row.user,force:true})
    return Boolean(ban.reason?.startsWith(appealMarker(row.id)))
  } catch (error) {
    if (error.code === 10026) return false
    throw error
  }
}

export function attachAppeals(client,db,lookupGuild = id => client.guilds.cache.get(id)) {
  client.on(Events.InteractionCreate,async interaction => {
    if (interaction.isButton() && interaction.inCachedGuild() && interaction.customId.startsWith(reviewPrefix)) {
      await interaction.deferReply({flags:MessageFlags.Ephemeral}).catch(() => {})
      if (!interaction.deferred) return
      const [decision,id] = interaction.customId.slice(reviewPrefix.length).split(':')
      try {
        const {guild} = interaction
        const actor = await guild.members.fetch({user:interaction.user.id,force:true})
        const delivery = db.appealDelivery(id)
        if (!canReviewAppeals(guild,actor,db) || delivery?.message !== interaction.message.id || delivery?.channel !== interaction.channelId)
          throw invalid('You do not have access to review this appeal.',403)
        await reviewBanAppeal(guild,db,id,decision,actor.id)
        await interaction.editReply(messageCard('Appeal Reviewed','This appeal is now **'+decision+'**.',{icon:'check',tone:'success'}))
      } catch (error) {
        await interaction.editReply(messageCard('Review Failed',safeText(error.status ? error.message : 'Could not complete this review.'),{icon:'warning',tone:'danger'})).catch(() => {})
      }
      return
    }
    if (interaction.inGuild() || !(interaction.isButton() || interaction.isModalSubmit()) || !interaction.customId.startsWith(prefix)) return
    const id = interaction.customId.slice(prefix.length)
    try {
      const row = db.appeal(id)
      if (!row || row.user !== interaction.user.id || row.status !== 'invited' || row.created <= Date.now()-lifetime || db.appealBlacklisted(row.guild,row.user))
        return await interaction.reply(messageCard('Appeal Unavailable','This invitation expired, was already used, or cannot be used.',{icon:'locked',tone:'warning'}))
      const questions = JSON.parse(row.questions)
      if (interaction.isButton()) {
        const modal = new ModalBuilder().setCustomId(prefix+id).setTitle('Ban Appeal')
        for (const [index,question] of questions.entries()) {
          const customId = 'question-'+index
          const label = new LabelBuilder().setLabel(questionLabel(question))
          if (question.type === 'checkbox') label.setCheckboxComponent(new CheckboxBuilder().setCustomId(customId))
          else label.setTextInputComponent(new TextInputBuilder().setCustomId(customId)
            .setStyle(question.type === 'short' ? TextInputStyle.Short : TextInputStyle.Paragraph).setRequired(true).setMaxLength(750))
          modal.addLabelComponents(label)
        }
        return await interaction.showModal(modal)
      }
      await interaction.deferReply()
      const guild = lookupGuild(row.guild)
      if (!guild?.available || !await hasAppealableBan(guild,row))
        return await interaction.editReply(messageCard('Appeal Unavailable','The original ban is no longer eligible.',{icon:'locked',tone:'warning'}))
      const answers = questions.map((question,index) => question.type === 'checkbox' ? (interaction.fields.getCheckbox('question-'+index) ? 'Yes' : 'No') : interaction.fields.getTextInputValue('question-'+index).trim())
      if (answers.some(answer => !answer || answer.length > 750))
        return await interaction.editReply(messageCard('Incomplete Appeal','Answer each question before submitting.',{icon:'warning',tone:'warning'}))
      if (!db.submitAppeal(id,interaction.user.id,answers)) return await interaction.editReply(messageCard('Appeal Unavailable','This appeal was already submitted or has expired.',{icon:'locked',tone:'warning'}))
      void logAppeal(guild,db,'Ban Appeal Submitted','A new appeal is ready for review.',row.user)
      void postReview(guild,db,id).catch(() => console.error('Discord appeal delivery failed. The dashboard still has the submission.'))
      await interaction.editReply(messageCard('Appeal Submitted','The server’s appeal reviewers can now review your answers.',{icon:'check',tone:'success'}))
    } catch (error) {
      console.error('Ban appeal failed:',error.code ?? error.name)
      const failure = messageCard('Appeal Error','Try again shortly.',{icon:'warning',tone:'danger'})
      if (interaction.deferred) await interaction.editReply(failure).catch(() => {})
      else if (!interaction.replied) await interaction.reply(failure).catch(() => {})
    }
  })
}

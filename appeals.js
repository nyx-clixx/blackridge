import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js'

const prefix = 'blackridge-appeal:'
const lifetime = 30*86400000
export const appealMarker = id => '[Blackridge appeal ' + id + '] '

export async function sendBanNotice(guild,user,reason,id) {
  const components = id ? [new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId(prefix+id).setLabel('Appeal Ban').setStyle(ButtonStyle.Primary))] : []
  try {
    await user.send({content:'You were banned from **' + guild.name + '**.\nReason: ' + reason +
      (id ? '\nYou can appeal this ban within 30 days using the button below.' : ''),components,allowedMentions:{parse:[]}})
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

export function attachAppeals(client,db) {
  client.on(Events.InteractionCreate,async interaction => {
    if (interaction.inGuild() || !(interaction.isButton() || interaction.isModalSubmit()) || !interaction.customId.startsWith(prefix)) return
    const id = interaction.customId.slice(prefix.length)
    try {
      const row = db.appeal(id)
      if (!row || row.user !== interaction.user.id || row.status !== 'invited' || row.created <= Date.now()-lifetime)
        return await interaction.reply('This appeal link is unavailable, expired, or already used.')
      const questions = JSON.parse(row.questions)
      if (interaction.isButton()) {
        const modal = new ModalBuilder().setCustomId(prefix+id).setTitle('Ban Appeal')
        for (const [index,question] of questions.entries()) modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('question-'+index).setLabel(question).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(750)
        ))
        return await interaction.showModal(modal)
      }
      await interaction.deferReply()
      const guild = client.guilds.cache.get(row.guild)
      if (!guild?.available || !await hasAppealableBan(guild,row))
        return await interaction.editReply('That ban is no longer eligible for an appeal.')
      const answers = questions.map((_,index) => interaction.fields.getTextInputValue('question-'+index).trim())
      if (answers.some(answer => !answer || answer.length > 750))
        return await interaction.editReply('Answer each question before submitting your appeal.')
      if (!db.submitAppeal(id,interaction.user.id,answers)) return await interaction.editReply('This appeal has already been submitted or has expired.')
      await interaction.editReply('Your appeal was submitted to the server owner.')
    } catch (error) {
      console.error('Ban appeal failed:',error.code ?? error.name)
      if (interaction.deferred) await interaction.editReply('The appeal could not be submitted. Try again shortly.').catch(() => {})
      else if (!interaction.replied) await interaction.reply('The appeal could not be opened. Try again shortly.').catch(() => {})
    }
  })
}

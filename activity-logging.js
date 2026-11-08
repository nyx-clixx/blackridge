import { AuditLogEvent as A, Events } from 'discord.js'
import { enqueueDiscordLog } from './discord-logs.js'
import { mention, messageCard, safeText, timestamp } from './messages.js'

const auditRoutes = new Map([
  [A.ChannelCreate,['channelCreate','Channel Created','Channel']],
  [A.ChannelUpdate,['channelUpdate','Channel Updated','Channel']],
  [A.ChannelOverwriteCreate,['channelUpdate','Channel Permissions Added','Channel']],
  [A.ChannelOverwriteUpdate,['channelUpdate','Channel Permissions Updated','Channel']],
  [A.ChannelOverwriteDelete,['channelUpdate','Channel Permissions Removed','Channel']],
  [A.ChannelDelete,['channelDelete','Channel Deleted','Channel']],
  [A.RoleCreate,['roleCreate','Role Created','Role']],
  [A.RoleUpdate,['roleUpdate','Role Updated','Role']],
  [A.RoleDelete,['roleDelete','Role Deleted','Role']],
  [A.MemberRoleUpdate,['memberRoles','Member Roles Updated','Member']],
  [A.InviteCreate,['inviteCreate','Invite Created']],
  [A.InviteDelete,['inviteDelete','Invite Deleted']],
  [A.WebhookCreate,['webhookCreate','Webhook Created','Webhook']],
  [A.WebhookDelete,['webhookDelete','Webhook Deleted','Webhook']],
  [A.EmojiCreate,['emojiCreate','Emoji Created','Emoji']],
  [A.EmojiUpdate,['emojiUpdate','Emoji Updated','Emoji']],
  [A.EmojiDelete,['emojiDelete','Emoji Deleted','Emoji']],
  [A.StickerCreate,['stickerCreate','Sticker Created','Sticker']],
  [A.StickerUpdate,['stickerUpdate','Sticker Updated','Sticker']],
  [A.StickerDelete,['stickerDelete','Sticker Deleted','Sticker']],
  [A.SoundboardSoundCreate,['soundboardSoundCreate','Soundboard Sound Created','Soundboard Sound']],
  [A.SoundboardSoundUpdate,['soundboardSoundUpdate','Soundboard Sound Updated','Soundboard Sound']],
  [A.SoundboardSoundDelete,['soundboardSoundDelete','Soundboard Sound Deleted','Soundboard Sound']]
])

export function activityDestination(db,guildId,event) {
  const config = db.config(guildId,'logging')
  return config.enabled ? config.channels[event === 'memberRoles' ? 'roleUpdate' : event] : undefined
}

const activityIcons = {
  channel:'announcement',role:'shield',member:'user',message:'mail',invite:'link',
  webhook:'wrench',server:'gear',emoji:'info',sticker:'info',soundboard:'announcement'
}
const activityIcon = event => event === 'messageDelete' ? 'trash' : activityIcons[event.match(/^[a-z]+/)[0]]

export function attachActivityLogging(client,db,enqueue = enqueueDiscordLog,windowMs = 60000) {
  const groups = new Map()
  function send(guild,event,title,{scope,fields,lines,at = Date.now()}) {
    if (!guild) return
    const destination = activityDestination(db,guild.id,event)
    if (!destination) return
    const key = [guild.id,destination,event,...scope].join(':')
    let group = groups.get(key)
    if (!group) {
      // A fixed window prevents continuous activity from delaying a log indefinitely.
      if (groups.size >= 512) return
      const timer = setTimeout(() => {
        groups.delete(key)
        if (activityDestination(db,guild.id,event) !== destination) return
        const options = {icon:activityIcon(event),fields,at:group.first}
        const count = group.events
        const range = count > 1 ? count + ' changes · ' + timestamp(group.first,'t') + ' to ' + timestamp(group.last,'t') + '\n\n' : ''
        const batches = ['']
        for (const line of group.lines) {
          const bullet = '• ' + line + '\n'
          if (batches.at(-1).length + bullet.length > 3000) batches.push('')
          batches[batches.length - 1] += bullet
        }
        for (const [index,batch] of batches.entries()) {
          const part = batches.length > 1 ? ' (' + (index + 1) + '/' + batches.length + ')' : ''
          const overflow = index === batches.length - 1 && group.omitted
            ? '\nAdditional changes in this minute: ' + group.omitted : ''
          enqueue(guild,destination,messageCard(title + part,range + batch.trimEnd() + overflow,options))
        }
      },windowMs).unref()
      groups.set(key,group = {timer,first:at,last:at,events:0,lines:[],omitted:0})
    }
    group.first = Math.min(group.first,at)
    group.last = Math.max(group.last,at)
    group.events++
    if (group.events <= 100) group.lines.push(...lines)
    else group.omitted++
  }

  client.on(Events.GuildAuditLogEntryCreate,(entry,guild) => {
    const actor = entry.executorId
    const at = entry.createdTimestamp
    const actorField = ['Changed By',actor ? mention(actor) : 'Unknown']
    if (entry.action === A.GuildUpdate) {
      if (actor === client.user?.id) return
      const keys = (entry.changes ?? []).map(change => change.key)
      const settings = keys.filter(key => !['icon_hash','name'].includes(key))
      const serverEvents = [
        ['serverLogo','Server Logo Updated',keys.includes('icon_hash') ? ['Server icon changed'] : []],
        ['serverName','Server Name Updated',keys.includes('name') ? ['Server name changed'] : []],
        ['serverUpdate','Server Settings Updated',keys.length ? settings.map(key => safeText(key.replaceAll('_',' ')).slice(0,100)) : ['Server settings changed']]
      ]
      for (const [event,title,lines] of serverEvents)
        if (lines.length) send(guild,event,title,{scope:[actor],fields:[actorField],lines,at})
      return
    }
    const route = auditRoutes.get(entry.action)
    if (!route || (route[0] !== 'memberRoles' && actor === client.user?.id)) return
    const [event,title,target] = route
    // Invite audit IDs may contain a private invite code.
    const targetId = target && /^[0-9]{17,20}$/.test(entry.targetId ?? '') ? entry.targetId : null
    if (event === 'memberRoles') {
      const lines = []
      for (const change of entry.changes ?? []) {
        if (!['$add','$remove'].includes(change.key) || !Array.isArray(change.new)) continue
        const label = change.key === '$add' ? 'Roles Added' : 'Roles Removed'
        for (let index = 0; index < change.new.length; index += 20)
          lines.push('**' + label + '** ' + change.new.slice(index,index + 20).map(role => mention(role.id,'role')).join(', '))
      }
      if (targetId) send(guild,event,title,{scope:[actor,targetId],fields:[['Member',mention(targetId)],actorField],
        lines:lines.length ? lines : ['Roles changed'],at})
      return
    }
    const reference = target === 'Channel' ? mention(targetId,'channel') + ' (' + targetId + ')' :
      target === 'Role' ? mention(targetId,'role') + ' (' + targetId + ')' : targetId
    send(guild,event,title,{scope:[actor ?? entry.id,title],fields:[actorField],
      lines:[targetId ? target + ' · ' + reference : title],at})
  })
  const messageEvent = (message,event,title) => {
    if (!message.guild || message.author?.bot || message.webhookId) return
    const author = message.author?.id
    send(message.guild,event,title,{scope:[message.channelId],fields:[['Channel',mention(message.channelId,'channel')]],
      lines:['Message ' + message.id + (author ? ' · ' + mention(author) : '')]})
  }
  client.on(Events.MessageUpdate,(before,after) => {
    if (after.editedTimestamp != null && before.editedTimestamp !== after.editedTimestamp)
      messageEvent(after,'messageEdit','Message Edited')
  })
  client.on(Events.MessageDelete,message => messageEvent(message,'messageDelete','Message Deleted'))
  client.on(Events.MessageBulkDelete,(messages,channel) => {
    const count = messages.filter(message => !message.author?.bot && !message.webhookId).size
    if (count) send(channel.guild,'messageDelete','Message Deleted',{scope:[channel.id],
      fields:[['Channel',mention(channel.id,'channel')]],lines:[count + (count === 1 ? ' message deleted in bulk' : ' messages deleted in bulk')]})
  })
  return () => {
    for (const group of groups.values()) clearTimeout(group.timer)
    groups.clear()
  }
}

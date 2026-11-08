import { AuditLogEvent as A, Events } from 'discord.js'
import { enqueueDiscordLog } from './discord-logs.js'
import { mention, messageCard } from './messages.js'

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

export function attachActivityLogging(client,db,enqueue = enqueueDiscordLog) {
  function send(guild,event,title,fields,at) {
    if (!guild) return
    const id = activityDestination(db,guild.id,event)
    if (id) enqueue(guild,id,messageCard(title,'',{fields,at}))
  }

  client.on(Events.GuildAuditLogEntryCreate,(entry,guild) => {
    if (entry.action === A.GuildUpdate) {
      if (entry.executorId === client.user?.id) return
      const keys = (entry.changes ?? []).map(change => change.key)
      const fields = [['Changed By',entry.executorId ? mention(entry.executorId) : null]]
      const serverEvents = [
        ['serverLogo','Server Logo Updated',keys.includes('icon_hash')],
        ['serverName','Server Name Updated',keys.includes('name')],
        ['serverUpdate','Server Settings Updated',!keys.length || keys.some(key => !['icon_hash','name'].includes(key))]
      ]
      for (const [event,title,changed] of serverEvents)
        if (changed) send(guild,event,title,fields,entry.createdTimestamp)
      return
    }
    const route = auditRoutes.get(entry.action)
    if (!route || (route[0] !== 'memberRoles' && entry.executorId === client.user?.id)) return
    const [event,title,target] = route
    // Invite audit IDs may contain an active invite code.
    const fields = [
      [target, target && /^\d{17,20}$/.test(entry.targetId ?? '') ? entry.targetId : null],
      ['Changed By',entry.executorId ? mention(entry.executorId) : null]
    ]
    if (event === 'memberRoles') for (const change of entry.changes ?? []) {
      if (['$add','$remove'].includes(change.key) && Array.isArray(change.new) && change.new.length)
        fields.push([change.key === '$add' ? 'Roles Added' : 'Roles Removed',change.new.map(role => mention(role.id,'role')).join(', ')])
    }
    void send(guild,event,title,fields,entry.createdTimestamp)
  })
  const messageEvent = (message,event,title) => {
    if (!message.guild || message.author?.bot || message.webhookId) return
    void send(message.guild,event,title,[
      ['Channel',mention(message.channelId,'channel')],
      ['Message ID',message.id],
      ['Author',message.author?.id ? mention(message.author.id) : null]
    ])
  }
  client.on(Events.MessageUpdate,(before,after) => {
    if (after.editedTimestamp != null && before.editedTimestamp !== after.editedTimestamp)
      messageEvent(after,'messageEdit','Message Edited')
  })
  client.on(Events.MessageDelete,message => messageEvent(message,'messageDelete','Message Deleted'))
  client.on(Events.MessageBulkDelete,(messages,channel) => {
    const count = messages.filter(message => !message.author?.bot && !message.webhookId).size
    if (count) void send(channel.guild,'messageDelete','Messages Deleted',[
      ['Channel',mention(channel.id,'channel')],['Messages',String(count)]
    ])
  })
}

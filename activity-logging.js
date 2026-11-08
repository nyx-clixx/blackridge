import { AuditLogEvent as A, Events } from 'discord.js'
import { isTextDestination } from './text-channel.js'
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
  [A.InviteUpdate,['inviteUpdate','Invite Updated']],
  [A.InviteDelete,['inviteDelete','Invite Deleted']],
  [A.GuildUpdate,['serverUpdate','Server Settings Updated']],
  [A.WebhookCreate,['webhookCreate','Webhook Created','Webhook']],
  [A.WebhookUpdate,['webhookUpdate','Webhook Updated','Webhook']],
  [A.WebhookDelete,['webhookDelete','Webhook Deleted','Webhook']]
])

export function activityDestination(db,guildId,event) {
  const config = db.config(guildId,'logging')
  return config.enabled ? config.channels[event] : undefined
}

export function attachActivityLogging(client,db) {
  const pendingMessages = new Map()
  async function send(guild,event,title,fields,at) {
    if (!guild) return
    const id = activityDestination(db,guild.id,event)
    if (!id) return
    const messageEvent = event === 'messageEdit' || event === 'messageDelete'
    const pending = pendingMessages.get(guild.id) ?? 0
    // Bound the queue when a member rapidly edits or deletes messages.
    if (messageEvent && pending >= 20) return
    if (messageEvent) pendingMessages.set(guild.id,pending + 1)
    try {
      const channel = guild.channels.cache.get(id) ?? await guild.channels.fetch(id)
      if (isTextDestination(channel) && channel.guildId === guild.id)
        await channel.send(messageCard(title,'',{fields,at}))
    } catch (error) {
      console.error('Discord activity log delivery failed:',event,error.code ?? error.name)
    } finally {
      if (messageEvent) {
        const remaining = pendingMessages.get(guild.id) - 1
        if (remaining) pendingMessages.set(guild.id,remaining)
        else pendingMessages.delete(guild.id)
      }
    }
  }

  client.on(Events.GuildAuditLogEntryCreate,(entry,guild) => {
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

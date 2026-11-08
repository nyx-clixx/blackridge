import { ChannelType } from 'discord.js'

export const isTextDestination = channel =>
  (channel?.type === ChannelType.GuildText || channel?.type === ChannelType.GuildAnnouncement) &&
  channel.isSendable()

import { readFileSync } from 'node:fs'
import { isTextDestination } from './text-channel.js'
import { standardLogEmoji } from './messages.js'
import { ComponentType as Type, PermissionFlagsBits as P, WebhookType } from 'discord.js'

const cardWeight = card => card.components[0].components.reduce((sum,component) => sum + (component.content?.length ?? 0),0)
function compactCards(queue) {
  const first = queue.shift()
  const container = first.components[0]
  const [heading,separator] = container.components
  const compatible = card => card?.components.length === 1 && !card.allowedMentions.roles.length &&
    card.components[0].components[0]?.content === heading.content &&
    card.components[0].components[1]?.type === Type.Separator &&
    card.components[0].components.slice(2).every(component => component.type === Type.TextDisplay)
  if (!compatible(first) || !compatible(queue[0])) return first
  const line = card => card.components[0].components.slice(2).map(component =>
    component.content.replace(/^-# /,'').replaceAll('\n',' · ')).join(' · ')
  const rows = [line(first)]
  let length = rows[0].length + 3
  while (compatible(queue[0])) {
    const row = line(queue[0])
    if (length + row.length + 3 > 3000) break
    queue.shift()
    rows.push(row)
    length += row.length + 3
  }
  if (rows.length === 1) return first
  return {...first,components:[{...container,components:[heading,separator,
    {type:Type.TextDisplay,content:rows.map(row => '• ' + row).join('\n')}]}]}
}

const webhookAvatar = readFileSync(new URL('./public/blackridge-icon.png',import.meta.url))
const webhookName = 'Blackridge Logs'
const permanentWebhookErrors = new Set([10015,50001,50013,50027])

export function createLogDispatcher(delay = 1500) {
  const clients = new WeakMap()

  async function deliver(guild,id,state,items) {
    const channel = state.resolveChannel ? await state.resolveChannel(guild,id) :
      guild.channels.cache.get(id) ?? await guild.channels.fetch(id)
    if (!isTextDestination(channel) || channel.guildId !== guild.id) return
    const permissions = channel.permissionsFor?.(guild.members.me)
    if (permissions && !permissions.has(P.ViewChannel | P.SendMessages)) return
    const payload = {flags:items[0].flags,components:items.flatMap(item => item.components),
      allowedMentions:{parse:[],roles:[...new Set(items.flatMap(item => item.allowedMentions.roles))]}}
    const mainAppId = process.env.DISCORD_CLIENT_ID
    const forSender = sender => sender && sender === mainAppId ? payload :
      {...payload,components:standardLogEmoji(payload.components)}
    if (permissions && !permissions.has(P.ManageWebhooks)) { await channel.send(forSender(guild.client.user.id)); return }
    if (state.resolveChannel) state.webhook = null
    try {
      if (!state.webhook && Date.now() >= state.retryAt && channel.fetchWebhooks && channel.createWebhook) {
        const hooks = await channel.fetchWebhooks()
        const existing = hooks.find(hook => hook.name === webhookName && hook.type === WebhookType.Incoming &&
          hook.owner?.id === guild.client.user.id && hook.channelId === id && hook.token) ??
          null
        state.webhook = existing ?? await channel.createWebhook({name:webhookName,avatar:webhookAvatar,reason:'Blackridge Discord log delivery'})
        if (existing && !existing.avatar && existing.edit && Date.now() >= state.avatarRetryAt) {
          state.avatarRetryAt = Date.now() + 60000
          try { state.webhook = await existing.edit({avatar:webhookAvatar}) } catch { /* Branding must not interrupt delivery. */ }
        }
      }
      if (state.webhook?.token) {
        await state.webhook.send({...forSender(state.webhook.applicationId),withComponents:true})
        return
      }
    } catch (error) {
      if (!permanentWebhookErrors.has(error.code)) throw error
      state.webhook = null
      state.retryAt = Date.now() + 60000
    }
    await channel.send(forSender(guild.client.user.id))
  }

  return function enqueue(guild,id,card,resolveChannel) {
    if (!id) return
    let destinations = clients.get(guild.client)
    if (!destinations) clients.set(guild.client,destinations = new Map())
    const key = guild.id + ':' + id + (resolveChannel ? ':private' : '')
    let state = destinations.get(key)
    if (!state) {
      if (destinations.size >= 512) {
        const idle = [...destinations].find(([,value]) => !value.busy && !value.queue.length)
        if (!idle) return
        destinations.delete(idle[0])
      }
      destinations.set(key,state = {queue:[],busy:false,retryAt:0,avatarRetryAt:0,dropped:0,resolveChannel})
    }
    if (state.queue.length >= 100) { state.dropped++; return }
    state.queue.push(card)
    if (state.busy) return
    state.busy = true

    const schedule = () => setTimeout(async () => {
      const batch = [compactCards(state.queue)]
      let size = cardWeight(batch[0])
      let components = batch[0].components[0].components.length + 1
      while (state.queue.length && batch.length < 5) {
        const next = state.queue[0]
        const count = next.components[0].components.length + 1
        const length = cardWeight(next)
        if (size + length > 4000 || components + count > 40) break
        batch.push(state.queue.shift())
        size += length
        components += count
      }
      try { await deliver(guild,id,state,batch) }
      catch (error) { console.error('Discord log delivery failed:',error.code ?? error.name) }
      if (state.queue.length) schedule()
      else {
        if (state.dropped) console.error('Discord log queue overflow:',state.dropped)
        state.dropped = 0
        state.busy = false
      }
    },delay).unref()
    schedule()
  }
}

export const enqueueDiscordLog = createLogDispatcher()

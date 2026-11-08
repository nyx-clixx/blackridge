import { isTextDestination } from './text-channel.js'
import { PermissionFlagsBits as P, WebhookType } from 'discord.js'

const cardWeight = card => card.components[0].components.reduce((sum,component) => sum + (component.content?.length ?? 0),0)
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
    if (permissions && !permissions.has(P.ManageWebhooks)) { await channel.send(payload); return }
    if (state.resolveChannel) state.webhook = null
    try {
      if (!state.webhook && Date.now() >= state.retryAt && channel.fetchWebhooks && channel.createWebhook) {
        const hooks = await channel.fetchWebhooks()
        state.webhook = hooks.find(hook => hook.name === webhookName && hook.type === WebhookType.Incoming &&
          hook.owner?.id === guild.client.user.id && hook.channelId === id && hook.token) ??
          await channel.createWebhook({name:webhookName,reason:'Blackridge Discord log delivery'})
      }
      if (state.webhook?.token) {
        await state.webhook.send({...payload,withComponents:true})
        return
      }
    } catch (error) {
      if (!permanentWebhookErrors.has(error.code)) throw error
      state.webhook = null
      state.retryAt = Date.now() + 60000
    }
    await channel.send(payload)
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
      destinations.set(key,state = {queue:[],busy:false,retryAt:0,dropped:0,resolveChannel})
    }
    if (state.queue.length >= 100) { state.dropped++; return }
    state.queue.push(card)
    if (state.busy) return
    state.busy = true

    const schedule = () => setTimeout(async () => {
      const batch = [state.queue.shift()]
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

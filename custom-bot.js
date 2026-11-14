import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { ActivityType, ApplicationFlagsBitField, Events } from 'discord.js'
import { z } from 'zod'
import { createBotClient, mountBot, requiredPermissions } from './bot.js'
import { syncModerationCommands } from './moderation.js'

const keyName = 'customBot'
const activities = {playing:ActivityType.Playing,listening:ActivityType.Listening,watching:ActivityType.Watching,competing:ActivityType.Competing}
export const profilePolicy = z.strictObject({
  username:z.string().trim().min(2).max(32),bio:z.string().trim().max(400).optional(),
  status:z.enum(['online','idle','dnd','invisible']),
  activityType:z.enum(['none',...Object.keys(activities)]),activity:z.string().trim().max(100)
}).refine(value => value.activityType === 'none' || value.activity.length > 0)
const error = message => Object.assign(new Error(message),{status:400})

export function missingPrivilegedIntents(flags) {
  const enabled = new ApplicationFlagsBitField(flags ?? 0)
  const F = ApplicationFlagsBitField.Flags
  return [
    ['Presence Intent', F.GatewayPresence, F.GatewayPresenceLimited],
    ['Server Members Intent', F.GatewayGuildMembers, F.GatewayGuildMembersLimited],
    ['Message Content Intent', F.GatewayMessageContent, F.GatewayMessageContentLimited]
  ].filter(([,full,limited]) => !enabled.any(full | limited)).map(([name]) => name)
}

export function customBots(db,shared,key,makeClient = createBotClient) {
  const clients = new Map()
  const busy = new Map()
  const eligible = (id,owner) => db.guildPlan(id) === 'custom' && shared()?.guilds.cache.get(id)?.ownerId === owner
  function seal(id,token) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm',key,iv)
    cipher.setAAD(Buffer.from(id))
    const encrypted = Buffer.concat([cipher.update(token,'utf8'),cipher.final()])
    return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url')
  }
  function open(id,stored) {
    const bytes = Buffer.from(stored,'base64url')
    const cipher = createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12))
    cipher.setAAD(Buffer.from(id))
    cipher.setAuthTag(bytes.subarray(12,28))
    return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8')
  }
  const presence = (client,profile) => client.user.setPresence({status:profile.status,activities:profile.activityType === 'none' ? [] :
    [{type:activities[profile.activityType],name:profile.activity}]})
  const active = id => {
    const item = clients.get(id)
    const guild = item?.client.isReady() && item.client.guilds.cache.get(id)
    return guild?.available && item.client.guilds.cache.size === 1 && eligible(id,item.owner) &&
      guild.members.me?.permissions.has(requiredPermissions) ? guild : null
  }
  async function exclusive(id,operation) {
    const next = (busy.get(id) ?? Promise.resolve()).catch(() => {}).then(operation)
    busy.set(id,next)
    try { return await next } finally { if (busy.get(id) === next) busy.delete(id) }
  }
  async function restoreShared(id) {
    const guild = shared()?.guilds.cache.get(id)
    if (guild?.available) await syncModerationCommands(guild,db).catch(() => console.error('Shared command refresh failed'))
  }
  async function disconnect(id) {
    const item = clients.get(id)
    clients.delete(id)
    if (item) {
      const guild = item.client.guilds.cache.get(id)
      if (guild?.available) await syncModerationCommands(guild,db,true).catch(() => {})
      item.stop()
      await item.client.destroy()
    }
    await restoreShared(id)
  }
  async function check(id,owner,token) {
    if (!key || !eligible(id,owner)) throw error('Custom Bot is unavailable for this server.')
    const response = await fetch('https://discord.com/api/v10/oauth2/applications/@me',{headers:{Authorization:'Bot '+token},signal:AbortSignal.timeout(8000),redirect:'error'})
      .catch(() => { throw error('Could not verify the bot with Discord.') })
    if (!response.ok) throw error('Discord rejected this bot token.')
    const app = await response.json()
    if ((app.team?.owner_user_id ?? app.owner?.id) !== owner) throw error('The Discord application must belong to the server owner.')
    if (app.id === shared()?.user?.id) throw error('Use your own Discord application.')
    if ([...clients].some(([guild,item]) => guild !== id && item.client.user?.id === app.id))
      throw error('This application is already connected to another server.')
    const missingIntents = missingPrivilegedIntents(app.flags)
    const params = new URLSearchParams({client_id:app.id,guild_id:id,disable_guild_select:'true',
      integration_type:'0',scope:'bot applications.commands',permissions:String(requiredPermissions)})
    return {missingIntents,installUrl:missingIntents.length ? null : 'https://discord.com/oauth2/authorize?' + params}
  }
  async function connect(id,owner,token,stored) {
    const currentRecord = db.recovery(id,keyName)
    if (!stored && active(id) && currentRecord?.owner === owner) {
      try { if (open(id,currentRecord.secret) === token) return }
      catch { /* A fresh token can replace an unreadable stored credential. */ }
    }
    const {missingIntents} = await check(id,owner,token)
    // Keep legacy installations working with their original gateway options.
    if ((!stored || stored.intentsChecked) && missingIntents.length)
      throw error('Enable these intents in the Discord Developer Portal: ' + missingIntents.join(', ') + '.')
    const intentsChecked = !missingIntents.length
    const client = makeClient({messageContent:intentsChecked || process.env.ENABLE_MESSAGE_CONTENT === 'true'})
    client.on(Events.Error,() => console.error('Custom Discord client error'))
    let timeout,stop
    try {
      const ready = new Promise(resolve => client.once(Events.ClientReady,resolve))
      const deadline = new Promise((_,reject) => { timeout = setTimeout(() => reject(error('Discord did not connect the bot. Check the token and gateway intents.')),15000) })
      await Promise.race([Promise.all([client.login(token),ready]),deadline]).catch(() => {
        throw error('Discord did not connect the bot. Check the token and gateway intents.')
      })
      const guild = client.guilds.cache.get(id)
      if (!guild?.available || client.guilds.cache.size !== 1) throw error('Install the custom bot in this server only, then try again.')
      if (!guild.members.me?.permissions.has(requiredPermissions)) throw error('Grant the custom bot the same server permissions as Blackridge, then try again.')
      const current = clients.get(id)
      const profile = (stored ?? currentRecord)?.profile ?? {status:'online',activityType:'none',activity:''}
      const sharedGuild = shared().guilds.cache.get(id)
      stop = mountBot(client,db,guildId => guildId === id && active(id)?.client === client)
      presence(client,profile)
      db.saveRecovery(id,keyName,{owner,secret:stored?.secret ?? seal(id,token),profile,intentsChecked})
      const item = {owner,client,stop,sharedEnabled:true,syncing:true}
      clients.set(id,item)
      void client.user.fetch(true).catch(() => {})
      if (current) {
        current.stop()
        const oldGuild = current.client.guilds.cache.get(id)
        const cleanup = oldGuild?.available && current.client.user.id !== client.user.id
          ? syncModerationCommands(oldGuild,db,true) : Promise.resolve()
        void cleanup.catch(() => {}).finally(() => current.client.destroy()).catch(() => {})
      }
      // The dashboard is ready once the gateway and policy checks pass. Discord
      // can queue command writes independently of the gateway connection.
      void syncModerationCommands(guild,db).then(async () => {
        if (clients.get(id) !== item || !active(id) || !sharedGuild?.available) return
        await syncModerationCommands(sharedGuild,db,true)
        if (clients.get(id) === item) item.sharedEnabled = false
      }).catch(() => console.error('Custom Bot command refresh failed')).finally(() => { item.syncing = false })
    } catch (failure) {
      stop?.()
      await client.destroy()
      if (failure.status === 400) throw failure
      console.error('Custom Bot startup failed:',failure.name,Number(failure.code) || '',Number(failure.status) || '')
      throw error('Discord could not start this custom bot.')
    } finally { clearTimeout(timeout) }
  }
  const retry = new Map()
  const timer = setInterval(async () => {
    if (!key || !shared()?.isReady()) return
    for (const [id,item] of clients) {
      if (busy.has(id)) continue
      if (!eligible(id,item.owner) || (item.client.isReady() && item.client.guilds.cache.size !== 1))
        await exclusive(id,() => disconnect(id)).catch(() => {})
      else if (!item.syncing && item.sharedEnabled === Boolean(active(id))) {
        item.syncing = true
        const fallback = !active(id)
        const refresh = async () => {
          if (!fallback) await syncModerationCommands(item.client.guilds.cache.get(id),db)
          if (clients.get(id) !== item || fallback === Boolean(active(id))) return
          await syncModerationCommands(shared().guilds.cache.get(id),db,!fallback)
          item.sharedEnabled = fallback
        }
        void refresh().catch(() => console.error('Could not refresh fallback commands')).finally(() => { item.syncing = false })
      }
    }
    for (const {guild:id} of db.recoveries(keyName)) {
      if (clients.has(id) || busy.has(id) || (retry.get(id) ?? 0) > Date.now()) continue
      const record = db.recovery(id,keyName)
      if (!record || !eligible(id,record.owner)) continue
      retry.set(id,Date.now()+300000)
      await exclusive(id,() => connect(id,record.owner,open(id,record.secret),record)).catch(() => console.error('Custom bot reconnect failed'))
    }
  },15000)
  timer.unref()
  return {
    active,exclusive,check,
    health() {
      const configured = db.recoveries(keyName).filter(({guild}) => {
        const record = db.recovery(guild,keyName)
        return record && eligible(guild,record.owner)
      })
      return Boolean(key && shared()?.isReady() && configured.every(({guild}) => active(guild)))
    },
    connect:(id,owner,token) => connect(id,owner,token),
    async remove(id) { db.clearRecovery(id,keyName); await disconnect(id) },
    state(id,owner) {
      const record = db.recovery(id,keyName)
      const client = active(id)?.client
      const user = client?.user
      return {configured:Boolean(record?.owner === owner),connected:Boolean(user),username:user?.username ?? '',
        avatar:user?.displayAvatarURL(),banner:user?.bannerURL(),bio:client?.application?.description ?? '',profile:record?.owner === owner ? record.profile : null}
    },
    async profile(id,profile) {
      const client = active(id)?.client
      if (!client) throw error('Connect your custom bot first.')
      if (client.user.username !== profile.username) await client.user.setUsername(profile.username)
      if (profile.bio !== undefined && profile.bio !== client.application.description) await client.application.edit({description:profile.bio})
      presence(client,profile)
      db.saveRecovery(id,keyName,{...db.recovery(id,keyName),profile:{status:profile.status,activityType:profile.activityType,activity:profile.activity}})
    },
    async image(id,field,body) {
      const client = active(id)?.client
      if (!client) throw error('Connect your custom bot first.')
      if (!Buffer.isBuffer(body)) throw error('Upload a PNG, JPEG, or WebP image.')
      const type = body.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) ? 'png' :
        body.subarray(0,3).equals(Buffer.from('ffd8ff','hex')) ? 'jpeg' :
        body.toString('ascii',0,4) === 'RIFF' && body.toString('ascii',8,12) === 'WEBP' ? 'webp' : null
      if (!type) throw error('Upload a PNG, JPEG, or WebP image.')
      await client.user.edit({[field]:'data:image/'+type+';base64,'+body.toString('base64')})
    },
    close() {
      clearInterval(timer)
      for (const item of clients.values()) { item.stop(); void item.client.destroy() }
    }
  }
}

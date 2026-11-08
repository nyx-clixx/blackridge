import { resources } from './public/resources.js'
import { premiumPlans } from './public/plans.js'
import { stripeBilling } from './billing.js'
import { billingError } from './billing-store.js'
import express from 'express'
import helmet from 'helmet'
import { randomBytes, createHash, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { ChannelType, PermissionFlagsBits as P } from 'discord.js'
import { messageCard } from './messages.js'
import { createStore, matchesPermit, policies, premiumFilters, premiumGuards } from './store.js'
import { customBots, profilePolicy } from './custom-bot.js'
import { startBot, requiredPermissions } from './bot.js'
import { publishVerification } from './verification.js'
import { canReviewAppeals, privateAppealChannel, reviewBanAppeal } from './appeals.js'
import { recoveryTools, hasQuarantineOverwrite } from './recovery.js'
import { syncModerationCommands } from './moderation.js'

const {DISCORD_CLIENT_ID: clientId, DISCORD_CLIENT_SECRET: clientSecret, DISCORD_BOT_TOKEN: botToken} = process.env
const port = Number(process.env.PORT || 3000)
const base = new URL(process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'http://localhost:' + port)).origin
const redirect = base + '/auth/callback'
const configured = Boolean(clientId && clientSecret)
const app = express()
const db = createStore(process.env.DB_PATH || './data/blackridge.sqlite')
const billing = stripeBilling(db.billing,base)
let custom
const bot = botToken && startBot(botToken,db,id => !custom?.active(id))
custom = customBots(db,() => bot,configured ? scryptSync(clientSecret,'blackridge custom bot credentials v1',32) : null)
const activeGuild = id => custom.active(id) ?? bot.guilds.cache.get(id)
const recovery = recoveryTools(db,bot && {guilds:{cache:{get:activeGuild}},isReady:() => bot.isReady()})
const states = new Map()
const guildLists = new Map()
const sessionKey = configured ? scryptSync(clientSecret,'blackridge web session v1',32) : null
const sessionId = token => createHash('sha256').update(token ?? '').digest('hex')
function sealSession(data) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm',sessionKey,iv)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data),'utf8'),cipher.final()])
  return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url')
}
function openSession(token) {
  if (!token || !sessionKey) return null
  const stored = db.session(sessionId(token))
  if (!stored) return null
  try {
    const bytes = Buffer.from(stored,'base64url')
    const cipher = createDecipheriv('aes-256-gcm',sessionKey,bytes.subarray(0,12))
    cipher.setAuthTag(bytes.subarray(12,28))
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8'))
  } catch { return null }
}
const idPattern = /^\d{17,20}$/
const nonce = () => randomBytes(32).toString('base64url')
const cookieOptions = {httpOnly:true,secure:base.startsWith('https:'),sameSite:'lax',path:'/'}
const cookie = (req,key) => req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(key + '='))?.slice(key.length+1)
const prune = () => {
  for (const [key,value] of states) if (value.until <= Date.now()) states.delete(key)
  for (const [key,value] of guildLists) if (value.until <= Date.now()) guildLists.delete(key)
  db.prune()
}
setInterval(prune,60000).unref()
prune()

app.disable('x-powered-by')
app.use(helmet({
  contentSecurityPolicy:{directives:{imgSrc:["'self'",'https://cdn.discordapp.com'],upgradeInsecureRequests:base.startsWith('https:') ? [] : null}},
  strictTransportSecurity:base.startsWith('https:'),
  referrerPolicy:{policy:'no-referrer'}
}))
app.use(['/api','/auth'], (req,res,next) => {
  res.set('Cache-Control','no-store')
  if (['PUT','POST'].includes(req.method) && req.get('origin') !== base) return res.status(403).json({error:'Invalid request origin.'})
  next()
})
app.post('/webhooks/stripe',express.raw({type:'application/json',limit:'256kb'}),async (req,res) => {
  try {
    await billing.webhook(req.body,req.get('stripe-signature'))
    res.sendStatus(204)
  } catch (error) {
    if (error.status === 400 || error.status === 503) return res.sendStatus(error.status)
    console.error('Stripe webhook processing failed:',error.type ?? error.name)
    res.sendStatus(500)
  }
})
app.use(express.json({limit:'32kb'}))
async function discord(path,options = {}) {
  const response = await fetch('https://discord.com/api/v10' + path,{...options,signal:AbortSignal.timeout(8000)})
  if (response.status === 401) throw Object.assign(new Error('Discord session expired. Sign in again.'),{status:401})
  if (response.status === 429) throw Object.assign(new Error('Discord is limiting server-list requests. Try again shortly.'),{status:503})
  if (!response.ok) throw Object.assign(new Error('Discord is temporarily unavailable.'),{status:503})
  return response.json()
}

app.get('/healthz',(req,res) => res.json({ok:true,botConnected:Boolean(bot && bot.isReady()),oauthConfigured:configured,billingConfigured:billing.enabled}))
app.get('/auth/login',(req,res) => {
  if (!configured) return res.redirect('/dashboard')
  if (states.size >= 2000) return res.status(429).send('Sign-in capacity reached. Please retry shortly.')
  const state = nonce()
  states.set(state,{until:Date.now()+300000})
  res.cookie('br_oauth',state,{...cookieOptions,maxAge:300000})
  const query = new URLSearchParams({client_id:clientId,redirect_uri:redirect,response_type:'code',scope:'identify guilds',state})
  res.redirect('https://discord.com/oauth2/authorize?' + query)
})
app.get('/auth/callback',async (req,res) => {
  const {code,state} = req.query
  const stored = states.get(state)
  if (!configured || typeof code !== 'string' || typeof state !== 'string' || state !== cookie(req,'br_oauth') || !stored || stored.until <= Date.now()) return res.redirect('/dashboard?auth=failed')
  states.delete(state)
  res.clearCookie('br_oauth',cookieOptions)
  try {
    const data = new URLSearchParams({client_id:clientId,client_secret:clientSecret,grant_type:'authorization_code',code,redirect_uri:redirect})
    const token = await discord('/oauth2/token',{method:'POST',body:data})
    const headers = {Authorization:'Bearer ' + token.access_token}
    const user = await discord('/users/@me',{headers})
    const key = nonce()
    const maxAge = Math.min(token.expires_in*1000,8*3600000)
    if (db.sessionCount() >= 10000) return res.status(503).send('Session capacity reached.')
    db.deleteSession(sessionId(cookie(req,'br_session')))
    const until = Date.now()+maxAge
    db.saveSession(sessionId(key),sealSession({headers,user:{id:user.id,username:user.global_name || user.username,avatar:user.avatar},until}),until)
    res.cookie('br_session',key,{...cookieOptions,maxAge})
    res.redirect('/dashboard')
  } catch { res.redirect('/dashboard?auth=failed') }
})
app.post('/auth/logout',(req,res) => {
  const key = sessionId(cookie(req,'br_session'))
  db.deleteSession(key)
  guildLists.delete(key)
  res.clearCookie('br_session',cookieOptions).json({ok:true})
})
app.get('/invite',(req,res) => {
  if (!clientId) return res.redirect('/dashboard')
  const query = new URLSearchParams({client_id:clientId,scope:'bot',permissions:String(requiredPermissions)})
  if (typeof req.query.guild === 'string' && idPattern.test(req.query.guild)) {
    query.set('guild_id',req.query.guild)
    query.set('disable_guild_select','true')
  }
  res.redirect('https://discord.com/oauth2/authorize?' + query)
})
app.use('/api',(req,res,next) => {
  const session = openSession(cookie(req,'br_session'))
  if (session?.until > Date.now()) req.session = session
  next()
})
const supportInvite = 'https://discord.gg/cVbMthkkph'
app.get('/api/me',(req,res) => res.json({configured,supportInvite,user:req.session?.user ?? null}))

async function visibleGuilds(req) {
  if (!req.session) throw Object.assign(new Error('Sign in with Discord.'),{status:401})
  const session = req.session
  const key = sessionId(cookie(req,'br_session'))
  const cached = guildLists.get(key)
  if (cached?.until > Date.now()) return cached.request
  const entry = {until:Date.now()+30000}
  entry.request = (async () => {
    const list = []
    let after = '0'
    for (;;) {
      const page = await discord('/users/@me/guilds?limit=200&after=' + after,{headers:session.headers})
      for (const entry of page) {
        if (entry.owner) { list.push(entry); continue }
        const guild = bot?.guilds.cache.get(entry.id)
        if (!guild?.available || !dashboardGrants(guild.id).length) continue
        const member = await guild.members.fetch({user:session.user.id,force:true}).catch(() => null)
        if (member && canOpenDashboard(guild,member)) list.push(entry)
      }
      if (page.length < 200) break
      const next = page.reduce((highest,guild) => BigInt(guild.id) > BigInt(highest) ? guild.id : highest,after)
      if (next === after) throw new Error('Discord guild pagination stalled.')
      after = next
    }
    return list
  })()
  guildLists.set(key,entry)
  try { return await entry.request }
  catch (error) {
    if (guildLists.get(key) === entry) guildLists.delete(key)
    throw error
  }
}
function dashboardGrants(id) {
  const permits = db.config(id,'permits')
  return permits.enabled ? permits.entries.filter(entry => entry.dashboardAccess) : []
}
function canOpenDashboard(guild,member) {
  return guild.ownerId === member.id || dashboardGrants(guild.id).some(entry => matchesPermit(entry,member.id,guild.id,member.roles.cache))
}
app.post('/api/billing/:guild/portal',async (req,res) => {
  if (!req.session) throw billingError('Sign in with Discord.',401)
  if (!idPattern.test(req.params.guild)) throw billingError('Server not found.',404)
  const url = await billing.portal(req.params.guild,req.session.user.id,req.body?.action ?? 'manage')
  res.json({url})
})
app.get('/api/billing',(req,res) => {
  if (!req.session) throw billingError('Sign in with Discord.',401)
  const subscriptions = db.billing.owned(req.session.user.id).map(row => ({
    guild:row.guild,plan:row.plan,name:bot?.guilds.cache.get(row.guild)?.name ?? 'Server ' + row.guild
  }))
  res.json({enabled:billing.enabled,subscriptions})
})
app.get('/api/guilds',async (req,res) => {
  const guilds = await visibleGuilds(req)
  res.json({guilds:guilds.map(({id,name,icon,owner}) => ({id,name,icon,owner,plan:db.guildPlan(id),installed:Boolean(bot && bot.guilds.cache.has(id))}))})
})
app.use('/api/guilds/:id',async (req,res,next) => {
  if (!idPattern.test(req.params.id)) return res.status(404).json({error:'Server not found.'})
  if (!req.session) return res.status(401).json({error:'Sign in with Discord.'})
  if (!bot?.isReady()) return res.status(503).json({error:'Blackridge is reconnecting to Discord. Try again shortly.'})
  const guild = bot.guilds.cache.get(req.params.id)
  if (!guild?.available) return res.status(404).json({error:'Blackridge is unavailable for this server.'})
  let member
  try { member = await guild.members.fetch({user:req.session.user.id,force:true}) }
  catch (error) {
    if (error.code !== 10007) throw Object.assign(new Error('Could not verify server access with Discord. Try again shortly.'),{status:503})
  }
  if (!member || !canOpenDashboard(guild,member)) {
    return res.status(404).json({error:'Blackridge is unavailable for this server.'})
  }
  req.guild = {id:guild.id,name:guild.name,owner:guild.ownerId === member.id,appealsManager:canReviewAppeals(guild,member,db)}
  next()
})
app.get('/api/guilds/:id/billing',(req,res) => {
  if (!req.guild.owner) return res.status(403).json({error:'Only the server owner can access this section.'})
  const {id,owner} = req.guild
  const actor = req.session.user.id
  const row = db.billing.current(id)
  const manages = row?.owner === actor
  const remaining = manages ? db.billing.remaining(actor) : 0
  const eligible = manages && owner && !row.risk && row.status === 'active' && row.paid_until > Date.now()
  const targets = eligible && remaining ? [...bot.guilds.cache.values()].filter(guild =>
    guild.available && guild.id !== id && guild.ownerId === actor && db.billing.available(guild.id)
  ).map(({id,name}) => ({id,name})) : []
  res.json({enabled:billing.enabled,purchasable:owner && (!row && db.guildPlan(id) === 'free'),
    subscription:manages ? {plan:row.plan,status:row.status,paidUntil:row.paid_until,cancelAt:row.cancel_at,review:Boolean(row.risk)} : null,
    remaining,targets})
})
app.post('/api/guilds/:id/billing/checkout',async (req,res) => {
  if (!req.guild.owner) throw billingError('Only the server owner can subscribe.',403)
  const url = await billing.checkout(req.guild.id,req.session.user.id,req.body?.plan)
  res.json({url})
})
app.post('/api/guilds/:id/billing/transfer',async (req,res) => {
  const actor = req.session.user.id
  const {id,owner} = req.guild
  const targetId = req.body?.target
  const target = typeof targetId === 'string' && idPattern.test(targetId) ? bot.guilds.cache.get(targetId) : null
  if (!owner || !target?.available || target.ownerId !== actor) throw billingError('You must own both servers and have Blackridge installed.',403)
  const sub = db.billing.current(id)
  if (!sub || sub.owner !== actor) throw billingError('Only the billing owner can transfer this subscription.',403)
  await billing.refresh(sub.id)
  if (bot.guilds.cache.get(id)?.ownerId !== actor || bot.guilds.cache.get(targetId)?.ownerId !== actor)
    throw billingError('You must own both servers.',403)
  db.billing.move(id,targetId,actor)
  db.event(id,'billing','Subscription transferred out by ' + actor)
  db.event(targetId,'billing','Subscription transferred in by ' + actor)
  res.json({remaining:db.billing.remaining(actor)})
})
app.get('/api/guilds/:id',(req,res) => {
  const {id,name,owner} = req.guild
  const guild = activeGuild(id)
  const config = Object.fromEntries(Object.keys(policies).filter(kind => owner || !['permits','appeals'].includes(kind)).map(kind => [kind,db.config(id,kind)]))
  const me = guild.members.me
  const highest = guild.roles?.highest
  const quarantine = db.recovery(id,'quarantineRole')?.role
  const security = {
    nuke:config.nuke.enabled,raid:config.raid.enabled,checkpoint:config.checkpoint.enabled,
    quarantine:Boolean(quarantine && guild.roles?.cache.get(quarantine)?.editable &&
      guild.roles.cache.get(quarantine).permissions.bitfield === 0n &&
      [...guild.channels.cache.values()].filter(channel => channel.permissionOverwrites).every(channel => hasQuarantineOverwrite(channel,guild.roles.cache.get(quarantine)))),
    priority:Boolean(me && highest && me.roles.highest.id === highest.id),
    admin:Boolean(me?.permissions.has('Administrator'))
  }
  const plan = db.guildPlan(id)
  if (plan === 'free') config.backup = {...config.backup,enabled:false}
  res.json({name,owner,appealsManager:req.guild.appealsManager,appealsConfigured:req.guild.appealsManager && Boolean(db.config(id,'appeals').channel),customConnected:owner && Boolean(custom.active(id)),icon:guild.icon ?? null,config,security,plan,lockdownActive:Boolean(db.recovery(id,'lockdown')),backupsScheduled:plan !== 'free' && Boolean(db.recovery(id,'backupSchedule'))})
})
function customAccess(req,res,next) {
  if (!req.guild.owner || db.guildPlan(req.guild.id) !== 'custom') return res.status(403).json({error:'Custom Bot requires the Custom Bot plan and server ownership.'})
  next()
}
app.get('/api/guilds/:id/custom-bot',customAccess,(req,res) => res.json(custom.state(req.guild.id,req.session.user.id)))
function customBotToken(req,res,next) {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : ''
  if (!/^[a-zA-Z0-9_-]{15,40}\.[a-zA-Z0-9_-]{4,20}\.[a-zA-Z0-9_-]{15,100}$/.test(token)) return res.status(400).json({error:'Enter a Discord bot token.'})
  req.botToken = token
  next()
}
app.post('/api/guilds/:id/custom-bot/check',customAccess,customBotToken,async (req,res) => {
  res.json(await custom.check(req.guild.id,req.session.user.id,req.botToken))
})
app.post('/api/guilds/:id/custom-bot',customAccess,customBotToken,async (req,res) => {
  await custom.exclusive(req.guild.id,() => custom.connect(req.guild.id,req.session.user.id,req.botToken))
  res.json(custom.state(req.guild.id,req.session.user.id))
})
app.post('/api/guilds/:id/custom-bot/disconnect',customAccess,async (req,res) => {
  await custom.exclusive(req.guild.id,() => custom.remove(req.guild.id))
  res.json({ok:true})
})
app.put('/api/guilds/:id/custom-bot/profile',customAccess,async (req,res) => {
  const parsed = profilePolicy.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({error:'Check the username, status, and activity settings.'})
  await custom.exclusive(req.guild.id,() => custom.profile(req.guild.id,parsed.data))
  res.json(custom.state(req.guild.id,req.session.user.id))
})
app.put('/api/guilds/:id/custom-bot/image/:field',customAccess,express.raw({type:['image/png','image/jpeg','image/webp'],limit:'3mb'}),async (req,res) => {
  const {field} = req.params
  if (!['avatar','banner'].includes(field)) return res.status(400).json({error:'Choose an avatar or banner.'})
  await custom.exclusive(req.guild.id,() => custom.image(req.guild.id,field,req.body))
  res.json(custom.state(req.guild.id,req.session.user.id))
})
app.get('/api/guilds/:id/analytics',(req,res) => {
  const period = req.query.period ?? 'week'
  if (!['day','week','month','year'].includes(period)) return res.status(400).json({error:'Choose a valid analytics period.'})
  res.json(db.analytics.range(req.guild.id,period))
})
app.get('/api/guilds/:id/events',async (req,res) => {
  const events = db.recent(req.guild.id,req.query.kind).map(event => {
    const pattern = event.kind === 'moderation' ? /\bmoderator (\d{17,20})\b/
      : /(?:\b(?:by|from|out|for|flagged|author|quarantined) |\bmember )(\d{17,20})\b/i
    const initiator = event.kind === 'lockdown' || event.kind === 'backup' ? event.detail.match(/ · initiated by (\d{17,20})$/)?.[1] : null
    return {...event,userId:initiator ?? event.detail.match(pattern)?.[1] ?? null}
  })
  const missing = [...new Set(events.map(event => event.userId).filter(id => id && !bot.users.cache.has(id)))].slice(0,8)
  await Promise.allSettled(missing.map(id => bot.users.fetch(id)))
  res.json({events:events.map(event => {
    const user = event.userId && bot.users.cache.get(event.userId)
    return {...event,userName:user?.username ?? null,avatar:user?.avatar ?? null}
  })})
})
const honeyPotUpdates = new Set()
async function saveHoneyPot(req,res,config) {
  const {id} = req.guild
  if (honeyPotUpdates.has(id)) return res.status(409).json({error:'A Honeypot update is already in progress.'})
  honeyPotUpdates.add(id)
  try {
    const guild = activeGuild(id)
    const previous = db.config(id,'honeypot')
    let panelId = ''
    let createdPanel
    if (config.enabled) {
      if (!config.channel || config.channel === config.alertChannel)
        return res.status(400).json({error:'Choose a bait channel and keep any log channel separate.'})
      const channel = await guild?.channels.fetch(config.channel).catch(() => null)
      if (channel?.type !== ChannelType.GuildText || channel.guildId !== id)
        return res.status(400).json({error:'Choose a text channel in this server.'})
      const actions = config.actions ?? [config.action]
      if (!actions.length || actions.filter(action => ['ban','kick','timeout'].includes(action)).length > 1)
        return res.status(400).json({error:'Choose at least one response and at most one timeout, kick, or ban.'})
      const permission = {timeout:P.ModerateMembers,kick:P.KickMembers,ban:P.BanMembers}[actions.find(action => ['timeout','kick','ban'].includes(action))]
      const permissions = channel.permissionsFor(guild.members.me)
      if (!permissions?.has([P.ViewChannel,P.SendMessages,P.ReadMessageHistory]) ||
          (actions.includes('delete') && !permissions.has(P.ManageMessages)) || (permission && !guild.members.me.permissions.has(permission)))
        return res.status(400).json({error:'Blackridge needs access to the bait channel and permission to perform the selected response.'})
      let panel
      if (previous.channel === config.channel && previous.panelId) {
        panel = await channel.messages.fetch(previous.panelId).catch(error => {
          if (error.code !== 10008) throw error
          return null
        })
      }
      if (panel?.author.id !== guild.client.user.id) {
        panel = createdPanel = await channel.send(messageCard('Honeypot · Do Not Post',
          'This channel is a security trap. Posting here can trigger automatic moderation. Please use another channel.',{icon:'warning'}))
      }
      panelId = panel.id
    }
    try { db.save(id,'honeypot',{...config,panelId},req.session.user.id) }
    catch (error) {
      await createdPanel?.delete().catch(() => {})
      throw error
    }
    if (previous.panelId && previous.panelId !== panelId) {
      try {
        const oldChannel = await guild?.channels.fetch(previous.channel)
        await oldChannel?.messages.delete(previous.panelId)
      } catch (error) {
        if (![10003,10008].includes(error.code))
          return res.json({ok:true,panelId,warning:'Settings saved. Remove the previous bait warning in Discord if it is still visible.'})
      }
    }
    res.json({ok:true,panelId})
  } catch {
    res.status(502).json({error:'Could not publish the bait warning. Check that Blackridge can send messages in the selected channel.'})
  } finally {
    honeyPotUpdates.delete(id)
  }
}
const verificationPublishing = new Set()
app.get('/api/guilds/:id/appeals', (req,res) => {
  if (!req.guild.appealsManager) return res.status(403).json({error:'Ban Appeals Manager access is required.'})
  res.json({appeals:db.appeals(req.guild.id)})
})
app.post('/api/guilds/:id/appeals/:appeal',async (req,res) => {
  if (!req.guild.appealsManager) return res.status(403).json({error:'Ban Appeals Manager access is required.'})
  const {id} = req.guild
  const {decision} = req.body ?? {}
  await reviewBanAppeal(activeGuild(id),db,req.params.appeal,decision,req.session.user.id)
  res.json({ok:true})
})
app.post('/api/guilds/:id/verification-panel',async (req,res) => {
  if (!req.guild.owner) return res.status(403).json({error:'Only the server owner can publish verification.'})
  const {id} = req.guild
  if (verificationPublishing.has(id)) return res.status(409).json({error:'A verification panel is already being published.'})
  verificationPublishing.add(id)
  try {
    const message = await publishVerification(activeGuild(id),db)
    if (!message) return res.status(400).json({error:'Enable Verification, select a channel, and choose roles Blackridge can manage.'})
    res.json({url:message.url})
  } finally { verificationPublishing.delete(id) }
})
app.get('/api/guilds/:id/options',async (req,res) => {
  const guild = activeGuild(req.guild.id)
  const {channels,roles} = await recovery.scope(guild)
  res.json({
    channels:channels.filter(channel => channel?.permissionOverwrites && channel.type !== ChannelType.GuildCategory && !channel.isThread()).map(channel => ({id:channel.id,name:channel.name,sendable:channel.isSendable(),type:channel.type})),
    renameChannels:channels.filter(channel => channel?.permissionOverwrites && !channel.isThread()).map(channel => ({id:channel.id,name:channel.name})),
    roles:roles.filter(role => role.id !== guild.id).map(role => ({id:role.id,name:role.name}))
  })
})
app.get('/api/guilds/:id/recovery/backup/:backup',(req,res) => {
  if (!req.guild.owner || db.guildPlan(req.guild.id) === 'free') return res.status(403).json({error:'Backup preview requires server ownership and a paid plan.'})
  if (!/^\d{1,15}$/.test(req.params.backup)) return res.status(404).json({error:'Backup not found.'})
  const snapshot = db.backup(req.guild.id,Number(req.params.backup))
  if (!snapshot) return res.status(404).json({error:'Backup not found.'})
  res.json({snapshot})
})
app.get('/api/guilds/:id/recovery',(req,res) => {
  if (!req.guild.owner) return res.status(403).json({error:'Only the server owner can access recovery.'})
  const id = req.guild.id
  const premium = db.guildPlan(id) !== 'free'
  res.json({lockdown:db.recovery(id,'lockdown')?.at ?? null,backups:premium ? db.backups(id) : [],schedule:premium ? db.recovery(id,'backupSchedule') : null,quarantineRole:db.recovery(id,'quarantineRole')?.role ?? '',quarantineSetup:db.recovery(id,'quarantineSetup')?.role ?? ''})
})
app.post('/api/guilds/:id/recovery/:operation',async (req,res) => {
  if (!req.guild.owner) return res.status(403).json({error:'Only the server owner can run recovery operations.'})
  const guild = activeGuild(req.guild.id)
  const actor = req.session.user.id
  const input = req.body ?? {}
  if (['backup','restore','schedule'].includes(req.params.operation) && db.guildPlan(guild.id) === 'free')
    return res.status(403).json({error:'Server Backups require Premium or Custom Bot.'})
  if (['enable','delete-invites'].includes(req.params.operation) && !db.config(guild.id,'lockdown').enabled) {
    return res.status(400).json({error:'Turn on the Lockdown module first.'})
  }
  if (['backup','restore','schedule'].includes(req.params.operation) && !db.config(guild.id,'backup').enabled) {
    return res.status(400).json({error:'Turn on Server Backups first.'})
  }
  const result = await recovery.run(guild,async () => {
    if (req.params.operation === 'enable') return recovery.enable(guild,actor,input)
    if (req.params.operation === 'delete-invites' && input.confirm === 'DELETE ALL INVITES') return recovery.deleteInvites(guild,actor)
    if (req.params.operation === 'lift' && input.confirm === 'LIFT LOCKDOWN') return recovery.lift(guild,actor)
    if (req.params.operation === 'backup') return recovery.backup(guild,actor)
    if (req.params.operation === 'quarantine') return recovery.quarantine(guild,actor,input.role)
    if (req.params.operation === 'restore' && input.confirm === 'RESTORE BACKUP' && Number.isSafeInteger(input.id)) return recovery.restore(guild,actor,input.id)
    if (req.params.operation === 'schedule' && [0,6,12,24,168].includes(input.hours)) {
      if (input.hours) db.saveRecovery(guild.id,'backupSchedule',{hours:input.hours,next:Date.now()+input.hours*3600000})
      else db.clearRecovery(guild.id,'backupSchedule')
      db.event(guild.id,'backup','Automatic backup schedule changed by ' + actor)
      return []
    }
    throw Object.assign(new Error('Confirm the action and check the selected options.'),{status:400})
  })
  res.json({ok:true,notices:result ?? []})
})
app.put('/api/guilds/:id/:kind',async (req,res) => {
  if (!req.guild.owner) return res.status(403).json({error:'Only the server owner can change policies.'})
  const {kind} = req.params
  if (!Object.hasOwn(policies,kind)) return res.status(404).json({error:'Unknown protection policy.'})
  const free = db.guildPlan(req.guild.id) === 'free'
  if (kind === 'backup' && free) return res.status(403).json({error:'Server Backups require Premium or Custom Bot.'})
  const parsed = policies[kind].safeParse(req.body)
  if (!parsed.success) return res.status(400).json({error:'Check your thresholds and Discord user IDs.'})
  if (kind === 'honeypot') return saveHoneyPot(req,res,parsed.data)
  if (kind === 'reports' && parsed.data.enabled &&
      !await privateAppealChannel(activeGuild(req.guild.id),parsed.data.channel).catch(() => null))
    return res.status(400).json({error:'Choose a review channel that denies View Channel to @everyone and lets Blackridge post.'})
  if (kind === 'appeals') {
    for (const channel of new Set([parsed.data.channel,parsed.data.alertChannel].filter(Boolean))) {
      if (!await privateAppealChannel(activeGuild(req.guild.id),channel).catch(() => null))
        return res.status(400).json({error:'Appeal review and log channels must deny View Channel to @everyone.'})
    }
  }
  if (kind === 'verification' && parsed.data.verifiedRole && parsed.data.verifiedRole === parsed.data.unverifiedRole)
    return res.status(400).json({error:'Verified and unverified roles must be different.'})
  const config = ['moderation','lockdown','appeals'].includes(kind) ? {...db.config(req.guild.id,kind),...parsed.data} : parsed.data
  const restricted = kind === 'nuke' ? ['guards',premiumGuards] : kind === 'automod' ? ['filters',premiumFilters] : null
  if (free && restricted) {
    const [field,keys] = restricted
    const stored = db.config(req.guild.id,kind)[field]
    for (const key of keys) {
      if (stored?.[key]) (config[field] ??= {})[key] = stored[key]
      else if (field === 'filters' && config.filters) config.filters[key] = {action:'off',limit:1,points:0}
      else if (config[field]) delete config[field][key]
    }
    if (kind === 'automod') config.maliciousDomains = db.config(req.guild.id,kind).maliciousDomains
  }
  db.save(req.guild.id,kind,config,req.session.user.id)
  if (['moderation','reports'].includes(kind) && parsed.data.enabled !== undefined) {
    try { await syncModerationCommands(activeGuild(req.guild.id),db,false,{reportsOnly:kind === 'reports'}) }
    catch {
      const warning = 'Settings saved, but Discord could not refresh the command list. Save again to retry.'
      if (kind === 'reports') return res.json({ok:true,warning})
      return res.status(503).json({error:warning})
    }
  }
  res.json({ok:true})
})
app.use('/api',(req,res) => res.status(404).json({error:'Route not found.'}))
const publicDir = fileURLToPath(new URL('./public/',import.meta.url))
const homeShell = readFileSync(new URL('./public/index.html',import.meta.url),'utf8')
const htmlEscape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[character])
const publicPages = {
  '/': ['Blackridge | Discord Security Bot','Protect your Discord server with Blackridge. Set up anti-raid, anti-nuke, auto moderation, and member verification from one dashboard.'],
  '/premium': ['Blackridge Premium & Custom Bot','Compare Blackridge plans for advanced Discord moderation, anti-nuke protection, server backups, and custom bot branding.'],
  '/documentation': ['Blackridge Documentation | Discord Bot Setup','Learn to install Blackridge and configure Discord raid protection, anti-nuke rules, verification, moderation, and backups.'],
  '/terms': ['Terms of Service | Blackridge','Read the terms for using Blackridge’s Discord security and moderation features.'],
  '/privacy': ['Privacy Policy | Blackridge','Learn how Blackridge handles Discord account, moderation, and server configuration data.']
}
function pageMetadata(path) {
  if (!Object.hasOwn(publicPages,path)) return '<title>Blackridge Dashboard</title><meta name="robots" content="noindex">'
  const [title,description] = publicPages[path]
  const url = base + path
  const image = base + '/blackridge-icon.png'
  const siteData = {'@context':'https://schema.org','@graph':[
    {'@type':'WebSite','name':'Blackridge','url':base + '/'},
    {'@type':'Organization','name':'Blackridge','url':base + '/','logo':image}
  ]}
  return [
    '<title>' + htmlEscape(title) + '</title>',
    '<meta name="description" content="' + htmlEscape(description) + '">',
    '<link rel="canonical" href="' + htmlEscape(url) + '">',
    ...Object.entries({'og:type':'website','og:site_name':'Blackridge','og:title':title,'og:description':description,'og:url':url,'og:image':image,
      'og:image:alt':'Blackridge logo','og:image:width':'256','og:image:height':'256'}).map(([key,value]) =>
      '<meta property="' + key + '" content="' + htmlEscape(value) + '">'),
    '<meta name="twitter:card" content="summary">',
    path === '/' ? '<script type="application/ld+json">' + JSON.stringify(siteData) + '</script>' : ''
  ].join('\n  ')
}
function sendPage(req,res,markup) {
  const session = openSession(cookie(req,'br_session'))
  const user = session?.until > Date.now() ? session.user : null
  const account = user ? '<details id="account" class="account-menu"><summary class="button small">' +
    (user.avatar ? '<img alt="" src="https://cdn.discordapp.com/avatars/' + encodeURIComponent(user.id) + '/' + encodeURIComponent(user.avatar) + '.png?size=64">' :
      '<span class="initial">' + htmlEscape(user.username.slice(0,1)) + '</span>') +
    '<span>' + htmlEscape(user.username) + '</span></summary><div class="account-links"><button type="button" id="sign-out">Log Out</button><a href="/premium">Premium</a><a href="/support">Support Server</a></div></details>' : null
  markup = markup.replace('<!-- page-metadata -->',() => pageMetadata(req.path.toLowerCase().replace(/\/$/,'') || '/'))
  res.set('Cache-Control','private, no-store').type('html').send(account ? markup.replace(/<a [^>]*id="account">Sign In<\/a>/,() => account) : markup)
}
app.get('/',(req,res) => sendPage(req,res,homeShell))
app.get('/index.html',(req,res) => res.redirect(301,'/'))
app.get('/robots.txt',(req,res) => res.type('text/plain').send('User-agent: *\nDisallow: /api/\nDisallow: /auth/\nSitemap: ' + base + '/sitemap.xml\n'))
app.get('/sitemap.xml',(req,res) => res.type('application/xml').send(
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  Object.keys(publicPages).map(path => '  <url><loc>' + htmlEscape(base + path) + '</loc></url>').join('\n') + '\n</urlset>\n'))
app.use(express.static(publicDir))
const renderMain = body => homeShell
  .replace(/<main id="app">[\s\S]*?<\/main>/,() => '<main id="app"><div class="wrap dashboard">' + body + '</div></main>')
const premiumShell = renderMain('<h1 class="premium-heading">Blackridge Premium</h1>' + premiumPlans() +
  '<p class="stack premium-cta"><a class="button" href="/dashboard">Open Dashboard</a></p>')
app.get('/support',(req,res) => res.redirect(supportInvite))
app.get('/premium',(req,res) => sendPage(req,res,premiumShell))
for (const [path,body] of Object.entries(resources)) {
  const page = renderMain('<div class="resource-page">' + body + '</div>')
  app.get(path,(req,res) => sendPage(req,res,page))
}
const dashboardShell = renderMain('<div class="dashboard-loader" role="status"><span class="visually-hidden">Loading dashboard</span><div class="loading-heading" aria-hidden="true"></div><div class="loading-panel" aria-hidden="true"><span></span><span></span><span></span></div></div>').replace('/design.css','/analytics.css').replace('<body>','<body class="dashboard-page">')
app.get(['/dashboard','/dashboard/:id','/dashboard/:id/:section'],(req,res) => {
  res.set('X-Robots-Tag','noindex')
  sendPage(req,res,dashboardShell)
})
app.use((error,req,res,next) => {
  if (res.headersSent) return next(error)
  const status = error.status || 500
  if (status === 500) console.error('Request failed:',error.name)
  res.status(status).json({error:[400,401,403,404,409,503].includes(status) ? error.message : 'Could not complete the request.'})
})
const server = app.listen(port,'0.0.0.0',() => console.log('Blackridge listening on port ' + port))
function stop() {
  server.close(() => { db.close(); process.exit(0) })
  custom.close()
  if (bot) bot.destroy()
  setTimeout(() => process.exit(1),5000).unref()
}
process.once('SIGTERM',stop)
process.once('SIGINT',stop)


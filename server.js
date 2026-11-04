import express from 'express'
import helmet from 'helmet'
import { randomBytes, createHash, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { ChannelType, PermissionFlagsBits as P } from 'discord.js'
import { createStore, policies } from './store.js'
import { startBot, requiredPermissions } from './bot.js'
import { recoveryTools } from './recovery.js'

const {DISCORD_CLIENT_ID: clientId, DISCORD_CLIENT_SECRET: clientSecret, DISCORD_BOT_TOKEN: botToken} = process.env
const port = Number(process.env.PORT || 3000)
const base = new URL(process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'http://localhost:' + port)).origin
const redirect = base + '/auth/callback'
const configured = Boolean(clientId && clientSecret)
const app = express()
const db = createStore(process.env.DB_PATH || './data/blackridge.sqlite')
const bot = botToken && startBot(botToken,db)
const recovery = recoveryTools(db,bot)
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
app.use(express.json({limit:'8kb'}))
async function discord(path,options = {}) {
  const response = await fetch('https://discord.com/api/v10' + path,{...options,signal:AbortSignal.timeout(8000)})
  if (response.status === 401) throw Object.assign(new Error('Discord session expired. Sign in again.'),{status:401})
  if (response.status === 429) throw Object.assign(new Error('Discord is limiting server-list requests. Try again shortly.'),{status:503})
  if (!response.ok) throw Object.assign(new Error('Discord is temporarily unavailable.'),{status:503})
  return response.json()
}

app.get('/healthz',(req,res) => res.json({ok:true,botConnected:Boolean(bot && bot.isReady()),oauthConfigured:configured}))
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
const supportInvite = /^https:\/\/(?:discord\.gg\/|discord\.com\/invite\/)[\w-]+$/.test(process.env.SUPPORT_INVITE_URL ?? '') ? process.env.SUPPORT_INVITE_URL : null
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
      list.push(...page.filter(guild => guild.owner || Boolean(BigInt(guild.permissions) & (P.Administrator | P.ManageGuild))))
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
app.get('/api/guilds',async (req,res) => {
  const guilds = await visibleGuilds(req)
  res.json({guilds:guilds.map(({id,name,icon,owner}) => ({id,name,icon,owner,installed:Boolean(bot && bot.guilds.cache.has(id))}))})
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
  if (!member || (guild.ownerId !== member.id && !member.permissions.has(P.ManageGuild))) {
    return res.status(404).json({error:'Blackridge is unavailable for this server.'})
  }
  req.guild = {id:guild.id,name:guild.name,owner:guild.ownerId === member.id}
  next()
})
app.get('/api/guilds/:id',(req,res) => {
  const {id,name,owner} = req.guild
  res.json({name,owner,icon:bot.guilds.cache.get(id)?.icon ?? null,config:Object.fromEntries(Object.keys(policies).filter(kind => kind !== 'permits' || owner).map(kind => [kind,db.config(id,kind)])),events:db.recent(id),lockdownActive: Boolean(db.recovery(id,'lockdown')),backupsScheduled:Boolean(db.recovery(id,'backupSchedule'))})
})
app.get('/api/guilds/:id/events',async (req,res) => {
  const events = db.recent(req.guild.id).map(event => {
    const pattern = event.kind === 'moderation' ? /\bmoderator (\d{17,20})\b/
      : /(?:\b(?:by|from|out|for|flagged|author|quarantined) |\bmember )(\d{17,20})\b/i
    return {...event,userId:event.detail.match(pattern)?.[1] ?? null}
  })
  const missing = [...new Set(events.map(event => event.userId).filter(id => id && !bot.users.cache.has(id)))].slice(0,8)
  await Promise.allSettled(missing.map(id => bot.users.fetch(id)))
  res.json({events:events.map(event => {
    const user = event.userId && bot.users.cache.get(event.userId)
    return {...event,userName:user?.username ?? null,avatar:user?.avatar ?? null}
  })})
})
app.get('/api/guilds/:id/options',async (req,res) => {
  const guild = bot.guilds.cache.get(req.guild.id)
  const {channels,roles} = await recovery.scope(guild)
  res.json({
    channels:channels.filter(channel => channel?.permissionOverwrites && channel.type !== ChannelType.GuildCategory && !channel.isThread()).map(channel => ({id:channel.id,name:channel.name,sendable:channel.isSendable()})),
    roles:roles.filter(role => role.id !== guild.id).map(role => ({id:role.id,name:role.name}))
  })
})
app.get('/api/guilds/:id/recovery',(req,res) => {
  if (!req.guild.owner) return res.status(403).json({error:'Only the server owner can access recovery.'})
  const id = req.guild.id
  res.json({lockdown:db.recovery(id,'lockdown')?.at ?? null,backups:db.backups(id),schedule:db.recovery(id,'backupSchedule'),quarantineRole:db.recovery(id,'quarantineRole')?.role ?? '',quarantineSetup:db.recovery(id,'quarantineSetup')?.role ?? ''})
})
app.post('/api/guilds/:id/recovery/:operation',async (req,res) => {
  if (!req.guild.owner) return res.status(403).json({error:'Only the server owner can run recovery operations.'})
  const guild = bot.guilds.cache.get(req.guild.id)
  const actor = req.session.user.id
  const input = req.body ?? {}
  const result = await recovery.run(guild,async () => {
    if (req.params.operation === 'enable') return recovery.enable(guild,actor,input)
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
app.put('/api/guilds/:id/:kind',(req,res) => {
  if (!req.guild.owner) return res.status(403).json({error:'Only the server owner can change policies.'})
  const {kind} = req.params
  if (!Object.hasOwn(policies,kind)) return res.status(404).json({error:'Unknown protection policy.'})
  const parsed = policies[kind].safeParse(req.body)
  if (!parsed.success) return res.status(400).json({error:'Check your thresholds and Discord user IDs.'})
  db.save(req.guild.id,kind,parsed.data,req.session.user.id)
  res.json({ok:true})
})
app.use('/api',(req,res) => res.status(404).json({error:'Route not found.'}))
const publicDir = fileURLToPath(new URL('./public/',import.meta.url))
app.use(express.static(publicDir))
const appShell = readFileSync(new URL('./public/index.html',import.meta.url),'utf8')
  .replace(/<main id="app">[\s\S]*?<\/main>/,'<main id="app"><div class="wrap dashboard"><p role="status">Loading…</p></div></main>')
app.get('/support',(req,res) => supportInvite ? res.redirect(supportInvite) : res.type('html').send(appShell))
app.get(['/premium','/dashboard','/dashboard/:id','/dashboard/:id/:section'],(req,res) => res.type('html').send(appShell))
app.use((error,req,res,next) => {
  if (res.headersSent) return next(error)
  const status = error.status || 500
  if (status === 500) console.error('Request failed:',error.name)
  res.status(status).json({error:[400,401,503].includes(status) ? error.message : 'Could not complete the request.'})
})
const server = app.listen(port,'0.0.0.0',() => console.log('Blackridge listening on port ' + port))
function stop() {
  server.close(() => { db.close(); process.exit(0) })
  if (bot) bot.destroy()
  setTimeout(() => process.exit(1),5000).unref()
}
process.once('SIGTERM',stop)
process.once('SIGINT',stop)



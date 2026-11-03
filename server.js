import express from 'express'
import helmet from 'helmet'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { PermissionFlagsBits as P } from 'discord.js'
import { createStore, policies } from './store.js'
import { startBot, requiredPermissions } from './bot.js'

const {DISCORD_CLIENT_ID: clientId, DISCORD_CLIENT_SECRET: clientSecret, DISCORD_BOT_TOKEN: botToken} = process.env
const port = Number(process.env.PORT || 3000)
const base = new URL(process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'http://localhost:' + port)).origin
const redirect = base + '/auth/callback'
const configured = Boolean(clientId && clientSecret)
const app = express()
const db = createStore(process.env.DB_PATH || './data/blackridge.sqlite')
const bot = botToken && startBot(botToken,db)
const sessions = new Map()
const states = new Map()
const idPattern = /^\d{17,20}$/
const nonce = () => randomBytes(32).toString('base64url')
const cookieOptions = {httpOnly:true,secure:base.startsWith('https:'),sameSite:'lax',path:'/'}
const cookie = (req,key) => req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(key + '='))?.slice(key.length+1)
const prune = () => {
  for (const map of [sessions,states]) for (const [key,value] of map) if (value.until <= Date.now()) map.delete(key)
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
    if (sessions.size >= 10000) return res.status(503).send('Session capacity reached.')
    sessions.delete(cookie(req,'br_session'))
    sessions.set(key,{headers,user:{id:user.id,username:user.global_name || user.username,avatar:user.avatar},until:Date.now()+maxAge})
    res.cookie('br_session',key,{...cookieOptions,maxAge})
    res.redirect('/dashboard')
  } catch { res.redirect('/dashboard?auth=failed') }
})
app.post('/auth/logout',(req,res) => {
  sessions.delete(cookie(req,'br_session'))
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
  const session = sessions.get(cookie(req,'br_session'))
  if (session?.until > Date.now()) req.session = session
  next()
})
const supportInvite = /^https:\/\/(?:discord\.gg\/|discord\.com\/invite\/)[\w-]+$/.test(process.env.SUPPORT_INVITE_URL ?? '') ? process.env.SUPPORT_INVITE_URL : null
app.get('/api/me',(req,res) => res.json({configured,supportInvite,user:req.session?.user ?? null}))

async function visibleGuilds(req) {
  if (!req.session) throw Object.assign(new Error('Sign in with Discord.'),{status:401})
  const session = req.session
  if (req.method === 'GET' && session.guilds?.until > Date.now()) return session.guilds.list
  if (session.guildRequest) return session.guildRequest
  session.guildRequest = (async () => {
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
    session.guilds = {list,until:Date.now()+12000}
    return list
  })()
  try { return await session.guildRequest } finally { delete session.guildRequest }
}
app.get('/api/guilds',async (req,res) => {
  const guilds = await visibleGuilds(req)
  res.json({guilds:guilds.map(({id,name,icon,owner}) => ({id,name,icon,owner,installed:Boolean(bot && bot.guilds.cache.has(id))}))})
})
app.use('/api/guilds/:id',async (req,res,next) => {
  if (!idPattern.test(req.params.id)) return res.status(404).json({error:'Server not found.'})
  const guilds = await visibleGuilds(req)
  const listed = guilds.find(guild => guild.id === req.params.id)
  const guild = listed && bot?.guilds.cache.get(listed.id)
  if (!guild?.available) return res.status(404).json({error:'Blackridge is unavailable for this server.'})
  const member = await guild.members.fetch({user:req.session.user.id,force:true}).catch(() => null)
  if (!member || (guild.ownerId !== member.id && !member.permissions.has(P.ManageGuild))) {
    return res.status(404).json({error:'Blackridge is unavailable for this server.'})
  }
  req.guild = {id:guild.id,name:guild.name,owner:guild.ownerId === member.id}
  next()
})
app.get('/api/guilds/:id',(req,res) => {
  const {id,name,owner} = req.guild
  res.json({name,owner,icon:bot.guilds.cache.get(id)?.icon ?? null,config:Object.fromEntries(Object.keys(policies).filter(kind => kind !== 'permits' || owner).map(kind => [kind,db.config(id,kind)])),events:db.recent(id),stats:db.stats(id)})
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
  res.status(status).json({error:[401,503].includes(status) ? error.message : 'Could not complete the request.'})
})
const server = app.listen(port,'0.0.0.0',() => console.log('Blackridge listening on port ' + port))
function stop() {
  server.close(() => { db.close(); process.exit(0) })
  if (bot) bot.destroy()
  setTimeout(() => process.exit(1),5000).unref()
}
process.once('SIGTERM',stop)
process.once('SIGINT',stop)



import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { AuditLogEvent as A, Collection, Events, PermissionFlagsBits as P } from 'discord.js'
import { attachProtection, isDestructive, recordHit } from '../bot.js'
import { createStore, guildPlan, policies } from '../store.js'
import { canModerate, syncModerationCommands } from '../moderation.js'
import { recoveryTools } from '../recovery.js'
import { attachVerification } from '../verification.js'
import { appealMarker, canReviewAppeals, hasAppealableBan } from '../appeals.js'
import { actionCard, memberAction, messageCard } from '../messages.js'

test('new servers have all toggleable modules disabled', t => {
  const db = createStore(':memory:')
  t.after(() => db.close())
  for (const kind of ['nuke','raid','checkpoint','lockdown','verification','permits','automod','moderation','backup'])
    assert.equal(db.config('new',kind).enabled,false,kind)
})

test('invite cleanup reports partial deletion and tolerates an expired invite', async t => {
  const db = createStore(':memory:')
  t.after(() => db.close())
  const invalid = code => ({delete:async () => { throw Object.assign(new Error(),{code}) }})
  const guild = {id:'guild',invites:{fetch:async () => [
    {delete:async () => {}},invalid(10006),invalid(50013)
  ]}}
  const recovery = recoveryTools(db)
  assert.deepEqual(await recovery.deleteInvites(guild,'owner'),['Deleted 1 invite. 1 could not be deleted.'])
  assert.match(db.recent(guild.id)[0].detail,/Deleted 1 invite/)
})

test('timeout action card shows moderator, non-pinging member reference, and localizable dates', () => {
  const userId = '1567348176866902119'
  const actor = '1567267439245525202'
  const card = actionCard(memberAction('timeout',{userId,actor,until:200000,at:100000}))
  const components = card.components[0].components
  assert.ok(components.some(component=>component.divider === true))
  const header = components[0]
  assert.equal(header.accessory.media.url,'https://cdn.discordapp.com/emojis/1567545831505137706.webp')
  const text = [header.components[0],...components.slice(1)].map(component=>component.content ?? '').join('\n')
  assert.match(text,/Member Timed Out/)
  assert.ok(text.includes('<@'+userId+'> was timed out until <t:200:f> (<t:200:R>)'))
  assert.ok(text.includes('**Moderator**\n<@'+actor+'>'))
  assert.ok(text.includes('User ID: '+userId+' · <t:100:f>'))
  assert.deepEqual(card.allowedMentions,{parse:[],roles:[]})
})

test('Components V2 cards retain attachments and suppress unsolicited mentions', () => {
  const card = messageCard('Test','@everyone',{roles:['role'],files:[{name:'report.txt',attachment:Buffer.from('test')}]})
  assert.equal(card.flags,32768)
  assert.equal(card.components[0].type,17)
  assert.deepEqual(card.allowedMentions,{parse:[],roles:['role']})
  assert.ok(card.components[0].components.some(component=>component.file?.url === 'attachment://report.txt'))
})

test('appeal blacklist is server scoped and review permission requires a permit and Ban Members', t => {
  const db = createStore(':memory:')
  t.after(() => db.close())
  const guild = {id:'guild',ownerId:'owner'}
  const member = {id:'reviewer',roles:{cache:new Map()},permissions:{has:permission=>permission===P.BanMembers}}
  assert.equal(canReviewAppeals(guild,member,db),false)
  db.save(guild.id,'permits',{enabled:true,entries:[{name:'Reviewer',users:[member.id],roles:[],commands:[],bypasses:[],appealsManager:true}]},'owner')
  assert.equal(canReviewAppeals(guild,member,db),true)
  member.permissions.has = () => false
  assert.equal(canReviewAppeals(guild,member,db),false)
  db.inviteAppeal('first',guild.id,'applicant',['Question'])
  assert.equal(db.submitAppeal('first','applicant',['Answer']),true)
  assert.equal(db.reviewAppeal('first',guild.id,'blacklisted'),true)
  db.inviteAppeal('second',guild.id,'applicant',['Question'])
  assert.equal(db.submitAppeal('second','applicant',['Answer']),false)
  assert.equal(db.appealBlacklisted('other','applicant'),false)
  assert.equal(guildPlan('1567348176866902119'),'custom')
})

test('ban appeal links are single use and accept only the original ban', async t => {
  const db = createStore(':memory:')
  t.after(() => db.close())
  db.inviteAppeal('appeal','guild','member',['Why should we unban you?'])
  assert.equal(db.submitAppeal('appeal','other',['Answer']),false)
  assert.equal(db.submitAppeal('appeal','member',['Answer']),true)
  assert.equal(db.submitAppeal('appeal','member',['Duplicate']),false)
  assert.deepEqual(db.appeals('other'),[])
  assert.deepEqual(db.appeals('guild')[0].answers,['Answer'])
  let reason = 'Unrelated ban'
  const guild = {bans:{fetch:async () => ({reason})}}
  assert.equal(await hasAppealableBan(guild,db.appeal('appeal')),false)
  reason = appealMarker('appeal')+'Original ban'
  assert.equal(await hasAppealableBan(guild,db.appeal('appeal')),true)
  assert.equal(db.reviewAppeal('appeal','other','accepted'),false)
  assert.equal(db.reviewAppeal('appeal','guild','accepted'),true)
  assert.equal(db.reviewAppeal('appeal','guild','rejected'),false)
})

test('Anti-Nuke gates role and channel rename protection on paid plans', async t => {
  const db = createStore(':memory:')
  const client = new EventEmitter()
  client.user = {id:'bot'}
  const cleanup = attachProtection(client,db)
  t.after(() => { cleanup(); db.close() })
  const channel = {name:'edited',async setName(name) { this.name = name }}
  const guild = {id:'free-guild',ownerId:'owner',channels:{fetch:async () => channel},roles:{fetch:async () => channel},
    members:{fetch:async () => ({id:'actor',guild,kickable:true,kick:async () => {}})}}
  db.save(guild.id,'nuke',{enabled:true,guards:{channelRename:{enabled:true,channels:['channel'],action:'kick'},
    roleRename:{enabled:true,roles:['role'],action:'kick'}}},'owner')
  async function rename(id,targetId,action=A.RoleUpdate) {
    client.emit(Events.GuildAuditLogEntryCreate,{id,executorId:'actor',targetId,action,
      createdTimestamp:Date.now(),changes:[{key:'name',old:'original',new:'edited'}]},guild)
    await new Promise(resolve => setImmediate(resolve))
  }
  await rename('0','channel',A.ChannelUpdate)
  assert.equal(channel.name,'edited')
  await rename('1','different-role')
  assert.equal(channel.name,'edited')
  await rename('2','role')
  assert.equal(channel.name,'edited')
  db.guildPlan = () => 'premium'
  await rename('paid-role','role')
  assert.equal(channel.name,'original')
  channel.name = 'newer'
  await rename('3','role')
  assert.equal(channel.name,'newer')
})

test('moderation history survives the dashboard log limit and stays scoped to the server', t => {
  const db = createStore(':memory:')
  t.after(() => db.close())
  const member = '123456789012345678'
  const moderator = '123456789012345679'
  db.event('guild','moderation','warn · member ' + member + ' · moderator ' + moderator + ' · Test warning')
  for (let i=0;i<12;i++) db.event('guild','settings','Update '+i)
  db.recordModeration('guild',member,'kick','Discord audit action',Date.now(),'audit')
  db.recordModeration('guild',member,'kick','Discord audit action',Date.now(),'audit')
  assert.equal(db.recent('guild').length,10)
  assert.equal(db.recent('guild','moderation').length,1)
  assert.deepEqual(db.history('guild',member).map(item => item.action),['kick','warn'])
  assert.deepEqual(db.history('another',member),[])
})

test('verification grants the configured role only from the published panel', async t => {
  const db = createStore(':memory:')
  const client = new EventEmitter()
  t.after(() => db.close())
  attachVerification(client,db)
  const roles = []
  const replies = []
  const role = {id:'verified',editable:true,permissions:{bitfield:0n}}
  const guild = {id:'guild',roles:{fetch:async () => role},channels:{cache:[]}}
  const user = {id:'member',createdTimestamp:Date.now()-86400000}
  guild.members = {fetch:async () => ({
    guild,user,id:user.id,isCommunicationDisabled:() => false,
    roles:{cache:new Map(),add:async selected => roles.push(selected.id)}
  })}
  db.save(guild.id,'verification',{enabled:true,channel:'channel',verifiedRole:role.id},'owner')
  db.saveRecovery(guild.id,'verificationPanel',{channel:'channel',message:'panel'})
  async function press(message) {
    client.emit(Events.InteractionCreate,{
      guild,user,channelId:'channel',message:{id:message},customId:'blackridge-verify:start',
      inCachedGuild:() => true,isButton:() => true,isModalSubmit:() => false,
      async deferReply() { this.deferred = true },editReply:async value => replies.push(value),reply:async () => {}
    })
    await new Promise(resolve => setImmediate(resolve))
  }
  await press('another')
  assert.deepEqual(roles,[])
  role.permissions.bitfield = P.Administrator
  await press('panel')
  assert.deepEqual(roles,[])
  role.permissions.bitfield = 0n
  await press('panel')
  assert.deepEqual(roles,['verified'])
  db.save(guild.id,'verification',{enabled:true,channel:'channel',verifiedRole:role.id,mode:'captcha'},'owner')
  await press('panel')
  const challenge = replies.at(-1)
  assert.equal(challenge.files[0].attachment.subarray(1,4).toString(),'PNG')
  assert.equal(challenge.files[0].name,'verification.png')
  assert.deepEqual(roles,['verified'])
})

test('point escalation triggers on threshold crossings and ignores repeated message IDs', t => {
  const db = createStore(':memory:')
  t.after(() => db.close())
  const rule = {points:5,hours:24,action:'timeout'}
  const now = 100000000
  const award = (id,points,at=now) => db.escalation('guild','member',id,points,[rule],at)
  assert.equal(award('first',2),null)
  assert.equal(award('first',2),null)
  assert.deepEqual(award('second',3),rule)
  assert.equal(award('third',5),null)
  assert.deepEqual(award('fourth',5,now+86400001),rule)
})

test('turning moderation off removes only Blackridge moderation slash commands', async t => {
  const db = createStore(':memory:')
  t.after(() => db.close())
  const removed = []
  const guild = {id:'guild',commands:{fetch:async () => new Map(['ban','unban','lock','other'].map(name =>
    [name,{name,type:1,delete:async () => removed.push(name)}]
  ))}}
  db.save(guild.id,'moderation',{enabled:false},'owner')
  await syncModerationCommands(guild,db)
  assert.deepEqual(removed,['ban','unban','lock'])
})

test('lockdown records recovery before mutation and preserves a changed verification level', async t => {
  const db = createStore(':memory:')
  t.after(() => db.close())
  let verification = 1
  const guild = {
    id:'guild',
    channels:{fetch:async () => new Map()},
    roles:{fetch:async () => new Map()},
    client:{rest:{get:async () => ({verification_level:verification})}},
    async setVerificationLevel(level) {
      assert.ok(db.recovery(this.id,'lockdown').steps.length)
      verification = level
    }
  }
  const tools = recoveryTools(db)
  const input = {confirm:'ENABLE LOCKDOWN',all:false,channels:[],verification:true,invites:false,dms:false}
  assert.deepEqual(await tools.enable(guild,'owner',input),[])
  assert.equal(verification,4)
  verification = 3
  assert.deepEqual(await tools.lift(guild,'owner'),[])
  assert.equal(verification,3)
  assert.equal(db.recovery(guild.id,'lockdown'),null)
})

test('command permits fail closed and require both delegation and Discord permissions', () => {
  const actor = {id:'member',guild:{id:'guild'},roles:{cache:[{id:'guild'},{id:'mod'}]},permissions:{has:() => true}}
  const channel = {has:() => true}
  assert.equal(canModerate(actor,'owner','ban',{users:[],roles:['guild']},channel),false)
  assert.equal(canModerate(actor,'owner','ban',{users:[],roles:[]},channel),false)
  assert.equal(canModerate(actor,'owner','ban',{users:[],roles:['mod']},null),false)
  assert.equal(canModerate(actor,'owner','ban',{users:[],roles:['mod']},channel),true)
})

test('sliding windows are isolated per key and expire at the boundary', () => {
  const history = new Map()
  assert.equal(recordHit(history,'first',0,1000,3),1)
  assert.equal(recordHit(history,'first',500,1000,3),2)
  assert.equal(recordHit(history,'other',550,1000,3),1)
  assert.equal(recordHit(history,'first',1000,1000,3),2)
})

test('permission escalation ignores harmless additions and dangerous permission removals', () => {
  const entry = (old,next) => ({action:A.RoleUpdate,changes:[{key:'permissions',old:String(old),new:String(next)}]})
  assert.equal(isDestructive(entry(0n,P.Administrator)),true)
  assert.equal(isDestructive(entry(P.Administrator,0n)),false)
  assert.equal(isDestructive(entry(0n,P.SendMessages)),false)
})

test('Anti-Nuke deduplicates audit entries and logs when the actor crosses the threshold', t => {
  const db = createStore(':memory:')
  const client = new EventEmitter()
  client.user = {id:'bot'}
  const cleanup = attachProtection(client,db)
  t.after(() => { cleanup(); db.close() })
  const guild = {id:'guild',ownerId:'owner'}
  db.save(guild.id,'nuke',{enabled:true},'owner')
  const send = (id,executorId) => client.emit(Events.GuildAuditLogEntryCreate,{
    id,executorId,action:A.ChannelDelete,createdTimestamp:Date.now()
  },guild)
  send('1','actor')
  send('1','actor')
  send('2','actor')
  send('3','owner')
  assert.equal(db.recent('guild').filter(event=>event.kind === 'nuke').length,0)
  send('4','actor')
  assert.match(db.recent('guild')[0].detail,/3 tracked actions/)
})

test('Anti-Nuke enforces rolling limits and escalates repeated detections per rule', async t => {
  const db = createStore(':memory:')
  const client = new EventEmitter()
  client.user = {id:'bot'}
  const cleanup = attachProtection(client,db)
  t.after(() => { cleanup(); db.close() })
  const bans = []
  const guild = {id:'guild',ownerId:'owner',members:{fetch:async () => ({
    id:'actor',guild,bannable:true,ban:async () => bans.push('actor')
  })}}
  const config = {...db.config(guild.id,'nuke'),enabled:true}
  config.rates = {channelDelete:{enabled:true,threshold:3,window:20,minute:0,hour:2}}
  config.guards = {identity:{enabled:true,action:'log',escalateAfter:2,escalateTo:'ban',identity:['name']}}
  assert.equal(policies.nuke.safeParse(config).success,true)
  db.save(guild.id,'nuke',config,'owner')
  const send = async (id,action,field) => {
    client.emit(Events.GuildAuditLogEntryCreate,{
      id,executorId:'actor',action,createdTimestamp:Date.now(),changes:field ? [{key:field}] : []
    },guild)
    await new Promise(resolve => setImmediate(resolve))
  }
  await send('first',A.ChannelDelete)
  await send('first',A.ChannelDelete)
  await send('second',A.ChannelDelete)
  assert.equal(db.recent(guild.id).filter(event => event.kind === 'nuke').length,1)
  await send('ignored',A.GuildUpdate,'icon_hash')
  await send('third',A.GuildUpdate,'name')
  assert.deepEqual(bans,[])
  await send('fourth',A.GuildUpdate,'name')
  assert.deepEqual(bans,['actor'])
})

test('Role Gate reverses an unauthorized grant and honors the required role', async t => {
  const db = createStore(':memory:')
  const client = new EventEmitter()
  client.user = {id:'bot'}
  const cleanup = attachProtection(client,db)
  t.after(() => { cleanup(); db.close() })
  const role = '123456789012345678'
  const required = '123456789012345679'
  const grantorRoles = new Map()
  const removed = []
  const kicked = []
  const guild = {id:'guild',ownerId:'owner',roles:{cache:new Map()},members:{fetch:async ({user}) => user === 'target'
    ? {roles:{cache:new Map([[role,{}]]),remove:async id => removed.push(id)}}
    : {id:user,guild,roles:{cache:grantorRoles},kickable:true,kick:async () => kicked.push(user)}
  }}
  db.save(guild.id,'nuke',{enabled:true,guards:{gate:{enabled:true,action:'kick',gates:[{role,required:[required]}]}}},'owner')
  const send = async id => {
    client.emit(Events.GuildAuditLogEntryCreate,{
      id,executorId:'actor',targetId:'target',action:A.MemberRoleUpdate,createdTimestamp:Date.now(),
      changes:[{key:'$add',new:[{id:role}]}]
    },guild)
    await new Promise(resolve => setImmediate(resolve))
  }
  grantorRoles.set(required,{})
  await send('allowed')
  assert.deepEqual(removed,[])
  grantorRoles.clear()
  await send('blocked')
  assert.deepEqual(removed,[role])
  assert.deepEqual(kicked,['actor'])
})

test('legacy command permits become named grants and bypasses stay scoped to their selected module', t => {
  const db = createStore(':memory:')
  t.after(() => db.close())
  const user = '123456789012345678'
  db.save('guild','permits',{ban:{users:[user],roles:[]}},'owner')
  const migrated = db.config('guild','permits')
  assert.deepEqual(migrated.entries,[{name:'/ban',users:[user],roles:[],commands:['ban'],bypasses:[]}])
  const actor = {id:user,guild:{id:'guild'},roles:{cache:new Map()},permissions:{has:() => true}}
  assert.equal(canModerate(actor,'owner','ban',migrated.entries,{has:() => true}),true)
  assert.equal(canModerate(actor,'owner','kick',migrated.entries,{has:() => true}),false)
  migrated.entries[0].bypasses.push('nuke')
  db.save('guild','permits',policies.permits.parse(migrated),'owner')
  const client = new EventEmitter()
  client.user = {id:'bot'}
  const cleanup = attachProtection(client,db)
  t.after(cleanup)
  const guild = {id:'guild',ownerId:'owner'}
  const count = db.recent(guild.id).length
  for (const id of ['1','2','3']) client.emit(Events.GuildAuditLogEntryCreate,{
    id,executorId:user,action:A.ChannelDelete,createdTimestamp:Date.now()
  },guild)
  assert.equal(db.recent(guild.id).length,count)
})

test('permit migration drops the generated kick entry and retains custom channel grants', t => {
  const db = createStore(':memory:')
  t.after(() => db.close())
  const grant = {users:['123456789012345678'],roles:[],bypasses:[]}
  db.save('guild','permits',{entries:[
    {...grant,name:'/kick',commands:['kick']},
    {...grant,name:'Server Manager',commands:['kick','lock','unlock']}
  ]},'owner')
  assert.deepEqual(policies.permits.parse(db.config('guild','permits')).entries,[
    {...grant,name:'Server Manager',commands:['kick','lock-channel','unlock-channel']}
  ])
})

test('Anti-Nuke journals existing roles before replacing them with quarantine', async t => {
  const db = createStore(':memory:')
  const client = new EventEmitter()
  client.user = {id:'bot'}
  const cleanup = attachProtection(client,db)
  t.after(() => { cleanup(); db.close() })
  const role = {id:'quarantine',editable:true,permissions:{bitfield:0n}}
  const admin = {id:'admin',editable:true,permissions:{bitfield:P.Administrator}}
  const finished = new EventEmitter()
  const guild = {id:'guild',ownerId:'owner',channels:{cache:new Collection()},
    roles:{cache:new Collection([[role.id,role]]),everyone:{permissions:{has:() => false}}},
    members:{fetch:async () => member}}
  const held = new Collection([[admin.id,admin]])
  const member = {id:'actor',guild,manageable:true,moderatable:true,
    roles:{cache:held,add:async item => held.set(item.id,item),remove:async item => {
      assert.equal(db.recovery(guild.id,'quarantine:actor').originals.admin,String(P.Administrator))
      held.delete(item.id)
    }},
    disableCommunicationUntil:async () => finished.emit('done')
  }
  db.saveRecovery(guild.id,'quarantineRole',{role:role.id})
  db.save(guild.id,'nuke',{...db.config(guild.id,'nuke'),enabled:true,threshold:2,action:'quarantine'},'owner')
  const done = once(finished,'done',{signal:AbortSignal.timeout(1000)})
  for (const id of ['one','two']) client.emit(Events.GuildAuditLogEntryCreate,{
    id,executorId:'actor',action:A.ChannelDelete,createdTimestamp:Date.now()
  },guild)
  await done
  assert.deepEqual([...held.keys()],['quarantine'])
})

test('Anti-Raid times out young accounts only after the join threshold', async t => {
  const db = createStore(':memory:')
  const client = new EventEmitter()
  const cleanup = attachProtection(client,db)
  t.after(() => { cleanup(); db.close() })
  const guild = {id:'guild',ownerId:'owner'}
  db.save('guild','raid',{...db.config('guild','raid'),enabled:true,threshold:3,action:'timeout'},'owner')
  const calls = new EventEmitter()
  const join = (id,age) => client.emit(Events.GuildMemberAdd,{
    guild,id,moderatable:true,user:{createdTimestamp:Date.now()-age*86400000},
    disableCommunicationUntil:async until => calls.emit('timeout',id,Math.round((until-Date.now())/1000)*1000)
  })
  const timeout = once(calls,'timeout',{signal:AbortSignal.timeout(1000)})
  join('a',0)
  join('b',0)
  join('c',30)
  join('d',0)
  assert.deepEqual(await timeout,['d',600000])
  assert.match(db.recent('guild')[0].detail,/Timed out d/)
})

test('policies reject extra fields and invalid actions', () => {
  const db = createStore(':memory:')
  const config = db.config('guild','nuke')
  assert.equal(policies.nuke.safeParse(config).success,true)
  assert.equal(policies.nuke.safeParse({...config,admin:true}).success,false)
  assert.equal(policies.nuke.safeParse({...config,action:'unknown'}).success,false)
  db.close()
})

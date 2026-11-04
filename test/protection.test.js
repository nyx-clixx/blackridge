import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { AuditLogEvent as A, Events, PermissionFlagsBits as P } from 'discord.js'
import { attachProtection, isDestructive, recordHit } from '../bot.js'
import { createStore, policies } from '../store.js'
import { canModerate } from '../moderation.js'
import { recoveryTools } from '../recovery.js'

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
  const send = (id,executorId) => client.emit(Events.GuildAuditLogEntryCreate,{
    id,executorId,action:A.ChannelDelete,createdTimestamp:Date.now()
  },guild)
  send('1','actor')
  send('1','actor')
  send('2','actor')
  send('3','owner')
  assert.equal(db.recent('guild').length,0)
  send('4','actor')
  assert.match(db.recent('guild')[0].detail,/3 tracked actions/)
})

test('Anti-Raid times out young accounts only after the join threshold', async t => {
  const db = createStore(':memory:')
  const client = new EventEmitter()
  const cleanup = attachProtection(client,db)
  t.after(() => { cleanup(); db.close() })
  const guild = {id:'guild',ownerId:'owner'}
  db.save('guild','raid',{...db.config('guild','raid'),threshold:3,action:'timeout'},'owner')
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


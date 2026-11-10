import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Events } from 'discord.js'
import { attachProtection } from '../bot.js'
import { createStore } from '../store.js'

test('spam cleanup removes at most five recent messages from the triggering member and channel', async t => {
  const db = createStore(':memory:')
  const client = new EventEmitter()
  client.user = {id:'bot'}
  const stop = attachProtection(client,db)
  t.after(() => { stop(); db.close() })
  const guild = {id:'guild',ownerId:'owner'}
  db.save(guild.id,'automod',{...db.config(guild.id,'automod'),enabled:true,threshold:6,action:'delete',spamActions:['delete'],spamEnabled:true},'owner')
  const deleted = []
  const send = async (id,channelId='bait',user='member') => {
    const author = {id:user,bot:false}
    const message = {id,channelId,guild,guildId:guild.id,author,member:{id:user,permissions:{has:() => false}},
      inGuild:() => true,deletable:true,delete:async () => {
        deleted.push(id)
        client.emit(Events.MessageDelete,message)
      }}
    client.emit(Events.MessageCreate,message)
    await new Promise(resolve => setImmediate(resolve))
  }
  await send('other-member','bait','other')
  await send('other-channel','elsewhere')
  for (let n=1;n<=5;n++) await send(String(n))
  assert.deepEqual(deleted,['1','2','3','4','5'])
  for (let n=6;n<=11;n++) await send(String(n))
  assert.deepEqual(deleted,['1','2','3','4','5','7','8','9','10','11'])
  assert.equal(new Set(deleted).size,deleted.length)
  assert.ok(!deleted.includes('other-member') && !deleted.includes('other-channel'))
})

test('spam cleanup does not run when Delete Message is not selected', async t => {
  const db = createStore(':memory:')
  const client = new EventEmitter()
  const stop = attachProtection(client,db)
  t.after(() => { stop(); db.close() })
  const guild = {id:'guild',ownerId:'owner'}
  db.save(guild.id,'automod',{...db.config(guild.id,'automod'),enabled:true,threshold:3,action:'warn',spamActions:['warn']},'owner')
  let deletes = 0
  const author = {id:'member',bot:false,send:async () => {}}
  const member = {id:author.id,user:author,guild,permissions:{has:() => false}}
  for (let n=0;n<3;n++) {
    client.emit(Events.MessageCreate,{id:String(n),channelId:'channel',guild,guildId:guild.id,author,member,
      inGuild:() => true,deletable:true,delete:async () => deletes++})
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(deletes,0)
})

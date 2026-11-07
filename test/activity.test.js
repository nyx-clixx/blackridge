import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Events } from 'discord.js'
import { mountAnalytics } from '../analytics.js'
import { createStore } from '../store.js'

test('analytics keeps separate server counts at UTC hour, day, and month boundaries', t => {
  const db = createStore(':memory:')
  t.after(() => db.close())
  const midnight = Date.UTC(2026,10,1)
  const hour = 3600000
  db.analytics.start('one',midnight-hour)
  db.analytics.add('one','messages',midnight-1)
  db.analytics.add('one','joins',midnight)
  db.analytics.add('one','joins',midnight)
  db.analytics.add('one','leaves',midnight)
  db.analytics.add('other','messages',midnight)
  const now = midnight+hour+1
  const hourly = db.analytics.range('one','day',now)
  assert.equal(hourly.since,midnight-hour)
  assert.equal(hourly.buckets.length,24)
  assert.deepEqual(hourly.buckets.slice(-3),[
    {at:midnight-hour,messages:1,joins:0,leaves:0},
    {at:midnight,messages:0,joins:2,leaves:1},
    {at:midnight+hour,messages:0,joins:0,leaves:0}
  ])
  const yearly = db.analytics.range('one','year',now)
  assert.equal(yearly.buckets.length,12)
  assert.equal(yearly.buckets.at(-2).messages,1)
  assert.equal(yearly.buckets.at(-1).joins,2)
  assert.equal(db.analytics.range('other','month',now).buckets.at(-1).messages,1)
  assert.equal(db.analytics.range('idle','week',now).since,null)
  db.analytics.prune(now+48*hour)
  assert.equal(db.analytics.range('one','day',now).buckets.at(-2).joins,0)
  assert.equal(db.analytics.range('one','year',now).buckets.at(-1).joins,2)
})

test('gateway analytics count human guild events and skip bots, webhooks, and DMs', () => {
  const seen = []
  const client = new EventEmitter()
  client.isReady = () => true
  client.guilds = {cache:new Map([['server',{id:'server',available:true}]])}
  mountAnalytics(client,{start:guild=>seen.push([guild,'start']),add:(...item)=>seen.push(item)})
  const guild = {id:'server'}
  const human = {bot:false}
  const bot = {bot:true}
  client.emit(Events.MessageCreate,{author:human})
  client.emit(Events.MessageCreate,{guildId:guild.id,author:bot})
  client.emit(Events.MessageCreate,{guildId:guild.id,author:human,webhookId:'webhook'})
  client.emit(Events.MessageCreate,{guildId:guild.id,author:human,system:true})
  client.emit(Events.MessageCreate,{guildId:guild.id,author:human})
  client.emit(Events.GuildMemberAdd,{guild,user:human})
  client.emit(Events.GuildMemberRemove,{guild,user:bot})
  client.emit(Events.GuildMemberRemove,{guild,user:human})
  assert.deepEqual(seen,[['server','start'],['server','messages'],['server','joins'],['server','leaves']])
})

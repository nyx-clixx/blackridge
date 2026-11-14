import assert from 'node:assert/strict'
import { createDecipheriv } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { ApplicationFlagsBitField, Collection, Events } from 'discord.js'
import { createStore } from '../store.js'
import { customBots } from '../custom-bot.js'

test('custom bot exposes its profile even while command and avatar requests are pending',{timeout:1000},async t => {
  const id = '1567687590532878467'
  const owner = '123456789012345678'
  const db = createStore(':memory:')
  t.after(() => db.close())
  const F = ApplicationFlagsBitField.Flags
  t.mock.method(globalThis,'fetch',async () => Response.json({
    id:'234567890123456789',owner:{id:owner},
    flags:F.GatewayPresenceLimited | F.GatewayGuildMembersLimited | F.GatewayMessageContentLimited
  }))
  const client = new EventEmitter()
  const pending = new Promise(() => {})
  const guild = {id,ownerId:owner,available:true,client,members:{me:{permissions:{has:() => true}}},
    commands:{fetch:() => pending}}
  client.guilds = {cache:new Collection([[id,guild]])}
  client.user = {id:'234567890123456789',username:'Fixture',fetch:() => pending,setPresence:() => {},
    displayAvatarURL:() => null,bannerURL:() => null}
  client.login = async () => { client.emit(Events.ClientReady,client) }
  client.isReady = () => true
  client.destroy = async () => {}
  const shared = {isReady:() => true,guilds:{cache:new Collection([[id,guild]])}}
  const service = customBots(db,() => shared,Buffer.alloc(32),() => client)
  t.after(() => service.close())
  await service.connect(id,owner,'fixture-token')
  assert.equal(service.active(id),guild)
  assert.equal(service.health(),true)
  guild.available = false
  assert.equal(service.health(),false)
  guild.available = true
  assert.equal(service.state(id,owner).connected,true)
  assert.equal(service.state(id,owner).username,'Fixture')
  const encrypted = Buffer.from(db.recovery(id,'customBot').secret,'base64url')
  const decipher = createDecipheriv('aes-256-gcm',Buffer.alloc(32),encrypted.subarray(0,12))
  decipher.setAAD(Buffer.from(id))
  decipher.setAuthTag(encrypted.subarray(12,28))
  assert.equal(Buffer.concat([decipher.update(encrypted.subarray(28)),decipher.final()]).toString(),'fixture-token')
})

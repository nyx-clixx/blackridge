import test from 'node:test'
import assert from 'node:assert/strict'
import { orderedBackupRoles, orderedBackupChannels } from '../public/backup-preview.js'
import { recoveryTools } from '../recovery.js'
import { createStore } from '../store.js'
import { Collection } from 'discord.js'
test('backup preview follows role hierarchy and channel category order without changing snapshots',() => {
  const roles = [{id:'low',position:1},{id:'high',position:9},{id:'guild',position:0},{id:'managed',position:10,managed:true}]
  assert.deepEqual(orderedBackupRoles(roles,'guild').map(x=>x.id),['high','low'])
  assert.equal(roles[0].id,'low')
  const channels = [{id:'voice',type:2,parent:'cat',position:0},{id:'text',type:0,parent:'cat',position:2},{id:'cat2',type:4,position:8},{id:'cat',type:4,position:1},{id:'general',type:0,position:3}]
  assert.deepEqual(orderedBackupChannels(channels).map(x=>[x.id,x.depth]),[['general',0],['cat',0],['text',1],['voice',1],['cat2',0]])
  assert.equal(channels[0].id,'voice')
})
test('manual backup cooldown survives a new recovery service and does not block scheduled backups',async t => {
  const db=createStore(':memory:');t.after(()=>db.close())
  let now=1000000;t.mock.method(Date,'now',()=>now)
  const guild={id:'guild',channels:{fetch:async()=>new Collection()},roles:{fetch:async()=>new Collection()},client:{rest:{get:async()=>({name:'Server'})}}}
  await recoveryTools(db).backup(guild,'owner')
  const next=db.recovery('guild','manualBackupCooldown').next
  await assert.rejects(recoveryTools(db).backup(guild,'owner'),error=>error.status===429)
  await recoveryTools(db).backup(guild,'automatic schedule',{manual:false})
  assert.equal(db.recovery('guild','manualBackupCooldown').next,next)
  now+=299999
  await assert.rejects(recoveryTools(db).backup(guild,'owner'),error=>error.status===429)
  now++
  await recoveryTools(db).backup(guild,'owner')
  assert.equal(db.recovery('guild','manualBackupCooldown').next,now+300000)
})

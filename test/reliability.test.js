import test from 'node:test'
import assert from 'node:assert/strict'
import { invokeBotEvent } from '../bot.js'
import { createLogDispatcher } from '../discord-logs.js'
import { messageCard } from '../messages.js'
test('bot event failures are handled without logging sensitive error messages',async t => {
  const errors=[];t.mock.method(console,'error',(...args)=>errors.push(args.join(' ')))
  invokeBotEvent(()=>{throw new Error('secret token')},[],'sync')
  invokeBotEvent(async()=>{throw new Error('secret token')},[],'async')
  let argument;invokeBotEvent(value=>{argument=value},['value'],'success')
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(argument,'value');assert.equal(errors.length,2)
  assert.ok(errors.every(line=>!line.includes('secret token')))
})
test('queued logs preserve files and keep same-named attachments in separate messages',async () => {
  const sent=[];const guild={id:'guild',client:{user:{id:'bot'}},channels:{cache:new Map([['channel',{type:0,guildId:'guild',isSendable:()=>true,send:async payload=>sent.push(payload)}]])}}
  const enqueue=createLogDispatcher(1)
  for(const value of ['first','second'])enqueue(guild,'channel',messageCard('Attached log',value,{files:[{name:'details.txt',attachment:Buffer.from(value)}]}))
  await new Promise(resolve=>setTimeout(resolve,30))
  assert.equal(sent.length,2)
  assert.deepEqual(sent.map(payload=>payload.files[0].attachment.toString()),['first','second'])
  assert.ok(sent.every(payload=>JSON.stringify(payload.components).includes('attachment://details.txt')))
})

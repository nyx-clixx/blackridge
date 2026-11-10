import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AuditLogEvent as A, ChannelType, Collection, Events, WebhookType } from 'discord.js'
import { attachActivityLogging } from '../activity-logging.js'
import { messageCard } from '../messages.js'
import { createLogDispatcher } from '../discord-logs.js'
import { attachModeration } from '../moderation.js'
import { createStore, policies } from '../store.js'

test('activity logging validates routes, separates moderation, and sends message metadata only',async () => {
  const db = createStore(':memory:')
  const client = new EventEmitter()
  client.user = {id:'10000000000000009'}
  const id = '10000000000000000'
  const roleLog = '10000000000000001'
  const modLog = '10000000000000002'
  const voice = '10000000000000003'
  const actor = '10000000000000004'
  const target = '10000000000000005'
  const channelId = '10000000000000006'
  const delivered = []
  const makeChannel = (type,destination) => ({type,guildId:id,isSendable:() => true,send:async payload => {
    delivered.push([destination,JSON.stringify(payload)])
  }})
  const channels = new Map([[roleLog,makeChannel(ChannelType.GuildText,roleLog)],
    [modLog,makeChannel(ChannelType.GuildAnnouncement,modLog)],[voice,makeChannel(ChannelType.GuildVoice,voice)]])
  const guild = {id,client,channels:{cache:channels,fetch:async id => channels.get(id)}}
  const config = {enabled:true,channels:{roleUpdate:roleLog,inviteCreate:roleLog,messageEdit:roleLog,messageDelete:roleLog,channelCreate:voice,serverLogo:roleLog,serverName:roleLog,serverUpdate:roleLog,emojiCreate:roleLog,stickerDelete:roleLog,soundboardSoundUpdate:roleLog}}
  assert.equal(policies.logging.safeParse(config).success,true)
  assert.equal(policies.logging.safeParse({enabled:true,channels:{typo:roleLog}}).success,false)
  db.save(id,'moderation',{enabled:true,alertChannel:modLog})
  const stopActivity = attachActivityLogging(client,db,createLogDispatcher(1),1)
  const stop = attachModeration(client,db)
  try {
    const audit = (action,extra={}) => client.emit(Events.GuildAuditLogEntryCreate,{
      action,executorId:actor,targetId:target,createdTimestamp:Date.now(),...extra
    },guild)
    const roleChange = () => audit(A.MemberRoleUpdate,{changes:[{key:'$add',new:[{id:target}]}]})
    roleChange()
    await new Promise(resolve => setTimeout(resolve,15))
    assert.deepEqual(delivered,[])
    db.save(id,'logging',config)
    roleChange()
    audit(A.ChannelCreate)
    audit(A.InviteCreate,{targetId:'privateInviteCode',reason:'private audit reason'})
    const message = {id:target,guild,channelId,author:{id:actor},content:'private message',editedTimestamp:1}
    client.emit(Events.MessageUpdate,{...message,editedTimestamp:0},message)
    client.emit(Events.MessageUpdate,message,message)
    client.emit(Events.MessageBulkDelete,new Collection([[target,message]]),{id:channelId,guild})
    await new Promise(resolve => setTimeout(resolve,25))
    assert.deepEqual(delivered.map(([to])=>to),[roleLog])
    assert.match(delivered[0][1],/Member Roles Updated/)
    assert.match(delivered[0][1],/Message Edited/)
    assert.doesNotMatch(delivered.map(([,payload])=>payload).join(''),/privateInviteCode|private audit reason|private message/)
    delivered.length = 0
    audit(A.GuildUpdate,{changes:[{key:'name'},{key:'icon_hash'},{key:'vanity_url_code',new:'privateInviteCode'}]})
    audit(A.EmojiCreate)
    audit(A.StickerDelete)
    audit(A.SoundboardSoundUpdate)
    for (let attempt = 0; delivered.length < 2 && attempt < 20; attempt++)
      await new Promise(resolve => setTimeout(resolve,10))
    const details = delivered.map(([,payload]) => payload).join('')
    for (const title of ['Server Name Updated','Server Logo Updated','Server Settings Updated','Emoji Created','Sticker Deleted','Soundboard Sound Updated'])
      assert.ok(details.includes(title),title)
    assert.doesNotMatch(details,/privateInviteCode/)
    const count = delivered.length
    db.save(id,'logging',{...config,enabled:false})
    client.emit(Events.MessageDelete,message)
    assert.equal(delivered.length,count)
  } finally { stopActivity(); stop(); db.close() }
})

test('Discord logs batch Components V2, reuse the owned webhook, and fall back when permissions change',async () => {
  const id = '10000000000000000'
  const channelId = '10000000000000001'
  const client = {user:{id:'10000000000000009'}}
  const sent = [], fallback = []
  let lookup = 0, branding = 0, denied = false
  const hook = {name:'Blackridge Logs',type:WebhookType.Incoming,owner:client.user,channelId,token:'test',
    edit:async ({avatar}) => {
      assert.ok(Buffer.isBuffer(avatar))
      branding++
      return hook
    },
    send:async payload => {
      if (denied) throw Object.assign(new Error('Unknown Webhook'),{code:10015})
      sent.push(payload)
    }}
  const channel = {type:ChannelType.GuildText,guildId:id,isSendable:() => true,
    fetchWebhooks:async () => { lookup++; return [hook] },createWebhook:async () => { throw new Error('Unexpected create') },
    send:async payload => fallback.push(payload)}
  const guild = {id,client,channels:{cache:new Map([[channelId,channel]])}}
  const enqueue = createLogDispatcher(1)
  const card = {flags:32768,components:[{type:17,components:[{type:10,content:'### <:User:1567545768733053089> Test'}]}],allowedMentions:{parse:[],roles:[]}}
  const flush = () => new Promise(resolve => setTimeout(resolve,20))
  enqueue(guild,channelId,card)
  enqueue(guild,channelId,card)
  await flush()
  assert.equal(sent.length,1)
  assert.equal(sent[0].components.length,2)
  assert.equal(sent[0].withComponents,true)
  assert.equal(sent[0].components[0].components[0].content,'### 👤 Test')
  enqueue(guild,channelId,card)
  await flush()
  assert.equal(sent.length,2)
  assert.equal(lookup,1)
  assert.equal(branding,1)
  denied = true
  enqueue(guild,channelId,card)
  await flush()
  assert.equal(fallback.length,1)
  assert.deepEqual(fallback[0].allowedMentions,{parse:[],roles:[]})
  for (let index = 0; index < 50; index++) enqueue(guild,channelId,messageCard('Message Filter Triggered','Action '+index,{icon:'sword'}))
  await flush()
  assert.equal(fallback.length,2)
  assert.equal(fallback[1].components.length,1)
  const body = fallback[1].components[0].components[2].content
  assert.equal(body.split('\n').length,50)
  assert.match(body,/Action 49/)
})

test('role changes group by member and actor within one window and use a new card after it',async () => {
  const client = new EventEmitter()
  client.user = {id:'10000000000000009'}
  const guild = {id:'10000000000000000'}
  const target = '10000000000000001'
  const actor = '10000000000000002'
  const firstRole = '10000000000000003'
  const secondRole = '10000000000000004'
  const destination = '10000000000000005'
  const deliveries = []
  let enabled = true
  const db = {config:() => ({enabled,channels:{roleUpdate:destination}})}
  const stop = attachActivityLogging(client,db,(_,channel,card) => deliveries.push({channel,card}),10)
  const change = (role,key = '$add') => client.emit(Events.GuildAuditLogEntryCreate,{
    action:A.MemberRoleUpdate,executorId:actor,targetId:target,createdTimestamp:Date.now(),changes:[{key,new:[{id:role}]}]
  },guild)
  const finishWindow = () => new Promise(resolve => setTimeout(resolve,25))
  try {
    change(firstRole)
    change(secondRole)
    change(firstRole,'$remove')
    assert.equal(deliveries.length,0)
    await finishWindow()
    assert.equal(deliveries.length,1)
    assert.equal(deliveries[0].channel,destination)
    const card = JSON.stringify(deliveries[0].card)
    assert.match(card,/3 changes/)
    assert.ok(card.includes('<@&'+secondRole+'>'))
    assert.match(card,/Roles Removed/)
    assert.match(card,/<:User:/)
    change(secondRole,'$remove')
    await finishWindow()
    assert.equal(deliveries.length,2)
    change(firstRole)
    enabled = false
    await finishWindow()
    assert.equal(deliveries.length,2)
  } finally { stop() }
})

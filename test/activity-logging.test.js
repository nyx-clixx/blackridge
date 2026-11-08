import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AuditLogEvent as A, ChannelType, Collection, Events } from 'discord.js'
import { attachActivityLogging } from '../activity-logging.js'
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
  const guild = {id,channels:{cache:channels,fetch:async id => channels.get(id)}}
  const config = {enabled:true,channels:{memberRoles:roleLog,inviteCreate:roleLog,messageEdit:roleLog,messageDelete:roleLog,channelCreate:voice}}
  assert.equal(policies.logging.safeParse(config).success,true)
  assert.equal(policies.logging.safeParse({enabled:true,channels:{typo:roleLog}}).success,false)
  db.save(id,'moderation',{enabled:true,alertChannel:modLog})
  attachActivityLogging(client,db)
  const stop = attachModeration(client,db)
  try {
    const audit = (action,extra={}) => client.emit(Events.GuildAuditLogEntryCreate,{
      action,executorId:actor,targetId:target,createdTimestamp:Date.now(),...extra
    },guild)
    const roleChange = () => audit(A.MemberRoleUpdate,{changes:[{key:'$add',new:[{id:target}]}]})
    roleChange()
    await new Promise(setImmediate)
    assert.deepEqual(delivered.map(([to])=>to),[modLog])
    delivered.length = 0
    db.save(id,'logging',config)
    roleChange()
    audit(A.ChannelCreate)
    audit(A.InviteCreate,{targetId:'privateInviteCode',reason:'private audit reason'})
    const message = {id:target,guild,channelId,author:{id:actor},content:'private message',editedTimestamp:1}
    client.emit(Events.MessageUpdate,{...message,editedTimestamp:0},message)
    client.emit(Events.MessageUpdate,message,message)
    client.emit(Events.MessageBulkDelete,new Collection([[target,message]]),{id:channelId,guild})
    await new Promise(setImmediate)
    assert.deepEqual(delivered.map(([to])=>to),[roleLog,roleLog,roleLog,roleLog])
    assert.match(delivered[0][1],/Member Roles Updated/)
    assert.match(delivered[2][1],/Message Edited/)
    assert.doesNotMatch(delivered.map(([,payload])=>payload).join(''),/privateInviteCode|private audit reason|private message/)
    db.save(id,'logging',{...config,enabled:false})
    client.emit(Events.MessageDelete,message)
    assert.equal(delivered.length,4)
  } finally { stop(); db.close() }
})

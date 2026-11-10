import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Collection, ChannelType } from 'discord.js'
import { createStore } from '../store.js'
import { recoveryTools } from '../recovery.js'

test('backup restore remaps recreated roles and categories and retries without duplicate objects',async t => {
  const db = createStore(':memory:')
  t.after(() => db.close())
  db.saveBackup('guild',{settings:{name:'Restored'},roles:[
    {id:'old-role',name:'Member',color:0,permissions:'1024',managed:false}
  ],channels:[
    {id:'old-channel',name:'chat',type:ChannelType.GuildText,parent:'old-category',overwrites:[{id:'old-role',type:0,allow:'1024',deny:'0'}]},
    {id:'old-category',name:'Community',type:ChannelType.GuildCategory,parent:null,overwrites:[]}
  ]})
  const id = db.backups('guild')[0].id
  const roles = new Collection(), channels = new Collection()
  let roleCreates=0,channelCreates=0
  const edited = []
  const makeChannel = options => ({...options,id:'channel-' + (++channelCreates),manageable:true,
    permissionOverwrites:{cache:new Collection()},edit:async options => edited.push(options)})
  const guild = {id:'guild',roles:{fetch:async () => roles,create:async options => ({
    ...options,id:'role-' + (++roleCreates),editable:true,edit:async () => {}
  })},channels:{fetch:async () => channels,create:async options => {
    const result=makeChannel(options);edited.push(options);return result
  }},edit:async options => edited.push(options)}
  const tools = recoveryTools(db)
  assert.deepEqual(await tools.restore(guild,'owner',id),[])
  assert.equal(roleCreates,1)
  assert.equal(channelCreates,2)
  const restored=edited.find(options=>options.name==='chat')
  assert.equal(restored.parent,'channel-1')
  assert.equal(restored.permissionOverwrites[0].id,'role-1')
  assert.equal(restored.permissionOverwrites[0].allow,1024n)
  assert.deepEqual(await tools.restore(guild,'owner',id),[])
  assert.equal(roleCreates,1)
  assert.equal(channelCreates,2)
  await assert.rejects(tools.restore({...guild,id:'other'},'owner',id),/Backup not found/)
})

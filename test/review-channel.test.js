import test from 'node:test'
import assert from 'node:assert/strict'
import { privateAppealChannel } from '../appeals.js'
import { PermissionFlagsBits as P, PermissionsBitField } from 'discord.js'
test('review channel checks refreshed effective role and bot permissions',async () => {
  let freshRoles=false,memberRefreshed=false,channelRefreshed=false,publicChannel=false,canPost=true
  const everyone={},staleMember={},freshMember={}
  const channel={guildId:'guild',type:0,isSendable:()=>true,permissionOverwrites:{cache:new Map()},permissionsFor:subject => {
    assert.ok(freshRoles)
    if(subject===everyone)return new PermissionsBitField(publicChannel ? P.ViewChannel : 0n)
    assert.equal(subject,freshMember)
    return new PermissionsBitField(canPost ? P.ViewChannel|P.SendMessages : P.ViewChannel)
  }}
  const guild={id:'guild',roles:{everyone,fetch:async()=>{freshRoles=true}},members:{me:staleMember,fetchMe:async options=>{memberRefreshed=options.force;return freshMember}},channels:{fetch:async(id,options)=>{channelRefreshed=options.force;return channel}}}
  assert.equal(await privateAppealChannel(guild,'channel',{explain:true}),channel)
  assert.ok(memberRefreshed && channelRefreshed)
  publicChannel=true
  await assert.rejects(privateAppealChannel(guild,'channel',{explain:true}),/deny View Channel/)
  assert.equal(await privateAppealChannel(guild,'channel'),null)
  publicChannel=false;canPost=false
  await assert.rejects(privateAppealChannel(guild,'channel',{explain:true}),/Custom Bot/)
  channel.type=2
  await assert.rejects(privateAppealChannel(guild,'channel',{explain:true}),/text or announcement/)
})

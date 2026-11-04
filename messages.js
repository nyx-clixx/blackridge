import { ComponentType as Type, MessageFlags, escapeMarkdown } from 'discord.js'

const icons = {
  bell:'<:Bell:1567545558665666771>',check:'<:CheckMark:1567545576797769769>',crown:'<:Crown:1567545590395572315>',
  warning:'<:ExclamationMark:1567545607621447690>',gear:'<:Gear:1567545629406928897>',hammer:'<:Hammer:1567545642987954216>',
  info:'<:Info:1567545745144291479>',locked:'<:Locked:1567545730200113332>',mail:'<:Mail:1567545700932124732>',
  inbox:'<:Mail:1567545714895102052>',shield:'<:Shield:1567545686931800185>',support:'<:Support:1567545671517741106>',
  sword:'<:Sword:1567545658951467138>',timer:'<:Timer:1567545831505137706>',trash:'<:Trash:1567545807849136299>',
  unlocked:'<:Unlocked:1567545790233321583>',user:'<:User:1567545768733053089>'
}
const colors = {info:0x6199ff,success:0x4bba82,warning:0xe8ae50,danger:0xe36c76}
export const safeText = value => escapeMarkdown(String(value ?? ''))
export function messageCard(title,body,{tone='info',icon='info',actions=[],roles=[],files=[],media,ephemeral=false} = {}) {
  const components = [{type:Type.TextDisplay,content:'### '+icons[icon]+' '+title}]
  if (body) components.push({type:Type.TextDisplay,content:body.slice(0,3500)})
  if (roles.length) components.push({type:Type.TextDisplay,content:roles.map(id=>'<@&'+id+'>').join(' ')})
  if (media) components.push({type:Type.MediaGallery,items:[{media:{url:'attachment://'+media},description:'Verification CAPTCHA'}]})
  for (const file of files) if (file.name !== media) components.push({type:Type.File,file:{url:'attachment://'+file.name}})
  components.push(...actions)
  return {
    flags:MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0),
    components:[{type:Type.Container,accent_color:colors[tone],components}],
    allowedMentions:{parse:[],roles},...(files.length ? {files} : {})
  }
}
const modules = {
  nuke:['Anti-Nuke','shield'],raid:['Anti-Raid','bell'],checkpoint:['Checkpoint','user'],
  automod:['Auto Moderation','sword'],moderation:['Moderation','hammer'],
  lockdown:['Lockdown','locked'],verification:['Verification','check'],appeals:['Ban Appeals','inbox']
}
export function logCard(kind,detail,roles=[]) {
  const [title,icon] = modules[kind] ?? ['Security Log','info']
  const parts = String(detail).split(' · ').map(safeText)
  const time = '<t:'+Math.floor(Date.now()/1000)+':f>'
  const [summary,...fields] = parts
  const body = [summary,...fields.map(field=>'• '+field)].join('\n').slice(0,3200)
  return messageCard(title,body+'\n\n-# '+time,{icon,tone:kind === 'nuke' || kind === 'raid' ? 'warning' : 'info',roles})
}

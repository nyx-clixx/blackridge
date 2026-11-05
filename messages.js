import { ComponentType as Type, MessageFlags, escapeMarkdown } from 'discord.js'

const icons = {
  bell:'🔔',check:'✅',crown:'👑',warning:'⚠️',gear:'⚙️',hammer:'🔨',info:'ℹ️',
  locked:'🔒',mail:'✉️',inbox:'📥',shield:'🛡️',support:'💬',sword:'⚔️',timer:'⏱️',
  trash:'🗑️',unlocked:'🔓',user:'👤'
}
export const safeText = value => escapeMarkdown(String(value ?? ''))
const validId = id => /^\d{17,20}$/.test(id ?? '')
export const mention = (id,type='user') => validId(id) ? '<'+({user:'@',role:'@&',channel:'#'})[type]+id+'>' : 'Unknown'
export const timestamp = (at,style='f') => '<t:'+Math.floor(at/1000)+':'+style+'>'
export function messageCard(title,body,{tone='info',icon,actions=[],roles=[],files=[],media,ephemeral=false,fields=[],userId,at=Date.now()} = {}) {
  const symbol = icon ?? ({success:'check',warning:'warning',danger:'warning'})[tone] ?? 'info'
  const components = [
    {type:Type.TextDisplay,content:'### '+(icons[symbol] ?? icons.info)+' '+title},
    {type:Type.Separator,divider:true,spacing:1}
  ]
  if (body) components.push({type:Type.TextDisplay,content:body.slice(0,3500)})
  const details = fields.filter(([,value])=>value).map(([label,value])=>'**'+label+'**\n'+value).join('\n')
  if (details) components.push({type:Type.TextDisplay,content:details.slice(0,800)})
  components.push({type:Type.TextDisplay,content:'-# '+(validId(userId) ? 'User ID: '+userId+' · ' : '')+timestamp(at)})
  if (roles.length) components.push({type:Type.TextDisplay,content:roles.map(id=>'<@&'+id+'>').join(' ')})
  if (media) components.push({type:Type.MediaGallery,items:[{media:{url:'attachment://'+media},description:'Verification CAPTCHA'}]})
  for (const file of files) if (file.name !== media) components.push({type:Type.File,file:{url:'attachment://'+file.name}})
  components.push(...actions)
  return {
    flags:MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0),
    components:[{type:Type.Container,components}],
    allowedMentions:{parse:[],roles},...(files.length ? {files} : {})
  }
}
const memberActions = {
  ban:['Member Banned','was banned','hammer'],tempban:['Member Temporarily Banned','was temporarily banned','timer'],
  kick:['Member Kicked','was kicked','hammer'],warn:['Member Warned','was warned','warning'],
  timeout:['Member Timed Out','was timed out','timer'],unban:['Member Unbanned','was unbanned','unlocked'],
  untimeout:['Member Timeout Removed','had their timeout removed','unlocked'],quarantine:['Member Quarantined','was quarantined','locked'],
  'force-verify':['Member Verified','was verified by a moderator','check']
}
export function memberAction(action,{userId,actor,reason,server,until,at=Date.now(),dm=false}) {
  const [title,verb,icon] = memberActions[action]
  const subject = dm ? 'You' : mention(userId)
  const phrase = dm ? (verb.startsWith('was ') ? 'were '+verb.slice(4) : verb) : verb
  const duration = Number.isFinite(until) ? ' until '+timestamp(until)+' ('+timestamp(until,'R')+')' : ''
  return {
    title,body:subject+' '+phrase+duration+'.',
    options:{icon,userId,at,fields:[
      ['Server',server ? safeText(server) : null],
      ['Moderator',validId(actor) ? mention(actor)+' (`'+actor+'`)' : null],
      ['Reason',reason ? safeText(reason).slice(0,520) : null]
    ]}
  }
}
export const actionCard = (action,extra={}) => messageCard(action.title,action.body,{...action.options,...extra})
const modules = {
  nuke:['Anti-Nuke','shield'],raid:['Anti-Raid','bell'],checkpoint:['Checkpoint','user'],
  automod:['Auto Moderation','sword'],moderation:['Moderation','hammer'],
  lockdown:['Lockdown','locked'],verification:['Verification','check'],appeals:['Ban Appeals','inbox']
}
export function logCard(kind,detail,roles=[]) {
  if (typeof detail === 'object') return actionCard(detail,{roles})
  const [label,icon] = modules[kind] ?? ['Security Log','info']
  const title = /^(?:Protection error|Response blocked)/.test(detail) ? label+' · Action Failed' :
    kind === 'nuke' && detail.startsWith('Blackridge Anti-Nuke:') ? 'Anti-Nuke Threshold Reached' :
    kind === 'raid' && detail.startsWith('Blackridge raid detected:') ? 'Join Surge Detected' :
    kind === 'automod' && detail.startsWith('Matched ') ? 'Message Filter Triggered' : label
  const parts = String(detail).split(' · ').map(safeText)
  const [summary,...fields] = parts
  const body = [summary,...fields.map(field=>'• '+field)].join('\n').slice(0,3200)
  return messageCard(title,body,{icon,roles})
}

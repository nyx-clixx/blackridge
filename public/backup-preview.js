const position = item => Number(item.position ?? 0)
const byPosition = (a,b) => position(a)-position(b) || String(a.id).localeCompare(String(b.id))
const voice = item => [2,13].includes(item.type) ? 1 : 0
const byChannel = (a,b) => voice(a)-voice(b) || byPosition(a,b)
export const orderedBackupRoles = (roles,guildId) => roles.filter(role => !role.managed && role.id !== guildId).sort((a,b) => position(b)-position(a) || String(a.id).localeCompare(String(b.id)))
export function orderedBackupChannels(channels) {
  const categories = channels.filter(channel => channel.type === 4).sort(byPosition)
  const parents = new Set(categories.map(channel => channel.id))
  const rows = channels.filter(channel => channel.type !== 4 && !parents.has(channel.parent)).sort(byChannel).map(channel => ({...channel,depth:0}))
  for (const category of categories) {
    rows.push({...category,depth:0})
    rows.push(...channels.filter(channel => channel.type !== 4 && channel.parent === category.id).sort(byChannel).map(channel => ({...channel,depth:1})))
  }
  return rows
}

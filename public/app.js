const app = document.querySelector('#app')
const account = document.querySelector('#account')
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char])
const iconPaths = {
  lockdown:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  backup:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  premium:'<path d="m3 6 4 4 5-6 5 6 4-4-2 12H5L3 6Zm3 15h12"/>',
  checkpoint:'<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3"/><circle cx="12" cy="10" r="2.5"/><path d="M8 17a4 4 0 0 1 8 0"/>',
  automod:'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2" fill="var(--panel)"/><circle cx="15" cy="12" r="2" fill="var(--panel)"/><circle cx="10" cy="18" r="2" fill="var(--panel)"/>',
  moderation:'<path d="M5 4h14v16H5zM8 8h8M8 12h8m-8 4h4"/>',
  permits:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/>',
  overview:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  nuke:'<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/>',
  raid:'<path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2m19 0v-2a4 4 0 0 0-3-4m-2-12a4 4 0 0 1 0 8"/><circle cx="9.5" cy="7" r="4"/>',
  logs:'<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  server:'<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>'
}
const icon = key => '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (iconPaths[key] ?? iconPaths.nuke) + '</svg>'
for (const tile of document.querySelectorAll('[data-icon]')) tile.innerHTML = icon(tile.dataset.icon)
const sections = { overview:'Overview', premium:'Premium', nuke:'Anti-Nuke', raid:'Anti-Raid', logs:'Security logs', checkpoint:'Checkpoint', automod:'Auto Moderation', moderation:'Moderation', permits:'Permits', lockdown:'Lockdown', backup:'Server Backups' }
const request = async (url, options) => {
  const res = await fetch(url, options)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Request failed.')
  return data
}
const shell = html => { app.innerHTML = '<div class="wrap dashboard">' + html + '</div>' }
const logList = entries => entries.length ? entries.map(event => '<div class="log-row"><span class="badge">' + esc(sections[event.kind] || 'Settings') + '</span><span>' + esc(event.detail) + '</span><time datetime="' + new Date(event.at).toISOString() + '">' + esc(new Date(event.at).toLocaleString()) + '</time></div>').join('') : '<p class="empty">' + icon('logs') + ' No security events in this view.</p>'
const base = '/dashboard'
const rateLabels = {
  moderation:'Kicks and bans', roleCreate:'Role creations', roleDelete:'Role deletions',
  channelCreate:'Channel creations', channelDelete:'Channel deletions', webhookCreate:'Webhook creations'
}
const sensitivity = [['Low',20],['Medium',10],['High',5],['Custom',0]]
const filters = {
  multiUser:['Multi-user spam',4],scam:['Common scam patterns',1],badWords:['Blocked words and phrases',1],
  images:['Image attachments',3],stickers:['Stickers',1],invites:['Discord invites',1],caps:['Excessive caps (%)',80],
  duplicate:['Duplicate text',3],emoji:['Emoji spam',10],mentions:['Mass mentions',5],links:['Links',3],
  files:['Attachments',3],newlines:['Newlines',12],headers:['Markdown headings',1],length:['Message length',1500],
  ghost:['Ghost mentions (cached deletions)',1],nsfw:['Blocked NSFW domains',1]
}
function options(labels, selected) {
  return Object.entries(labels).map(([value,label]) => '<option value="' + value + '"' + (selected === value ? ' selected' : '') + '>' + label + '</option>').join('')
}
function extraControls(section,config) {
  if (section === 'automod') {
    const cards = Object.entries(filters).map(([key,[label,limit]]) => {
      const rule = config.filters?.[key]
      const actions = {off:'Disabled',log:'Log',...(key === 'ghost' ? {} : {delete:'Delete message',timeout:'Timeout'})}
      return '<article class="filter-card"><h3>' + label + '</h3><div class="fields"><label>Response<select name="' + key + '-action">' + options(actions,rule?.action ?? 'off') + '</select></label><label>Threshold<input type="number" required min="1" max="4000" name="' + key + '-limit" value="' + esc(rule?.limit ?? limit) + '"></label></div></article>'
    }).join('')
    return '<section class="policy-group"><h3>Message filters</h3><p>Text and attachment filters require Message Content access. Domain checks use your list and do not open URLs.</p><div class="grid filter-grid">' + cards + '</div></section>'
  }
  if (section === 'checkpoint') {
    const rows = Array.from({length:3},(_,index) => {
      const rule = config.rules?.[index]
      return '<article class="filter-card"><h3>Rule ' + (index+1) + '</h3><div class="fields"><label>Minimum score<input type="number" min="1" max="25" required name="score-' + index + '" value="' + esc(rule?.score ?? config.threshold) + '"></label><label>Response<select name="rule-' + index + '">' + options({off:'Disabled',log:'Log and alert',kick:'Kick',quarantine:'Quarantine',tempban:'Temporary ban'},rule?.action ?? 'off') + '</select></label></div></article>'
    }).join('')
    return '<section class="policy-group"><h3>Risk score rules</h3><p>The highest matching threshold wins. If all rules are disabled, the minimum score above controls logging and alerts.</p><div class="grid filter-grid">' + rows + '</div></section>'
  }
  return ''
}
function protectionControls(form, section, config) {
  const button = form.querySelector('button')
  button.insertAdjacentHTML('beforebegin',extraControls(section,config))
  if (section === 'nuke') {
    const rows = Object.entries(rateLabels).map(([key,label]) => {
      const rule = config.rates?.[key] ?? config
      return '<div class="rate-row"><label class="toggle"><input type="checkbox" name="' + key + '-enabled"' + ((!config.rates || rule.enabled) ? ' checked' : '') + '> ' + label + '</label><div class="fields"><label>Actions<input required type="number" min="2" max="30" name="' + key + '-threshold" value="' + rule.threshold + '"></label><label>Window in seconds<input required type="number" min="5" max="120" name="' + key + '-window" value="' + rule.window + '"></label></div></div>'
    }).join('')
    button.insertAdjacentHTML('beforebegin','<section class="rate-settings"><h3>Per-action rate limits</h3><label class="toggle"><input type="checkbox" name="custom-rates"' + (config.rates ? ' checked' : '') + '> Enable separate limits</label><div class="stack">' + rows + '</div></section>')
    return
  }
  if (section !== 'raid') return
  const matched = sensitivity.find(([,count]) => count && config.window === 10 && config.threshold === count)?.[1] ?? 0
  form.querySelector('.fields').insertAdjacentHTML('beforebegin','<div class="fields"><label>Detection sensitivity<select name="sensitivity">' + sensitivity.map(([label,count]) => '<option value="' + count + '"' + (matched === count ? ' selected' : '') + '>' + label + (count ? ' · ' + count + ' joins / 10 s' : '') + '</option>').join('') + '</select></label></div>')
  const preset = form.elements.sensitivity
  preset.onchange = () => {
    if (!Number(preset.value)) return
    form.elements.threshold.value = preset.value
    form.elements.window.value = 10
  }
  for (const key of ['threshold','window']) form.elements[key].oninput = () => { preset.value = '0' }
}
const alerts = [['alertChannel','Discord logging channel'],['alertRoles','Roles to notify']]
const timedResponses = [['tempBanMinutes','Temporary ban duration (minutes)',1,1440],['quarantineMinutes','Quarantine duration (minutes)',1,1440]]
const settingFields = {
  nuke: [['threshold','Actions per actor',2,30],['window','Detection window (seconds)',5,120],['trusted','Trusted Discord user IDs (comma-separated)'],...alerts,...timedResponses],
  raid: [['threshold','Joins to trigger',3,100],['window','Detection window (seconds)',5,120],['duration','Protection duration (seconds)',15,600],['age','Maximum account age (days, 0 for all)',0,365],['timeoutMinutes','Timeout duration (minutes)',1,1440],...alerts,...timedResponses],
  checkpoint: [['age','Young account threshold (days)',1,365],['agePoints','Points for a young account',0,5],['avatarPoints','Points for a default avatar',0,5],['rejoinPoints','Points for 3 joins in an hour',0,5],['similarPoints','Points for a burst of similar accounts',0,5],['inviteNamePoints','Points for invite links in display names',0,5],['threshold','Minimum score to log and alert',1,25],...timedResponses,...alerts],
  automod: [['threshold','Messages per member',3,30],['window','Detection window (seconds)',2,60],['timeoutMinutes','Timeout duration (minutes)',1,1440],...alerts,['badWords','Blocked phrases (comma-separated)'],['nsfwDomains','Blocked domains (comma-separated)']]
}
const actionsByKind = {
  nuke:['log','strip','quarantine','kick','ban','tempban'],
  raid:['log','timeout','quarantine','kick','ban','tempban'],
  automod:['log','timeout']
}
const actionLabels = {log:'Log only',timeout:'Time out',strip:'Remove dangerous roles',quarantine:'Quarantine (Discord timeout)',kick:'Kick',ban:'Ban',tempban:'Temporary ban'}
const commandNames = ['ban','kick','timeout','warn','tempban','lock','unlock']
const ids = value => value.split(',').map(id => id.trim()).filter(Boolean)

function permitsForm(config) {
  const rows = commandNames.map(name => '<section class="policy-group"><h3>/' + name + '</h3><div class="fields"><label>User IDs<input name="' + name + '-users" maxlength="330" value="' + esc(config[name].users.join(', ')) + '"></label><label>Roles<input name="' + name + '-roles" maxlength="330" value="' + esc(config[name].roles.join(', ')) + '"></label></div></section>').join('')
  return '<form class="card" id="settings"><h3>Command access</h3><p>Enter up to 15 comma-separated user IDs and select up to 15 roles per command. Delegates also need the corresponding Discord permission.</p>' + rows + '<button class="button primary">Save permits</button><p id="notice" role="status"></p></form>'
}

async function accountMenu(me) {
  if (!me.user) return
  const avatar = me.user.avatar ? '<img alt="" src="https://cdn.discordapp.com/avatars/' + esc(me.user.id) + '/' + esc(me.user.avatar) + '.png?size=64">' : '<span class="initial">' + esc(me.user.username.slice(0,1)) + '</span>'
  account.outerHTML = '<details class="account-menu"><summary class="button small">' + avatar + '<span>' + esc(me.user.username) + '</span></summary><div class="account-links">' + '<a href="/support">Support Server</a>' + '<a href="/premium">Premium</a><button type="button" id="sign-out">Log out</button></div></details>'
  document.querySelector('#sign-out').onclick = async () => {
    try { await request('/auth/logout',{method:'POST'}); location.assign(base) }
    catch (error) { alert(error.message) }
  }
}
function premium() {
  shell('<h2>Blackridge Premium</h2>' + premiumPlans())
}
function premiumPlans() {
  const features = ['Advanced Anti-Nuke','Advanced Anti-Raid','Advanced Auto Moderation']
  return '<div class="grid pricing">' + [
    ['blue','Blackridge Premium','$2.99',features],
    ['purple','Blackridge White Label','$4.99',[...features,'Custom branding']]
  ].map(([theme,name,price,items]) => '<article class="card plan plan-' + theme + '"><span class="icon-tile">' + icon('premium') + '</span><h3>' + name + '</h3><strong>' + price + '</strong><ul>' + items.map(item => '<li>' + item + '</li>').join('') + '</ul><span class="badge">Coming soon</span></article>').join('') + '</div>'
}
function form(kind, config, owner) {
  const disabled = owner ? '' : ' disabled'
  const fields = group => group.map(([key,label,min,max]) => '<label>' + label + '<input name="' + key + '" value="' + esc(Array.isArray(config[key]) ? config[key].join(', ') : config[key]) + '"' + (min === undefined ? ' maxlength="500"' : ' type="number" required min="' + min + '" max="' + max + '"') + '></label>').join('')
  const response = actionsByKind[kind] ? '<label>Response<select name="action">' + actionsByKind[kind].map(action => '<option value="' + action + '"' + (config.action === action ? ' selected' : '') + '>' + actionLabels[action] + '</option>').join('') + '</select></label>' : ''
  const alertFields = settingFields[kind].filter(([key]) => key.startsWith('alert'))
  const baseFields = settingFields[kind].filter(([key]) => !key.startsWith('alert'))
  return '<form class="card" id="settings"><h3>' + (kind === 'automod' ? 'Anti-Spam' : sections[kind] + ' policy') + '</h3><p>' + (owner ? 'Set detection thresholds and how Blackridge responds.' : 'Only the server owner can change this policy.') + '</p><fieldset' + disabled + '><label class="toggle"><input type="checkbox" name="enabled"' + (config.enabled ? ' checked' : '') + '> Enable detection</label><div class="fields">' + fields(baseFields) + response + '</div>' + (alertFields.length ? '<section class="policy-group"><h3>Discord alerts</h3><div class="fields">' + fields(alertFields) + '</div></section>' : '') + '<button class="button primary">Save settings</button></fieldset><p role="status" id="notice"></p></form>'
}
function discordSelect(name,items,values,multiple = false) {
  const selected = new Set(values.filter(Boolean))
  const available = new Set(items.map(item => item.id))
  const choices = [...items,...[...selected].filter(id => !available.has(id)).map(id => ({id,name:'Deleted or unavailable (' + id + ')'}))]
  return '<select name="' + name + '"' + (multiple ? ' multiple size="4"' : '') + '>' + (multiple ? '' : '<option value="">None</option>') + choices.map(item => '<option value="' + esc(item.id) + '"' + (selected.has(item.id) ? ' selected' : '') + '>' + esc(item.name) + '</option>').join('') + '</select>'
}
async function wireDiscordSelectors(form,path,section) {
  const choices = await request(path + '/options')
  const channel = form.elements.alertChannel
  if (channel) channel.outerHTML = discordSelect('alertChannel',choices.channels.filter(item => item.sendable),[channel.value])
  const roleFields = section === 'permits' ? commandNames.map(name => name + '-roles') : ['alertRoles']
  for (const name of roleFields) {
    const input = form.elements[name]
    if (input) input.outerHTML = discordSelect(name,choices.roles,ids(input.value),true)
  }
}
async function recoveryPanel(section,path,data) {
  const panel = document.querySelector('#recovery')
  if (!data.owner) {
    if (section !== 'moderation') panel.innerHTML = '<p>Only the server owner can manage recovery operations.</p>'
    return
  }
  const {channels,roles} = await request(path + '/options')
  const state = section === 'moderation' ? {} : await request(path + '/recovery')
  const channel = discordSelect('alertChannel',channels.filter(item => item.sendable),[data.config[section]?.alertChannel])
  let controls = ''
  if (section === 'lockdown') {
    controls = state.lockdown
      ? '<form class="card stack" data-operation="lift"><h3>Lockdown active</h3><p>Started ' + esc(new Date(state.lockdown).toLocaleString()) + '</p><div class="fields"><label>Type LIFT LOCKDOWN<input name="confirm" required></label></div><button class="button primary">Lift Lockdown</button></form>'
      : '<form class="card stack" data-operation="enable"><h3>Lockdown controls</h3><p>Channel locks modify @everyone. Invite and DM pauses are applied for one hour where Discord exposes the current state.</p><div class="fields"><label>Channels' + discordSelect('channels',channels,[],true) + '</label><label>Collection role' + discordSelect('collection',roles,[]) + '</label></div><label class="toggle"><input type="checkbox" name="all"> Lock all supported channels</label><label class="toggle"><input type="checkbox" name="verification"> Raise verification to highest</label><label class="toggle"><input type="checkbox" name="invites"> Pause invites</label><label class="toggle"><input type="checkbox" name="dms"> Pause direct messages</label><div class="fields"><label>Type ENABLE LOCKDOWN<input name="confirm" required></label></div><button class="button primary">Enable Lockdown</button></form>'
  }
  if (section === 'backup') {
    const history = (state.backups ?? []).map(item => '<option value="' + item.id + '">' + esc(new Date(item.at).toLocaleString()) + '</option>').join('')
    controls = '<form class="card stack" data-operation="backup"><h3>Manual backup</h3><p>Save server settings, roles, channels and overwrites. The latest 20 backups are retained.</p><button class="button">Create Backup</button></form><form class="card stack" data-operation="schedule"><h3>Automatic backups</h3><div class="fields"><label>Frequency<select name="hours">' + options({0:'Disabled',6:'Every 6 hours',12:'Every 12 hours',24:'Daily',168:'Weekly'},String(state.schedule?.hours ?? 0)) + '</select></label></div><button class="button">Save Schedule</button></form>' +
      (history ? '<form class="card stack" data-operation="restore"><h3>Backup history</h3><p>Restore supported settings and recreate eligible deleted roles and channels. Messages, role memberships, member overwrites, and ordering require manual recovery.</p><div class="fields"><label>Backup<select name="id">' + history + '</select></label><label>Type RESTORE BACKUP<input name="confirm" required></label></div><button class="button primary">Restore Backup</button></form>' : '<p class="stack">No backups yet.</p>')
  }
  panel.innerHTML = '<form class="card stack" data-operation="logging"><h3>Discord logging</h3><div class="fields"><label>Logging channel' + channel + '</label></div><button class="button">Save Logging</button></form>' + controls + '<p class="stack" role="status"></p>'
  const status = panel.querySelector('[role="status"]')
  for (const form of panel.querySelectorAll('form')) form.onsubmit = async event => {
    event.preventDefault()
    const operation = form.dataset.operation
    const fields = new FormData(form)
    const payload = Object.fromEntries(fields)
    if (operation === 'enable') {
      payload.channels = fields.getAll('channels')
      for (const key of ['all','verification','invites','dms']) payload[key] = fields.has(key)
    }
    if (operation === 'restore') payload.id = Number(payload.id)
    if (operation === 'schedule') payload.hours = Number(payload.hours)
    const button = form.querySelector('button')
    button.disabled = true
    try {
      const result = await request(operation === 'logging' ? path + '/' + section : path + '/recovery/' + operation,{
        method:operation === 'logging' ? 'PUT' : 'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)
      })
      if (operation !== 'logging') await recoveryPanel(section,path,data)
      panel.querySelector('[role="status"]').textContent = result.notices?.join(' ') || 'Saved.'
    } catch (error) { status.textContent = error.message }
    finally { button.disabled = false }
  }
}
async function dashboard() {
  document.body.classList.add('dashboard-page')
  shell('<p role="status">Loading dashboard…</p>')
  const [, , id, rawSection] = location.pathname.split('/')
  const section = Object.hasOwn(sections, rawSection) ? rawSection : 'overview'
  try {
    const me = await request('/api/me')
    if (!me.user) {
      shell('<div class="card signin-card"><a class="button small close-signin" href="/" aria-label="Close sign-in">×</a><h2>Manage Servers</h2><p>Connect your Discord account to continue.</p><a class="button primary" href="/auth/login">Sign In with Discord</a>' + (me.configured ? '' : '<p class="muted">Discord sign-in is awaiting application setup.</p>') + (location.search ? '<p class="error">Sign-in could not be completed. Please try again.</p>' : '') + '</div>')
      return
    }
    await accountMenu(me)
    if (!id) {
      const { guilds } = await request('/api/guilds')
      shell('<h2>Select a server</h2><div class="servers">' + guilds.map(guild => '<article class="card server-card"><div class="server-avatar">' + (guild.icon ? '<img alt="" src="https://cdn.discordapp.com/icons/' + esc(guild.id) + '/' + esc(guild.icon) + '.png">' : esc(guild.name.slice(0,2).toUpperCase())) + '</div><h3>' + esc(guild.name) + '</h3><div class="muted">' + (guild.owner ? 'Owner' : 'Manager') + '</div><a class="button small" href="' + (guild.installed ? base + '/' + guild.id : '/invite?guild=' + guild.id) + '">' + (guild.installed ? 'Manage' : 'Set up') + '</a></article>').join('') + '</div>' + (guilds.length ? '' : '<div class="card">No servers with management access were found.</div>'))
      return
    }
    const path = '/api/guilds/' + encodeURIComponent(id)
    const data = await request(path)
    if (section === 'permits' && !data.owner) throw new Error('Only the server owner can view permits.')
    const descriptions = {
      premium:'Explore Blackridge plans for your server.',
      checkpoint:'Score new accounts by age and avatar to flag risky joins.',
      automod:'Detect repeated messages by rate without inspecting message content.',
      moderation:'Review recorded moderation actions and available slash commands.',
      permits:'Delegate specific commands to roles or individual members.',
      overview:'Review security activity and manage your protection modules.',
      nuke:'Set limits for destructive actions and choose how Blackridge responds.',
      raid:'Detect join surges and configure alerts and automatic responses.',
      logs:'Review recent detections, responses, and policy changes.'
    }
    const heading = '<div class="page-heading"><span class="icon-tile">' + icon(section) + '</span><div><h2 class="dash-title">' + sections[section] + '</h2></div></div>'
    const activity = '<section class="card stack"><h3>' + (section === 'logs' ? 'Event history' : 'Recent activity') + '</h3><div id="events">' + logList(data.events.slice(0, section === 'logs' ? 100 : 6)) + '</div></section>'
    const summary = value => '<div class="card"><span class="muted">Events · 24 hours</span><strong class="stat">' + value.total + '</strong></div><div class="card"><span class="muted">Anti-Nuke</span><strong class="stat">' + value.nuke + '</strong></div><div class="card"><span class="muted">Anti-Raid</span><strong class="stat">' + value.raid + '</strong></div>'
    const serverPath = base + '/' + encodeURIComponent(id)
    const navigation = key => '<a href="' + serverPath + '/' + key + '"' + (key === section ? ' aria-current="page"' : '') + '>' + icon(key) + sections[key] + '</a>'
    const modules = ['nuke','raid','checkpoint','automod'].map(key => '<article class="card"><div class="module-head"><span class="icon-tile">' + icon(key) + '</span><h3>' + sections[key] + '</h3><span class="badge">' + (data.config[key].enabled ? '<i class="dot"></i> Enabled' : 'Disabled') + '</span></div><p>' + descriptions[key] + '</p><a class="module-link" href="' + serverPath + '/' + key + '">Configure ' + sections[key] + icon('arrow') + '</a></article>').join('')
    const enabled = ['nuke','raid','checkpoint','automod'].filter(key => data.config[key].enabled).length
    const score = '<section class="card score-card"><div><h3>Security score</h3><p>' + enabled + ' of 4 protection modules enabled</p></div><meter min="0" max="4" value="' + enabled + '" aria-label="Enabled protection modules"></meter><strong>' + enabled * 25 + '%</strong></section>'
    const overview = score + '<div id="stats" class="stats">' + summary(data.stats) + '</div><section class="stack module-section"><h3>Protection modules</h3><div class="grid">' + modules + '</div></section>' + activity
    document.body.classList.add('has-workspace')
    shell('<div class="dash-layout"><nav class="sidebar" aria-label="Server navigation"><a class="server-switch" title="Switch server" href="' + base + '">' + (data.icon ? '<img class="switch-avatar" src="https://cdn.discordapp.com/icons/' + encodeURIComponent(id) + '/' + encodeURIComponent(data.icon) + '.png?size=64" alt="">' : icon('server')) + '<span>' + esc(data.name) + '</span></a>' + navigation('overview') + navigation('premium') + navigation('logs') + '<span class="nav-label">Protection</span>' + navigation('nuke') + navigation('raid') + navigation('checkpoint') + navigation('lockdown') + '<span class="nav-label">Administration</span>' + navigation('automod') + navigation('moderation') + navigation('backup') + (data.owner ? navigation('permits') : '') + '</nav><div class="dash-main">' + heading + (section === 'overview' ? overview : section === 'premium' ? premiumPlans() : section === 'logs' ? activity : section === 'permits' ? permitsForm(data.config.permits) : ['lockdown','backup'].includes(section) ? '<div id="recovery"></div>' : section === 'moderation' ? '<div id="recovery"></div><section class="card"><h3>Slash commands</h3><p>' + commandNames.map(name => '/' + name).join(' · ') + '</p><h3 class="stack">Recent cases</h3>' + logList(data.events.filter(event => event.kind === 'moderation')) + '</section>' : form(section,data.config[section],data.owner)) + '<p id="refresh" role="status"></p></div></div>')
    if (['lockdown','backup','moderation'].includes(section)) await recoveryPanel(section,path,data)
    const settings = document.querySelector('#settings')
    if (settings && (settings.elements.alertChannel || section === 'permits')) {
      await wireDiscordSelectors(settings,path,section)
    }
    if (settings && settingFields[section]) protectionControls(settings,section,data.config[section])
    if (settings) settings.onsubmit = async event => {
      event.preventDefault()
      const fields = new FormData(settings)
      const payload = section === 'permits' ? Object.fromEntries(commandNames.map(name => [name,{users:ids(fields.get(name + '-users')),roles:fields.getAll(name + '-roles')}])) : {enabled:fields.has('enabled')}
      if (fields.has('action')) payload.action = fields.get('action')
      if (section === 'automod') payload.filters = Object.fromEntries(Object.keys(filters).map(key => [key,{
        action:fields.get(key + '-action'),limit:Number(fields.get(key + '-limit'))
      }]))
      if (section === 'checkpoint') payload.rules = Array.from({length:3},(_,index) => ({
        score:Number(fields.get('score-' + index)),action:fields.get('rule-' + index)
      })).filter(rule => rule.action !== 'off')
      if (fields.has('custom-rates')) {
        payload.rates = Object.fromEntries(Object.keys(rateLabels).map(key => [key,{
          enabled:fields.has(key + '-enabled'),
          threshold:Number(fields.get(key + '-threshold')),
          window:Number(fields.get(key + '-window'))
        }]))
      }
      for (const [key,,min] of (settingFields[section] ?? [])) payload[key] = min === undefined ? fields.get(key) : Number(fields.get(key))
      if (fields.has('alertChannel')) {
        payload.alertChannel = payload.alertChannel.trim()
        payload.alertRoles = fields.getAll('alertRoles')
      }
      const notice = document.querySelector('#notice')
      const button = settings.querySelector('button')
      button.disabled = true
      try { await request(path + '/' + section,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}); notice.textContent = 'Settings saved.' }
      catch (error) { notice.textContent = error.message }
      finally { button.disabled = false }
    }
    if (section === 'overview' || section === 'logs') {
      const refresh = async () => {
        try {
          if (!document.hidden) {
            const latest = await request(path)
            document.querySelector('#events').innerHTML = logList(latest.events.slice(0,section === 'logs' ? 100 : 6))
            if (section === 'overview') document.querySelector('#stats').innerHTML = summary(latest.stats)
            document.querySelector('#refresh').textContent = ''
          }
        } catch (error) { document.querySelector('#refresh').textContent = error.message }
        setTimeout(refresh, 15000)
      }
      setTimeout(refresh, 15000)
    }
  } catch (error) { shell('<h2>Dashboard unavailable</h2><p class="error" role="alert">' + esc(error.message) + '</p><a class="button" href="/dashboard">Back to dashboard</a>') }
}
if (location.pathname.startsWith(base)) dashboard()
else {
  if (location.pathname === '/premium') premium()
  if (location.pathname === '/support') shell('<h2>Support Server</h2><p>The Discord support invite is currently unavailable.</p>')
  request('/api/me').then(accountMenu).catch(() => {})
}


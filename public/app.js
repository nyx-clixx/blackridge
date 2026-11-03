const app = document.querySelector('#app')
const account = document.querySelector('#account')
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char])
const iconPaths = {
  overview:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  nuke:'<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/>',
  raid:'<path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2m19 0v-2a4 4 0 0 0-3-4m-2-12a4 4 0 0 1 0 8"/><circle cx="9.5" cy="7" r="4"/>',
  logs:'<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  server:'<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>'
}
const icon = key => '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + iconPaths[key] + '</svg>'
for (const tile of document.querySelectorAll('[data-icon]')) tile.innerHTML = icon(tile.dataset.icon)
const sections = { overview:'Overview', nuke:'Anti-Nuke', raid:'Anti-Raid', logs:'Security logs' }
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
function protectionControls(form, section, config) {
  const button = form.querySelector('button')
  if (section === 'nuke') {
    const rows = Object.entries(rateLabels).map(([key,label]) => {
      const rule = config.rates?.[key] ?? config
      return '<div class="rate-row"><label class="toggle"><input type="checkbox" name="' + key + '-enabled"' + ((!config.rates || rule.enabled) ? ' checked' : '') + '> ' + label + '</label><div class="fields"><label>Actions<input required type="number" min="2" max="30" name="' + key + '-threshold" value="' + rule.threshold + '"></label><label>Window in seconds<input required type="number" min="5" max="120" name="' + key + '-window" value="' + rule.window + '"></label></div></div>'
    }).join('')
    button.insertAdjacentHTML('beforebegin','<details class="rate-settings" ' + (config.rates ? 'open' : '') + '><summary>Per-action rate limits</summary><label class="toggle"><input type="checkbox" name="custom-rates"' + (config.rates ? ' checked' : '') + '> Enable separate limits</label><div class="stack">' + rows + '</div></details>')
    return
  }
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
const settingFields = {
  nuke: [['threshold','Actions per actor',2,30],['window','Detection window (seconds)',5,120],['trusted','Trusted Discord user IDs (comma-separated)']],
  raid: [['threshold','Joins to trigger',3,100],['window','Detection window (seconds)',5,120],['duration','Protection duration (seconds)',15,600],['age','Maximum account age (days, 0 for all)',0,365],['timeoutMinutes','Timeout duration (minutes)',1,1440],['alertChannel','Alert channel ID (optional)'],['alertRoles','Alert role IDs (up to five, comma-separated)']]
}
function form(kind, config, owner) {
  const disabled = owner ? '' : ' disabled'
  return '<form class="card" id="settings"><h3>' + sections[kind] + ' policy</h3><p>' + (owner ? 'Choose when Blackridge should act and what response it should take.' : 'The server owner can change this policy.') + '</p><fieldset' + disabled + '><label class="toggle"><input type="checkbox" name="enabled"' + (config.enabled ? ' checked' : '') + '> Enable detection</label><div class="fields">' + settingFields[kind].map(([key,label,min,max]) => '<label>' + label + '<input name="' + key + '" value="' + esc(config[key]) + '"' + (min === undefined ? ' maxlength="500"' : ' type="number" required min="' + min + '" max="' + max + '"') + '></label>').join('') + '<label>Response<select name="action">' + (kind === 'raid' ? ['log','timeout','kick'] : ['log','strip','kick']).map(action => '<option value="' + action + '"' + (config.action === action ? ' selected' : '') + '>' + ({log:'Log only',timeout:'Time out',kick:'Kick',strip:'Remove dangerous roles'})[action] + '</option>').join('') + '</select></label></div><button class="button primary">Save settings</button></fieldset><p role="status" id="notice"></p></form>'
}
async function dashboard() {
  document.body.classList.add('dashboard-page')
  shell('<p role="status">Loading dashboard…</p>')
  const [, , id, rawSection] = location.pathname.split('/')
  const section = Object.hasOwn(sections, rawSection) ? rawSection : 'overview'
  try {
    const me = await request('/api/me')
    if (!me.user) {
      shell('<div class="eyebrow">BLACKRIDGE DASHBOARD</div><h2>Manage your servers.</h2><div class="card"><h3>Connect your Discord account</h3><p>Sign in to see the servers you can manage.</p><a class="button primary" href="/auth/login">Continue with Discord ↗</a>' + (me.configured ? '' : '<p class="muted">Discord sign-in is awaiting application setup.</p>') + (location.search ? '<p class="error">Sign-in could not be completed. Please try again.</p>' : '') + '</div>')
      return
    }
    account.textContent = 'Sign out'
    account.href = '#'
    account.onclick = async event => { event.preventDefault(); try { await request('/auth/logout',{method:'POST'}); location.assign(base) } catch (error) { alert(error.message) } }
    if (!id) {
      const { guilds } = await request('/api/guilds')
      shell('<div class="eyebrow">SIGNED IN AS ' + esc(me.user.username) + '</div><h2>Select a server</h2><p>Choose a Discord server to configure its security policy.</p><div class="servers">' + guilds.map(guild => '<article class="card server-card"><div class="server-avatar">' + (guild.icon ? '<img alt="" src="https://cdn.discordapp.com/icons/' + esc(guild.id) + '/' + esc(guild.icon) + '.png">' : esc(guild.name.slice(0,2).toUpperCase())) + '</div><h3>' + esc(guild.name) + '</h3><div class="muted">' + (guild.owner ? 'Owner' : 'Manager') + '</div><a class="button small" href="' + (guild.installed ? base + '/' + guild.id : '/invite?guild=' + guild.id) + '">' + (guild.installed ? 'Manage →' : 'Set up ↗') + '</a></article>').join('') + '</div>' + (guilds.length ? '' : '<div class="card">No servers with management access were found.</div>'))
      return
    }
    const path = '/api/guilds/' + encodeURIComponent(id)
    const data = await request(path)
    const descriptions = {
      overview:'Review security activity and manage your protection modules.',
      nuke:'Set limits for destructive actions and choose how Blackridge responds.',
      raid:'Detect join surges and configure alerts and automatic responses.',
      logs:'Review recent detections, responses, and policy changes.'
    }
    const heading = '<div class="toolbar"><div class="eyebrow">SERVER DASHBOARD</div><span class="badge connection">' + (data.online ? '<i class="dot"></i> Bot connected' : 'Bot offline') + '</span></div><h2 class="dash-title">' + sections[section] + '</h2><p class="page-copy">' + descriptions[section] + '</p>'
    const activity = '<section class="card stack"><h3>' + (section === 'logs' ? 'Event history' : 'Recent activity') + '</h3><div id="events">' + logList(data.events.slice(0, section === 'logs' ? 100 : 6)) + '</div></section>'
    const summary = value => '<div class="card"><span class="muted">Events · 24 hours</span><strong class="stat">' + value.total + '</strong></div><div class="card"><span class="muted">Anti-Nuke</span><strong class="stat">' + value.nuke + '</strong></div><div class="card"><span class="muted">Anti-Raid</span><strong class="stat">' + value.raid + '</strong></div>'
    const serverPath = base + '/' + encodeURIComponent(id)
    const navigation = key => '<a href="' + serverPath + '/' + key + '"' + (key === section ? ' aria-current="page"' : '') + '>' + icon(key) + sections[key] + '</a>'
    const modules = ['nuke','raid'].map(key => '<article class="card"><div class="module-head"><span class="icon-tile">' + icon(key) + '</span><h3>' + sections[key] + '</h3><span class="badge">' + (data.config[key].enabled ? '<i class="dot"></i> Enabled' : 'Disabled') + '</span></div><p>' + descriptions[key] + '</p><a class="module-link" href="' + serverPath + '/' + key + '">Configure ' + sections[key] + icon('arrow') + '</a></article>').join('')
    const overview = '<div id="stats" class="stats">' + summary(data.stats) + '</div><section class="stack"><div class="grid">' + modules + '</div></section>' + activity
    document.body.classList.add('has-workspace')
    shell('<div class="dash-layout"><nav class="sidebar" aria-label="Server navigation"><a class="server-switch" title="Switch server" href="' + base + '">' + icon('server') + '<span>' + esc(data.name) + '</span></a>' + navigation('overview') + navigation('logs') + '<span class="nav-label">Protection</span>' + navigation('nuke') + navigation('raid') + '</nav><div class="dash-main">' + heading + (section === 'overview' ? overview : section === 'logs' ? activity : form(section,data.config[section],data.owner)) + '<p id="refresh" role="status"></p></div></div>')
    const settings = document.querySelector('#settings')
    if (settings) protectionControls(settings,section,data.config[section])
    if (settings) settings.onsubmit = async event => {
      event.preventDefault()
      const fields = new FormData(settings)
      const payload = {enabled:fields.has('enabled'),action:fields.get('action')}
      if (fields.has('custom-rates')) {
        payload.rates = Object.fromEntries(Object.keys(rateLabels).map(key => [key,{
          enabled:fields.has(key + '-enabled'),
          threshold:Number(fields.get(key + '-threshold')),
          window:Number(fields.get(key + '-window'))
        }]))
      }
      for (const [key,,min] of settingFields[section]) payload[key] = min === undefined ? fields.get(key) : Number(fields.get(key))
      if (section === 'raid') {
        payload.alertChannel = payload.alertChannel.trim()
        payload.alertRoles = payload.alertRoles.split(',').map(id => id.trim()).filter(Boolean)
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


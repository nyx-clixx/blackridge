import { resources } from './resources.js'

const app = document.querySelector('#app')
const account = document.querySelector('#account')
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char])
const iconPaths = {
  configure:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.5" fill="var(--panel)"/><circle cx="15" cy="17" r="2.5" fill="var(--panel)"/>',
  lockdown:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  backup:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  premium:'<path d="m3 6 4 4 5-6 5 6 4-4-2 12H5L3 6Zm3 15h12"/>',
  checkpoint:'<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3"/><circle cx="12" cy="10" r="2.5"/><path d="M8 17a4 4 0 0 1 8 0"/>',
  automod:'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2" fill="var(--panel)"/><circle cx="15" cy="12" r="2" fill="var(--panel)"/><circle cx="10" cy="18" r="2" fill="var(--panel)"/>',
  moderation:'<path d="M5 4h14v16H5zM8 8h8M8 12h8m-8 4h4"/>',
  permits:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/>',
  overview:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  nuke:'<path d="m13 2-8 12h6l-1 8 9-12h-6l1-8Z"/>',
  raid:'<path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2m19 0v-2a4 4 0 0 0-3-4m-2-12a4 4 0 0 1 0 8"/><circle cx="9.5" cy="7" r="4"/>',
  logs:'<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  server:'<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>'
}
const icon = key => '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (iconPaths[key] ?? iconPaths.nuke) + '</svg>'
for (const tile of document.querySelectorAll('[data-icon]')) tile.innerHTML = icon(tile.dataset.icon)
const sections = { overview:'Overview', premium:'Premium', nuke:'Anti-Nuke', raid:'Anti-Raid', logs:'Security Logs', checkpoint:'Checkpoint', automod:'Auto Moderation', moderation:'Moderation', permits:'Permits', lockdown:'Lockdown', backup:'Server Backups' }
const request = async (url, options) => {
  const res = await fetch(url, options)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Request failed.')
  return data
}
const pendingSettings = new Set()
function autosave(form,errorOutput,write) {
  let timer
  let dirty = false
  let active
  const flush = () => {
    clearTimeout(timer)
    if (active) return active
    if (!dirty) return
    if (!form.isConnected || !form.checkValidity()) {
      pendingSettings.delete(flush)
      return
    }
    active = (async () => {
      while (dirty && form.isConnected && form.checkValidity()) {
        dirty = false
        try {
          await write()
          errorOutput.textContent = ''
        } catch (error) {
          errorOutput.textContent = error.message
        }
      }
    })().finally(() => {
      active = null
      pendingSettings.delete(flush)
    })
    return active
  }
  const changed = event => {
    if (event.target !== form && !event.target.name) return
    if (event.type === 'input' && !event.target.matches('textarea,input:not([type=radio]):not([type=checkbox]):not([data-commit-on-change])')) return
    dirty = true
    pendingSettings.add(flush)
    clearTimeout(timer)
    if (event.type === 'change') void flush()
    else timer = setTimeout(flush,350)
  }
  form.addEventListener('input',changed)
  form.addEventListener('change',changed)
  form.addEventListener('submit',event => { event.preventDefault(); void flush() })
}
document.addEventListener('click',async event => {
  if (!pendingSettings.size || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
  const link = event.target.closest('a[href]')
  if (!link || link.target || link.origin !== location.origin || link.hash) return
  event.preventDefault()
  await Promise.all([...pendingSettings].map(flush => flush()))
  location.assign(link.href)
})
window.addEventListener('pagehide',() => { for (const flush of pendingSettings) void flush() })
const shell = html => { app.innerHTML = '<div class="wrap dashboard">' + html + '</div>' }
function logList(entries,moderation = false) {
  if (!entries.length) return '<p class="empty">' + icon('logs') + ' No security events in this view.</p>'
  const rows = entries.map(event => {
    const avatar = event.userId && event.avatar
      ? '<img class="event-avatar" alt="" src="https://cdn.discordapp.com/avatars/' + encodeURIComponent(event.userId) + '/' + encodeURIComponent(event.avatar) + '.png?size=32">'
      : '<span class="event-avatar fallback-avatar" aria-hidden="true">' + icon('checkpoint') + '</span>'
    const command = event.kind === 'moderation' && event.detail.match(/^(ban|tempban|unban|kick|timeout|warn|lock-channel|unlock-channel|lock|unlock)\b/)?.[1]
    const action = command ? '/' + command : event.detail.replace(/ · initiated by .+$/,'').replace(/\b(?:invites_disabled_until|dms_disabled_until)\b/g,key => key === 'invites_disabled_until' ? 'invite pause' : 'DM pause').trim()
    return '<tr><td><div class="case-user">' + avatar + '<div><strong>' + esc(event.userName ?? (event.userId ? 'Unknown user' : 'System')) + '</strong><code>' + esc(event.userId ?? '—') + '</code></div></div></td><td><span title="' + esc(event.detail) + '">' + esc(action) + '</span></td><td><time datetime="' + new Date(event.at).toISOString() + '">' + esc(new Date(event.at).toLocaleString()) + '</time></td></tr>'
  }).join('')
  return '<div class="event-scroll"><table class="event-table"><thead><tr><th scope="col">' + (moderation ? 'Moderator' : 'User') + '</th><th scope="col">Action</th><th scope="col">Date and time</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
}
const base = '/dashboard'
const rateLabels = {
  moderation:'Kicks & Bans', roleCreate:'Role Creations', roleDelete:'Role Deletions',
  channelCreate:'Channel Creations', channelDelete:'Channel Deletions', webhookCreate:'Webhook Creations'
}
const nukeGuards = {
  assignments:['Dangerous Role Assignments','Detect when a member is given a role with a watched permission.'],
  rolePermissions:['Dangerous Permission Updates','Detect new dangerous permissions on a server role.'],
  publicRoles:['Public Role Permissions','Watch public roles for dangerous permission grants in the server, channels, and categories.'],
  gate:['Role Gate','Require a grantor to hold an approved role before assigning a gated role.'],
  botAdd:['Bot Additions','Detect when someone adds a bot to the server.'],
  identity:['Server Identity Changes','Watch for changes to the server name, icon, or vanity invite link.']
}
const nukePermissions = {
  Administrator:'Administrator',KickMembers:'Kick Members',BanMembers:'Ban Members',ManageGuild:'Manage Server',
  ManageRoles:'Manage Roles',ManageChannels:'Manage Channels',ManageWebhooks:'Manage Webhooks',MentionEveryone:'Mention Everyone'
}
function nukeControls(form,config,roles) {
  const check = (name,label,checked) => '<label class="toggle"><input type="checkbox" name="' + name + '"' + (checked ? ' checked' : '') + '>' + label + '</label>'
  const number = (name,label,value,max) => '<label>' + label + '<span class="nuke-stepper"><button type="button" data-step="-1" aria-label="Decrease ' + label + '">−</button><input required type="number" name="' + name + '" min="0" max="' + max + '" value="' + value + '"><button type="button" data-step="1" aria-label="Increase ' + label + '">+</button></span></label>'
  const gateRow = (gate = {role:'',required:[]}) => '<div class="nuke-gate"><div class="discord-field"><span>Gated Role</span>' + discordSelect('gate-role-' + gateIndex++,roles,[gate.role]) + '</div><div class="discord-field"><span>Required Roles</span>' + discordSelect('gate-required',roles,gate.required,true) + '</div><button class="button small" type="button" data-remove-gate>Remove</button></div>'
  let gateIndex = 0
  function row(key,label,description,saved,isRate) {
    const rule = saved ?? {}
    const actionOptions = actionsByKind.nuke.map(action => [action,actionLabels[action]])
    const select = (name,label,items,value) => '<label>' + label + '<select name="' + key + '-' + name + '">' + items.map(([id,text]) => '<option value="' + id + '"' + (id === value ? ' selected' : '') + '>' + text + '</option>').join('') + '</select></label>'
    const choices = (name,items,selected) => Object.entries(items).map(([value,text]) => check(key + '-' + name + '-' + value,text,selected.includes(value))).join('')
    const permissions = ['publicRoles','assignments','rolePermissions'].includes(key)
      ? '<div class="nuke-choices"><strong>Dangerous Permissions</strong>' + choices('permission',nukePermissions,rule.permissions ?? Object.keys(nukePermissions)) + '</div>' : ''
    const extras = key === 'publicRoles' ? check('publicRoles-onboarding','Protect Self-Assignable Onboarding Roles',rule.onboarding !== false) +
      '<div class="discord-field"><span>Additional Protected Roles</span>' + discordSelect('publicRoles-roles',roles,rule.roles ?? [],true) + '</div>'
      : key === 'identity' ? '<div class="nuke-choices"><strong>Identity Changes to Watch</strong>' + choices('identity',{icon_hash:'Server Icon',name:'Server Name',vanity_url_code:'Vanity Invite Link'},rule.identity ?? ['icon_hash','name','vanity_url_code']) + '</div>'
      : key === 'gate' ? '<p>Members need at least one required role. With an enforcement response, Blackridge also removes unauthorized grants where it can.</p><div class="nuke-gates">' + (rule.gates ?? []).map(gateRow).join('') + '</div><button type="button" class="button small" data-add-gate>Add Gated Role</button>' : ''
    const time = isRate ? '<div class="fields">' + number(key + '-minute','Per Minute',rule.minute ?? 5,500) + number(key + '-hour','Per Hour',rule.hour ?? 15,500) + '</div><p>Set either limit to 0 to turn off that window.' +
      (saved && rule.minute === undefined ? ' This rule currently uses its previous ' + rule.threshold + ' in ' + rule.window + 's limit. Edit either limit to switch to rolling windows.' : '') + '</p>' : ''
    return '<article class="nuke-row" data-nuke="' + key + '" data-configured="' + Boolean(saved) + '" data-rolling="' + (rule.minute !== undefined) + '"><div><h4>' + label + '</h4><p>' + description + '</p></div><div class="nuke-row-actions"><button type="button" class="button small" data-nuke-config aria-label="Configure ' + label + '">' + icon('automod') + ' Configure</button><label class="nuke-switch"><input type="checkbox" role="switch" aria-label="Enable ' + label + '" name="' + key + '-enabled"' + (rule.enabled ? ' checked' : '') + '><span aria-hidden="true"></span></label></div><dialog class="nuke-dialog" aria-labelledby="nuke-title-' + key + '"><header><h3 id="nuke-title-' + key + '">' + label + '</h3><button type="button" class="button small" data-close-nuke aria-label="Close settings">×</button></header><div class="nuke-dialog-fields">' +
      select('action','Response',[['','Use Default Response'],...actionOptions],rule.action ?? '') + '<div class="fields">' +
      number(key + '-escalate','Escalate After',rule.escalateAfter ?? 0,100) + select('escalateTo','Escalate To',actionOptions,rule.escalateTo ?? 'ban') + '</div><p>Detections by the same actor within 24 hours. Use 0 to disable escalation.</p>' + time + permissions + extras + '</div></dialog></article>'
  }
  const guards = Object.entries(nukeGuards).map(([key,[label,description]]) => row(key,label,description,config.guards?.[key],false)).join('')
  const rates = Object.entries(rateLabels).map(([key,label]) => row(key,label,'Track repeated actions by the same actor.',config.rates?.[key],true)).join('')
  form.querySelector('fieldset').insertAdjacentHTML('afterbegin','<section class="card nuke-rules"><h3>Permissions & Identity</h3>' + guards + '</section><section class="card nuke-rules"><h3>Per-Action Rate Limits</h3><p>Rules without their own limits use the default policy where applicable.</p>' + rates + '</section>')
  const trackRule = event => {
    const row = event.target.closest('[data-nuke]')
    if (!row || !event.target.name) return
    const key = row.dataset.nuke
    if ((!config.rates?.[key] && Object.hasOwn(rateLabels,key)) || /-(minute|hour)$/.test(event.target.name)) row.dataset.rolling = 'true'
    row.dataset.configured = 'true'
  }
  form.addEventListener('change',trackRule)
  form.addEventListener('input',trackRule)
  form.addEventListener('click',event => {
    const button = event.target.closest('button')
    const row = button?.closest('[data-nuke]')
    if (!row) return
    const dialog = row.querySelector('dialog')
    if (button.hasAttribute('data-nuke-config')) dialog.showModal()
    if (button.hasAttribute('data-close-nuke')) dialog.close()
    if (button.dataset.step) {
      const input = button.parentElement.querySelector('input')
      if (button.dataset.step === '1') input.stepUp()
      else input.stepDown()
      input.dispatchEvent(new Event('change',{bubbles:true}))
    }
    if (button.hasAttribute('data-add-gate') && dialog.querySelectorAll('.nuke-gate').length < 100)
      dialog.querySelector('.nuke-gates').insertAdjacentHTML('beforeend',gateRow())
    if (button.hasAttribute('data-remove-gate')) {
      button.closest('.nuke-gate').remove()
      form.dispatchEvent(new Event('change'))
    }
  })
}
const sensitivity = [['Low',20],['Medium',10],['High',5],['Custom',0]]
const filters = {
  multiUser:['Multi-User Spam',4],scam:['Common Scam Patterns',1],badWords:['Blocked Words and Phrases',1],
  images:['Image Attachments',3],stickers:['Stickers',1],invites:['Discord Invites',1],caps:['Excessive Caps (%)',80],
  duplicate:['Duplicate Text',3],emoji:['Emoji Spam',10],mentions:['Mass Mentions',5],links:['Links',3],
  files:['Attachments',3],newlines:['New Lines',12],headers:['Markdown Headings',1],length:['Message Length',1500],
  ghost:['Ghost Mentions',1],nsfw:['Block NSFW Links',1],malicious:['Block Malicious Links',1]
}
function options(labels, selected) {
  return Object.entries(labels).map(([value,label]) => '<option value="' + value + '"' + (selected === value ? ' selected' : '') + '>' + label + '</option>').join('')
}
function settingRow(label,description,fields,{className = '',enabled} = {}) {
  const toggle = enabled === undefined ? '' : '<label class="nuke-switch"><input type="checkbox" role="switch" data-response-toggle aria-label="Enable ' + esc(label) + '"' + (enabled ? ' checked' : '') + '><span aria-hidden="true"></span></label>'
  return '<article class="nuke-row setting-row ' + className + '"><div><h4 class="setting-name">' + esc(label) + '</h4><p>' + esc(description) + '</p></div><div class="nuke-row-actions"><button type="button" class="button small" data-open-settings aria-label="Configure ' + esc(label) + '">' + icon('configure') + ' Configure</button>' + toggle + '</div><dialog class="nuke-dialog" aria-label="' + esc(label) + ' settings"><header><h3>' + esc(label) + '</h3><button type="button" class="button small" data-close-settings aria-label="Close settings">×</button></header><div class="nuke-dialog-fields">' + fields + '</div></dialog></article>'
}
document.addEventListener('click',event => {
  const button = event.target.closest('[data-open-settings],[data-close-settings]')
  const dialog = button?.closest('.setting-row')?.querySelector('dialog')
  if (!dialog) return
  if (button.hasAttribute('data-open-settings')) dialog.showModal()
  else dialog.close()
})
document.addEventListener('change',event => {
  if (!event.target.matches('[data-response-toggle]')) return
  event.target.form.dispatchEvent(new Event('change'))
})
function ruleCard(title,description,rows) {
  return '<section class="card nuke-rules"><h3>' + title + '</h3>' + (description ? '<p>' + description + '</p>' : '') + rows + '</section>'
}
function collapseSettings(section,description) {
  if (!section) return
  const title = section.querySelector('h3').textContent
  const readOnly = section.closest('fieldset:disabled')
  const fields = document.createDocumentFragment()
  for (const child of [...section.children]) if (!child.matches('h3,p')) fields.append(child)
  section.classList.add('nuke-rules','single-setting')
  section.innerHTML = settingRow(title,readOnly ? description + ' Only the server owner can make changes.' : description,'')
  section.querySelector('.nuke-dialog-fields').append(fields)
}
function extraControls(section,config) {
  if (section === 'automod') {
    const configFields = {badWords:['badWords','Blocked Phrases'],nsfw:['nsfwDomains','Additional NSFW Domains'],malicious:['maliciousDomains','Additional Malicious Domains']}
    const cards = Object.entries(filters).map(([key,[label,limit]]) => {
      const rule = config.filters?.[key]
      const actions = {log:'Log',...(key === 'ghost' ? {} : {delete:'Delete Message',timeout:'Timeout'})}
      const field = configFields[key]
      const configure = field ? '<label>' + field[1] + ' (one per line)<textarea name="' + field[0] + '" maxlength="500" rows="5" spellcheck="false">' + esc(config[field[0]].split(',').map(value => value.trim()).filter(Boolean).join('\n')) + '</textarea></label>' : ''
      const enabled = Boolean(rule?.action && rule.action !== 'off')
      const response = enabled ? rule.action : rule?.resumeAction ?? 'log'
      return settingRow(label,'Set the threshold, response, and escalation points.','<div class="fields"><label>Response<select name="' + key + '-action">' + options(actions,response) + '</select></label><label>Threshold<input type="number" required min="1" max="4000" name="' + key + '-limit" value="' + esc(rule?.limit ?? limit) + '"></label><label>Points<input type="number" required min="0" max="100" name="' + key + '-points" value="' + esc(rule?.points ?? 0) + '"></label></div>' + configure,{className:'response-rule',enabled})
    }).join('')
    return ruleCard('Message Filters','Text and attachment filters require Message Content access. Domain filters match hostnames without opening URLs.',cards) + '<section class="card settings-section"><h3>Point Escalation</h3><p>When a member reaches a threshold within its time window, Blackridge applies the highest matching rule.</p><div class="setting-list stack" id="point-rules">' + (config.pointRules ?? []).map(pointRule).join('') + '</div><button type="button" class="button small stack" id="add-point-rule">Add Points Rule</button></section>'
  }
  if (section === 'checkpoint') {
    const rows = (config.rules ?? []).map(rule => checkpointRule(rule.score,rule.action)).join('')
    const botRules = ['verifiedBot','unverifiedBot'].map(key => {
      const rule = config[key] ?? {action:'off',quarantine:false}
      const enabled = rule.action !== 'off'
      return settingRow(key === 'verifiedBot' ? 'Verified Bot Addition' : 'Unverified Bot Addition','Choose how Blackridge responds when a bot is added.','<label>Response<select name="' + key + '-action">' + options({kick:'Kick Bot',ban:'Ban Bot'},enabled ? rule.action : rule.resumeAction ?? 'kick') + '</select></label><label class="toggle"><input type="checkbox" name="' + key + '-quarantine"' + (rule.quarantine ? ' checked' : '') + '> Quarantine the Inviter</label>',{className:'response-rule',enabled})
    }).join('')
    return '<section class="card settings-section"><h3>Risk Score Rules</h3><p>The highest matching threshold wins. Without rules, the minimum score controls logging and alerts.</p><div class="setting-list" id="checkpoint-rules">' + rows + '</div><button type="button" class="button small stack" id="add-checkpoint-rule">Add Rule</button></section>' + ruleCard('Bot Addition Rules','Quarantining the inviter uses the quarantine role configured in Anti-Nuke.',botRules)
  }
  return ''
}
function pointRule(rule = {points:5,hours:24,action:'timeout'}) {
  return settingRow('Escalation Rule','Choose a point threshold, time window, and response.','<div class="fields"><label>Points<input name="rule-points" type="number" min="1" max="1000" required value="' + esc(rule.points) + '"></label><label>Within Hours<input name="rule-hours" type="number" min="1" max="168" required value="' + esc(rule.hours) + '"></label><label>Response<select name="rule-action">' + options({timeout:'Timeout',kick:'Kick',ban:'Ban'},rule.action) + '</select></label></div><button type="button" class="button small remove-point-rule">Remove Rule</button>',{className:'point-rule'})
}
function checkpointRule(score,action = 'log') {
  return settingRow('Risk Rule','Choose a minimum score and response.','<div class="fields"><label>Minimum Score<input type="number" min="1" max="25" required name="score" value="' + esc(score) + '"></label><label>Response<select name="rule">' + options({log:'Log and Alert',kick:'Kick',quarantine:'Quarantine',tempban:'Temporary Ban'},action) + '</select></label></div><button type="button" class="button small remove-rule">Remove Rule</button>',{className:'checkpoint-rule'})
}
function protectionControls(form, section, config) {
  const alerts = form.querySelector('.discord-alerts')
  const insert = html => (alerts ?? form.querySelector('fieldset')).insertAdjacentHTML(alerts ? 'beforebegin' : 'beforeend',html)
  insert(extraControls(section,config))
  if (section === 'automod') {
    const list = form.querySelector('#point-rules')
    const add = form.querySelector('#add-point-rule')
    const changed = () => { add.disabled = list.children.length >= 4; form.dispatchEvent(new Event('change')) }
    add.disabled = list.children.length >= 4
    add.onclick = () => { if (list.children.length < 4) { list.insertAdjacentHTML('beforeend',pointRule()); changed(); list.lastElementChild.querySelector('dialog').showModal() } }
    list.onclick = event => { if (event.target.matches('.remove-point-rule')) { event.target.closest('.point-rule').remove(); changed(); add.focus() } }
  }
  if (section === 'checkpoint') {
    const list = form.querySelector('#checkpoint-rules')
    const add = form.querySelector('#add-checkpoint-rule')
    const refresh = () => { add.disabled = list.children.length >= 4 }
    add.onclick = () => {
      if (list.children.length >= 4) return
      list.insertAdjacentHTML('beforeend',checkpointRule(config.threshold))
      refresh()
      form.dispatchEvent(new Event('change'))
      list.lastElementChild.querySelector('dialog').showModal()
    }
    list.onclick = event => {
      if (event.target.matches('.remove-rule')) { event.target.closest('.checkpoint-rule').remove(); refresh(); add.focus(); form.dispatchEvent(new Event('change')) }
    }
    refresh()
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
const alerts = [['alertChannel','Discord Logging Channel'],['alertRoles','Roles to Notify']]
const timedResponses = [['tempBanMinutes','Temporary ban duration (minutes)',1,1440],['quarantineMinutes','Quarantine duration (minutes)',1,1440]]
const settingFields = {
  nuke: [['threshold','Actions per actor',2,30],['window','Detection window (seconds)',5,120],['trusted','Trusted Discord user IDs (comma-separated)'],...alerts,...timedResponses],
  raid: [['threshold','Joins to trigger',3,100],['window','Detection window (seconds)',5,120],['duration','Protection duration (seconds)',15,600],['age','Maximum account age (days, 0 for all)',0,365],['timeoutMinutes','Timeout duration (minutes)',1,1440],...alerts,...timedResponses],
  checkpoint: [['age','Young account threshold (days)',1,365],['agePoints','Points for a young account',0,5],['avatarPoints','Points for a default avatar',0,5],['rejoinPoints','Points for 3 joins in an hour',0,5],['similarPoints','Points for a burst of similar accounts',0,5],['inviteNamePoints','Points for invite links in display names',0,5],['threshold','Minimum score to log and alert',1,25],...timedResponses,...alerts],
  automod: [['threshold','Messages per member',3,30],['window','Detection window (seconds)',2,60],['timeoutMinutes','Timeout duration (minutes)',1,1440],...alerts,['spamPoints','Points per spam violation',0,100]]
}
const actionsByKind = {
  nuke:['log','strip','quarantine','kick','ban','tempban'],
  raid:['log','timeout','quarantine','kick','ban','tempban'],
  automod:['log','timeout']
}
const actionLabels = {log:'Log only',timeout:'Time out',strip:'Remove dangerous roles',quarantine:'Quarantine',kick:'Kick',ban:'Ban',tempban:'Temporary ban'}
const commandNames = ['ban','tempban','unban','kick','timeout','warn','lock-channel','unlock-channel']
const ids = value => value.split(',').map(id => id.trim()).filter(Boolean)

const bypassLabels = {automod:'Auto Moderation',nuke:'Anti-Nuke',raid:'Anti-Raid',checkpoint:'Checkpoint'}
function permitCard(entry,roles) {
  const choices = (name,labels,selected) => Object.entries(labels).map(([id,label]) =>
    '<label class="toggle"><input type="checkbox" name="' + name + '" value="' + esc(id) + '"' + (selected.includes(id) ? ' checked' : '') + '> ' + esc(label) + '</label>'
  ).join('')
  const commands = Object.fromEntries(commandNames.map(name => [name,'/' + name]))
  return settingRow(entry.name,'Manage role and user access, commands, and protection bypasses.',
    '<section class="permit-section"><h3>Permit Name</h3><div class="fields"><label>Display name<input name="permit-name" maxlength="60" required value="' + esc(entry.name) + '"></label></div></section>' +
    '<section class="permit-section"><h3>Permit Access</h3><div class="fields"><label>Discord user IDs<input name="permit-users" data-commit-on-change maxlength="330" value="' + esc(entry.users.join(', ')) + '" placeholder="Comma-separated user IDs"></label><div class="discord-field"><span>Discord roles</span>' + discordSelect('permit-roles',roles,entry.roles,true) + '</div></div></section>' +
    '<section class="permit-section"><h3>Permit Command Access</h3><div class="permit-choices">' + choices('permit-commands',commands,entry.commands) + '</div></section>' +
    '<section class="permit-section"><h3>Permit Bypass</h3><div class="permit-choices">' + choices('permit-bypasses',bypassLabels,entry.bypasses) + '</div></section>' +
    '<button type="button" class="button small remove-permit">Remove Permit</button>',{className:'card permit-card'})
}
function permitsForm(config,roles) {
  return '<form class="settings-panels" id="settings"><section class="card settings-section"><div class="module-head"><h3>Permit Manager</h3><button type="button" class="button small" id="add-permit">Add Permit</button></div><p>Grant commands and protection bypasses to selected Discord users or roles. Command users also need the corresponding Discord permissions.</p></section><div class="settings-panels" id="permit-list">' + config.entries.map(entry => permitCard(entry,roles)).join('') + '</div><p id="notice" role="status"></p></form>'
}
function wirePermits(form,roles) {
  const list = form.querySelector('#permit-list')
  const add = form.querySelector('#add-permit')
  const refresh = () => { add.disabled = list.children.length >= 30 }
  add.onclick = () => {
    if (list.children.length >= 30) return
    list.insertAdjacentHTML('beforeend',permitCard({name:'New Permit',users:[],roles:[],commands:[],bypasses:[]},roles))
    list.lastElementChild.querySelector('dialog').showModal()
    const name = list.lastElementChild.querySelector('[name=permit-name]')
    name.focus()
    name.select()
    refresh()
    form.dispatchEvent(new Event('change'))
  }
  list.addEventListener('input',event => {
    if (event.target.name !== 'permit-name') return
    const row = event.target.closest('.permit-card')
    const name = event.target.value.trim() || 'New Permit'
    row.querySelector('.setting-name').textContent = name
    row.querySelector('dialog h3').textContent = name
    row.querySelector('dialog').setAttribute('aria-label',name + ' settings')
    row.querySelector('[data-open-settings]').setAttribute('aria-label','Configure ' + name)
  })
  list.addEventListener('click',event => {
    if (!event.target.matches('.remove-permit')) return
    event.target.closest('.permit-card').remove()
    refresh()
    add.focus()
    form.dispatchEvent(new Event('change'))
  })
  refresh()
}
function readPermits(form) {
  return {entries:[...form.querySelectorAll('.permit-card')].map(card => {
    const selected = name => [...card.querySelectorAll('input[name=' + name + ']:checked')].map(input => input.value)
    return {
      name:card.querySelector('[name=permit-name]').value.trim(),
      users:ids(card.querySelector('[name=permit-users]').value),
      roles:selected('permit-roles'),
      commands:selected('permit-commands'),
      bypasses:selected('permit-bypasses')
    }
  })}
}

async function accountMenu(me) {
  if (!me.user) return
  const avatar = me.user.avatar ? '<img alt="" src="https://cdn.discordapp.com/avatars/' + esc(me.user.id) + '/' + esc(me.user.avatar) + '.png?size=64">' : '<span class="initial">' + esc(me.user.username.slice(0,1)) + '</span>'
  account.outerHTML = '<details class="account-menu"><summary class="button small">' + avatar + '<span>' + esc(me.user.username) + '</span></summary><div class="account-links">' + '<a href="/support">Support Server</a>' + '<a href="/premium">Premium</a><button type="button" id="sign-out">Log out</button></div></details>'
  document.querySelector('#sign-out').onclick = async () => {
    try {
      await Promise.all([...pendingSettings].map(flush => flush()))
      await request('/auth/logout',{method:'POST'})
      location.assign(base)
    }
    catch (error) { alert(error.message) }
  }
}
function premium() {
  shell('<h2>Blackridge Premium</h2>' + premiumPlans())
}
function premiumPlans() {
  const features = ['Advanced Anti-Nuke','Advanced Anti-Raid','Advanced Auto Moderation','Server Backups']
  return '<div class="grid pricing">' + [
    ['blue','Blackridge Premium','$2.99',features],
    ['custom','Blackridge Custom Bot','$4.99',[...features,'Custom branding']]
  ].map(([theme,name,price,items]) => '<article class="card plan plan-' + theme + '"><span class="icon-tile">' + icon('premium') + '</span><h3>' + name + '</h3><strong>' + price + '</strong><ul>' + items.map(item => '<li>' + item + '</li>').join('') + '</ul><button class="button plan-purchase" type="button" disabled>Purchase</button><span class="badge">Coming soon</span></article>').join('') + '</div>'
}
function form(kind, config, owner) {
  const disabled = owner ? '' : ' disabled'
  const fields = group => group.map(([key,label,min,max]) => '<label>' + label + '<input name="' + key + '" value="' + esc(Array.isArray(config[key]) ? config[key].join(', ') : config[key]) + '"' + (min === undefined ? ' maxlength="500"' : ' type="number" required min="' + min + '" max="' + max + '"') + '></label>').join('')
  const response = actionsByKind[kind] ? '<label>Response<select name="action">' + actionsByKind[kind].map(action => '<option value="' + action + '"' + (config.action === action ? ' selected' : '') + '>' + actionLabels[action] + '</option>').join('') + '</select></label>' : ''
  const alertFields = settingFields[kind].filter(([key]) => key.startsWith('alert'))
  const baseFields = settingFields[kind].filter(([key]) => !key.startsWith('alert'))
  return '<form id="settings"><fieldset class="settings-panels"' + disabled + '><section class="card settings-section"><h3>' + (kind === 'automod' ? 'Anti-Spam' : sections[kind] + ' Policy') + '</h3><p>' + (owner ? 'Set detection thresholds and how Blackridge responds.' : 'Only the server owner can change this policy.') + '</p><div class="fields">' + fields(baseFields) + response + '</div></section>' + (alertFields.length ? '<section class="card settings-section discord-alerts"><h3>Discord Alerts</h3><div class="fields">' + fields(alertFields) + '</div></section>' : '') + '</fieldset><p role="status" id="notice"></p></form>'
}
function discordSelect(name,items,values,multiple = false) {
  const selected = new Set(values.filter(Boolean))
  const available = new Set(items.map(item => item.id))
  const missing = [...selected].filter(id => !available.has(id)).map(id => ({id,name:'Deleted or unavailable (' + id + ')'}))
  const choices = [...(multiple ? [] : [{id:'',name:'None'}]),...items,...missing]
  const label = multiple ? (selected.size ? selected.size + ' selected' : 'Select options') : choices.find(item => selected.has(item.id))?.name ?? 'None'
  return '<details class="discord-select" data-multiple="' + multiple + '"><summary><span>' + esc(label) + '</span><span aria-hidden="true">⌄</span></summary><div class="discord-options"><input class="discord-search" type="search" aria-label="Search options" placeholder="Search…" autocomplete="off"><div class="discord-results">' + choices.map(item => {
    const checked = selected.has(item.id) || (!multiple && !selected.size && !item.id)
    return '<label class="discord-option"><input type="' + (multiple ? 'checkbox' : 'radio') + '" name="' + name + '" value="' + esc(item.id) + '"' + (checked ? ' checked' : '') + '><span>' + esc(item.name) + '</span></label>'
  }).join('') + '</div></div></details>'
}
function replaceDiscordInput(input,markup) {
  const label = input.parentElement
  label.outerHTML = '<div class="discord-field"><span>' + esc(label.textContent) + '</span>' + markup + '</div>'
}
document.addEventListener('input',event => {
  if (!event.target.matches('.discord-search')) return
  const query = event.target.value.trim().toLowerCase()
  for (const item of event.target.closest('.discord-options').querySelectorAll('.discord-option')) {
    item.hidden = !item.textContent.toLowerCase().includes(query) && !item.querySelector('input').value.includes(query)
  }
})
document.addEventListener('change',event => {
  const picker = event.target.closest('.discord-select')
  if (!picker || !event.target.matches('.discord-option input')) return
  const checked = picker.querySelectorAll('.discord-option input:checked')
  const multiple = picker.dataset.multiple === 'true'
  picker.querySelector('summary span').textContent = multiple
    ? (checked.length ? checked.length + ' selected' : 'Select options')
    : checked[0]?.nextElementSibling.textContent ?? 'None'
  if (!multiple) {
    picker.open = false
    picker.querySelector('summary').focus()
  }
})
document.addEventListener('click',event => {
  for (const picker of document.querySelectorAll('.discord-select[open]')) {
    if (!picker.contains(event.target)) picker.open = false
  }
})
document.addEventListener('keydown',event => {
  const picker = event.target.closest('.discord-select[open]')
  if (picker && event.key === 'Escape') {
    picker.open = false
    picker.querySelector('summary').focus()
  }
})
function wireDiscordSelectors(form,choices) {
  const channel = form.elements.alertChannel
  if (channel) replaceDiscordInput(channel,discordSelect('alertChannel',choices.channels.filter(item => item.sendable),[channel.value]))
  const roles = form.elements.alertRoles
  if (roles) replaceDiscordInput(roles,discordSelect('alertRoles',choices.roles,ids(roles.value),true))
}
async function recoveryPanel(section,path,data,prepared) {
  const panel = document.querySelector('#recovery')
  if (!data.owner) {
    if (section !== 'moderation') panel.innerHTML = '<p>Only the server owner can manage recovery operations.</p>'
    return
  }
  const [{channels},state] = prepared ?? await Promise.all([
    request(path + '/options'),section === 'moderation' ? {} : request(path + '/recovery')
  ])
  const channel = discordSelect('alertChannel',channels.filter(item => item.sendable),[data.config[section]?.alertChannel])
  let controls = ''
  if (section === 'lockdown') {
    controls = state.lockdown
      ? '<form class="card stack" data-operation="lift"><h3>Lockdown Controls</h3><p class="badge">Active</p><p>Started ' + esc(new Date(state.lockdown).toLocaleString()) + '</p><button class="button primary lockdown-submit">Deactivate Lockdown</button></form>'
      : '<form class="card stack" data-operation="enable"><h3>Lockdown Controls</h3><p>Channel locks modify @everyone. Invite and DM pauses are applied for one hour where Discord exposes the current state.</p><div class="fields"><div class="discord-field"><span>Channels</span>' + discordSelect('channels',channels,[],true) + '</div></div><label class="toggle"><input type="checkbox" name="all"> Lock all supported channels</label><label class="toggle"><input type="checkbox" name="verification"> Raise verification to highest</label><label class="toggle"><input type="checkbox" name="invites"> Pause invites</label><label class="toggle"><input type="checkbox" name="dms"> Pause Direct Messages</label><label class="toggle"><input type="checkbox" name="strip"> Strip Dangerous Permissions</label><button class="button primary lockdown-submit">Start Lockdown</button></form>'
  }
  if (section === 'backup') {
    const history = (state.backups ?? []).map(item => '<option value="' + item.id + '">' + esc(new Date(item.at).toLocaleString()) + '</option>').join('')
    controls = '<section class="card stack backup-controls"><form data-operation="backup"><h3>Manual Backup</h3><p>Save server settings, roles, channels and overwrites. The latest three backups are retained.</p><button class="button">Create Backup</button></form><form data-operation="schedule"><h3>Automatic Backups</h3><div class="fields"><label>Frequency<select name="hours">' + options({0:'Disabled',6:'Every 6 hours',12:'Every 12 hours',24:'Daily',168:'Weekly'},String(state.schedule?.hours ?? 0)) + '</select></label></div></form></section>' +
      (history ? '<form class="card stack" data-operation="restore"><h3>Backup Manager</h3><p>Restore supported settings and recreate eligible deleted roles and channels. Messages, role memberships, member overwrites, and ordering require manual recovery.</p><div class="fields"><label>Backup<select name="id">' + history + '</select></label></div><button class="button primary">Restore Backup</button></form>' : '<section class="card stack"><h3>Backup Manager</h3><p>No backups yet.</p></section>')
  }
  const logging = '<form class="card stack" data-operation="logging"><h3>Discord Logging</h3><div class="fields"><div class="discord-field"><span>Logging Channel</span>' + channel + '</div></div></form>'
  panel.innerHTML = controls + (section === 'backup' ? '' : logging) + '<p class="stack" role="status"></p>'
  collapseSettings(panel.querySelector('[data-operation=logging]'),'Choose where Blackridge posts Discord logs.')
  collapseSettings(panel.querySelector('[data-operation=schedule]'),'Choose how often Blackridge creates a backup.')
  const lockdown = panel.querySelector('[data-operation=enable]')
  if (lockdown) {
    const fields = [...lockdown.querySelectorAll(':scope > .fields, :scope > .toggle')]
    const start = lockdown.querySelector('.lockdown-submit')
    start.insertAdjacentHTML('beforebegin',settingRow('Lockdown Options','Choose the channels and restrictions to apply.',''))
    lockdown.querySelector('.nuke-dialog-fields').append(...fields)
  }
  const status = panel.querySelector('[role="status"]')
  for (const form of panel.querySelectorAll('form')) {
    const operation = form.dataset.operation
    if (operation === 'logging' || operation === 'schedule') {
      autosave(form,status,async () => {
        const fields = new FormData(form)
        const logging = operation === 'logging'
        const payload = logging ? {alertChannel:fields.get('alertChannel')} : {hours:Number(fields.get('hours'))}
        await request(logging ? path + '/' + section : path + '/recovery/schedule',{
          method:logging ? 'PUT' : 'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),keepalive:true
        })
        if (logging) data.config[section].alertChannel = payload.alertChannel
      })
      continue
    }
    form.onsubmit = async event => {
    event.preventDefault()
    const fields = new FormData(form)
    const payload = Object.fromEntries(fields)
    if (operation === 'lift') {
      if (!window.confirm('Deactivate Lockdown and restore the recorded settings?')) return
      payload.confirm = 'LIFT LOCKDOWN'
    }
    if (operation === 'enable') {
      if (!window.confirm('Start Lockdown with the selected controls?')) return
      payload.confirm = 'ENABLE LOCKDOWN'
      payload.channels = fields.getAll('channels')
      for (const key of ['all','verification','invites','dms','strip']) payload[key] = fields.has(key)
    }
    if (operation === 'restore') {
      if (!window.confirm('Confirm you want to restore this backup?')) return
      payload.id = Number(payload.id)
      payload.confirm = 'RESTORE BACKUP'
    }
    const button = event.submitter ?? form.querySelector('.lockdown-submit,button:not([type=button])')
    button.disabled = true
    try {
      await Promise.all([...pendingSettings].map(flush => flush()))
      const result = await request(path + '/recovery/' + operation,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)
      })
      await recoveryPanel(section,path,data)
      panel.querySelector('[role="status"]').textContent = result.notices?.join(' ') || ''
    } catch (error) { status.textContent = error.message }
    finally { button.disabled = false }
    }
  }
}
function setupQuarantine(settings,path) {
  const panel = document.createElement('section')
  panel.className = 'card quarantine-panel'
  panel.innerHTML = '<h3>Quarantine Role</h3><p>Apply view and chat denies across channels and categories. Anti-Nuke removes manageable roles and restores eligible roles when quarantine ends.</p><button type="button" class="button stack">Configure Quarantine Role</button>'
  settings.before(panel)
  panel.querySelector('button').onclick = async event => {
    const button = event.currentTarget
    button.disabled = true
    try {
      const [state,choices] = await Promise.all([request(path + '/recovery'),request(path + '/options')])
      panel.innerHTML = '<h3>Quarantine Role</h3><p>Select an existing permission-free role, or leave it unselected to create one.</p><form><div class="fields"><div class="discord-field"><span>Role</span>' + discordSelect('role',choices.roles,[state.quarantineSetup || state.quarantineRole]) + '</div></div><button class="button primary">Apply to Channels and Categories</button><p role="status"></p></form>'
      const form = panel.querySelector('form')
      form.onsubmit = async submit => {
        submit.preventDefault()
        const action = form.querySelector('button')
        const status = form.querySelector('[role="status"]')
        action.disabled = true
        try {
          const result = await request(path + '/recovery/quarantine',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:new FormData(form).get('role')})})
          status.textContent = result.notices.length ? result.notices.join(' · ') : 'Quarantine Role configured.'
          if (!new FormData(form).get('role')) {
            const [updated,options] = await Promise.all([request(path + '/recovery'),request(path + '/options')])
            form.querySelector('.discord-select').outerHTML = discordSelect('role',options.roles,[updated.quarantineSetup])
          }
        } catch (error) { status.textContent = error.message }
        finally { action.disabled = false }
      }
    } catch (error) {
      panel.querySelector('p').textContent = error.message
      button.disabled = false
    }
  }
}
async function dashboard() {
  document.body.classList.add('dashboard-page')
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
    const recoverySection = ['lockdown','backup','moderation'].includes(section)
    const needsOptions = Object.hasOwn(settingFields,section) || section === 'permits' || (recoverySection && data.owner)
    const [choices,recoveryState,eventData] = await Promise.all([
      needsOptions ? request(path + '/options') : null,
      recoverySection && data.owner && section !== 'moderation' ? request(path + '/recovery') : {},
      ['logs','moderation'].includes(section) ? request(path + '/events') : {events:[]}
    ])
    const linkedSwitch = Object.hasOwn(settingFields,section) || section === 'permits'
    const serviceSwitch = ['backup','moderation','lockdown'].includes(section)
    let switchControl = ''
    if (linkedSwitch || serviceSwitch) {
      const field = '<label class="module-switch"><input type="checkbox" role="switch" name="enabled" aria-label="' + sections[section] + '"' + (linkedSwitch ? ' form="settings"' : '') + (data.config[section].enabled ? ' checked' : '') + (data.owner ? '' : ' disabled') + '><span></span></label>'
      switchControl = serviceSwitch ? '<form id="module-toggle">' + field + '<p class="error" role="status"></p></form>' : field
    }
    const heading = '<div class="page-heading"><span class="icon-tile">' + icon(section) + '</span><div><h2 class="dash-title">' + sections[section] + '</h2></div>' + switchControl + '</div>'
    const {events} = eventData
    const activity = '<section class="card stack"><h3>' + 'Event History' + '</h3><div id="events">' + logList(events) + '</div></section>'
    const serverPath = base + '/' + encodeURIComponent(id)
    const navigation = key => '<a href="' + serverPath + '/' + key + '"' + (key === section ? ' aria-current="page"' : '') + '>' + icon(key) + sections[key] + '</a>'
    const modules = ['nuke','raid','checkpoint','automod','lockdown','moderation','backup','permits'].map(key => {
      const restricted = key === 'permits' && !data.owner
      const enabled = data.config[key]?.enabled
      const state = key === 'lockdown' ? (data.lockdownActive ? 'Active' : 'Inactive') : key === 'backup' && enabled ? (data.backupsScheduled ? 'Scheduled' : 'Manual') : restricted ? 'Owner only' : enabled ? '<i class="dot"></i> Enabled' : 'Disabled'
      return '<article class="card compact-module"><div class="module-head"><span class="icon-tile">' + icon(key) + '</span><div><h3>' + sections[key] + '</h3><span class="badge">' + state + '</span></div></div>' + (restricted ? '<span class="button module-configure" aria-disabled="true">Owner only</span>' : '<a class="button module-configure" href="' + serverPath + '/' + key + '" aria-label="Configure ' + sections[key] + '">' + icon('configure') + ' Configure</a>') + '</article>'
    }).join('')
    const overview = '<section class="module-section"><div class="module-grid">' + modules + '</div></section>'
    document.body.classList.add('has-workspace')
    shell('<div class="dash-layout"><nav class="sidebar" aria-label="Server navigation"><a class="server-switch" title="Switch server" href="' + base + '">' + (data.icon ? '<img class="switch-avatar" src="https://cdn.discordapp.com/icons/' + encodeURIComponent(id) + '/' + encodeURIComponent(data.icon) + '.png?size=64" alt="">' : icon('server')) + '<span>' + esc(data.name) + '</span></a>' + navigation('overview') + navigation('premium') + navigation('logs') + '<span class="nav-label">Protection</span>' + navigation('nuke') + navigation('raid') + navigation('checkpoint') + navigation('lockdown') + '<span class="nav-label">Administration</span>' + navigation('automod') + navigation('moderation') + navigation('backup') + (data.owner ? navigation('permits') : '') + '</nav><div class="dash-pane"><div class="dash-main">' + heading + (section === 'overview' ? overview : section === 'premium' ? premiumPlans() : section === 'logs' ? activity : section === 'permits' ? permitsForm(data.config.permits,choices.roles) : ['lockdown','backup'].includes(section) ? '<div id="recovery"></div>' : section === 'moderation' ? '<section class="card"><h3>Slash Commands</h3><p>' + commandNames.map(name => '/' + name).join(' · ') + '</p><h3 class="stack">Recent Cases</h3>' + logList(events.filter(event => event.kind === 'moderation').slice(0,5),true) + '</section><div id="recovery"></div>' : form(section,data.config[section],data.owner)) + '<p id="refresh" role="status"></p></div></div></div>')
    const settings = document.querySelector('#settings')
    const headerSwitch = document.querySelector('.module-switch input[form=settings]')
    headerSwitch?.addEventListener('change',() => settings.dispatchEvent(new Event('change')))
    const serviceToggle = document.querySelector('#module-toggle')
    if (serviceToggle && data.owner) autosave(serviceToggle,serviceToggle.querySelector('[role=status]'),async () => {
      const enabled = serviceToggle.elements.enabled.checked
      await request(path + '/' + section,{
        method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled}),keepalive:true
      })
      data.config[section].enabled = enabled
    })
    if (settings?.elements.alertChannel) wireDiscordSelectors(settings,choices)
    if (section === 'permits') wirePermits(settings,choices.roles)
    if (settings && settingFields[section]) protectionControls(settings,section,data.config[section])
    if (settings && settingFields[section]) {
      collapseSettings(settings.querySelector('.settings-section'),'Configure thresholds and the default response for this module.')
      collapseSettings(settings.querySelector('.discord-alerts'),'Choose the logging channel and roles to notify.')
    }
    if (settings && section === 'nuke') nukeControls(settings,data.config.nuke,choices.roles)
    const readOnly = settings?.querySelector('fieldset:disabled')
    if (readOnly) {
      for (const control of readOnly.querySelectorAll('input:not([type=search]), select, textarea, button:not([data-open-settings],[data-close-settings],[data-nuke-config],[data-close-nuke])')) control.disabled = true
      readOnly.disabled = false
    }
    if (settings && section === 'nuke' && data.owner) setupQuarantine(settings,path)
    if (recoverySection) await recoveryPanel(section,path,data,[choices,recoveryState])
    if (settings && data.owner) autosave(settings,settings.querySelector('#notice'),async () => {
      const fields = new FormData(settings)
      const payload = section === 'permits' ? {...readPermits(settings),enabled:fields.has('enabled')} : {enabled:fields.has('enabled')}
      if (fields.has('action')) payload.action = fields.get('action')
      const ruleResponse = key => {
        const resumeAction = fields.get(key + '-action')
        const active = settings.elements[key + '-action'].closest('.response-rule').querySelector('[data-response-toggle]').checked
        return {action:active ? resumeAction : 'off',resumeAction}
      }
      if (section === 'automod') payload.filters = Object.fromEntries(Object.keys(filters).map(key => [key,{
        ...ruleResponse(key),limit:Number(fields.get(key + '-limit')),points:Number(fields.get(key + '-points'))
      }]))
      if (section === 'automod') {
        for (const name of ['badWords','nsfwDomains','maliciousDomains']) payload[name] = fields.get(name).split(/[\n,]/).map(value => value.trim()).filter(Boolean).join(',')
        payload.pointRules = [...settings.querySelectorAll('.point-rule')].map(row => ({
          points:Number(row.querySelector('[name=rule-points]').value),
          hours:Number(row.querySelector('[name=rule-hours]').value),
          action:row.querySelector('[name=rule-action]').value
        }))
      }
      if (section === 'checkpoint') {
        payload.rules = fields.getAll('score').map((score,index) => ({score:Number(score),action:fields.getAll('rule')[index]}))
        for (const key of ['verifiedBot','unverifiedBot']) payload[key] = {
          ...ruleResponse(key),quarantine:fields.has(key + '-quarantine')
        }
      }
      if (section === 'nuke') {
        payload.rates = {}
        payload.guards = {}
        for (const row of settings.querySelectorAll('[data-nuke][data-configured=true]')) {
          const key = row.dataset.nuke
          const rule = {enabled:fields.has(key + '-enabled'),escalateAfter:Number(fields.get(key + '-escalate')),
            escalateTo:fields.get(key + '-escalateTo')}
          if (fields.get(key + '-action')) rule.action = fields.get(key + '-action')
          if (Object.hasOwn(rateLabels,key)) {
            const saved = data.config.nuke.rates?.[key] ?? data.config.nuke
            payload.rates[key] = {...rule,threshold:saved.threshold,window:saved.window}
            if (row.dataset.rolling === 'true') Object.assign(payload.rates[key],{minute:Number(fields.get(key + '-minute')),hour:Number(fields.get(key + '-hour'))})
            continue
          }
          if (['publicRoles','assignments','rolePermissions'].includes(key))
            rule.permissions = Object.keys(nukePermissions).filter(permission => fields.has(key + '-permission-' + permission))
          if (key === 'identity') rule.identity = ['icon_hash','name','vanity_url_code'].filter(field => fields.has(key + '-identity-' + field))
          if (key === 'publicRoles') Object.assign(rule,{onboarding:fields.has('publicRoles-onboarding'),roles:fields.getAll('publicRoles-roles')})
          if (key === 'gate') rule.gates = [...row.querySelectorAll('.nuke-gate')].flatMap(gate => {
            const role = gate.querySelector('input[type=radio]:checked')?.value
            const required = [...gate.querySelectorAll('input[name=gate-required]:checked')].map(input => input.value).filter(id => id !== role)
            return role && required.length ? [{role,required}] : []
          })
          payload.guards[key] = rule
        }
      }
      for (const [key,,min] of (settingFields[section] ?? [])) payload[key] = min === undefined ? fields.get(key) : Number(fields.get(key))
      if (fields.has('alertChannel')) {
        payload.alertChannel = payload.alertChannel.trim()
        payload.alertRoles = fields.getAll('alertRoles')
      }
      await request(path + '/' + section,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),keepalive:true})
    })
    if (section === 'logs') {
      const refresh = async () => {
        try {
          if (!document.hidden) {
            const latest = await request(path + '/events')
            document.querySelector('#events').innerHTML = logList(latest.events)
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
  if (Object.hasOwn(resources,location.pathname)) shell('<div class="resource-page">' + resources[location.pathname] + '</div>')
  if (location.pathname === '/premium') premium()
  if (location.pathname === '/support') shell('<h2>Support Server</h2><p>The Discord support invite is currently unavailable.</p>')
  request('/api/me').then(accountMenu).catch(() => {})
}

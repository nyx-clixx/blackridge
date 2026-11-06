import { resources } from './resources.js'

const app = document.querySelector('#app')
const account = document.querySelector('#account')
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char])
const iconPaths = {
  verification:'<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><path d="M13 13h4v4h4m0-4v1m-8 3v4h4m4 0h.01"/>',
  appeals:'<path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l1.5-3A7.5 7.5 0 1 1 20 11.5Z"/><path d="M9 10h6m-6 3h4"/>',
  pin:'<path d="m16 3 5 5-3 1-3 5v3l-3-3-5 5-2-2 5-5-3-3h3l5-3z"/>',
  custom:'<rect x="4" y="7" width="16" height="13" rx="4"/><path d="M12 7V3m-3 9h.01m6 0h.01M9 16h6"/>',
  configure:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.5" fill="var(--panel)"/><circle cx="15" cy="17" r="2.5" fill="var(--panel)"/>',
  lockdown:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  backup:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  premium:'<path d="m3 6 4 4 5-6 5 6 4-4-2 12H5L3 6Zm3 15h12"/>',
  checkpoint:'<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3"/><circle cx="12" cy="10" r="2.5"/><path d="M8 17a4 4 0 0 1 8 0"/>',
  automod:'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2" fill="var(--panel)"/><circle cx="15" cy="12" r="2" fill="var(--panel)"/><circle cx="10" cy="18" r="2" fill="var(--panel)"/>',
  moderation:'<path d="M5 4h14v16H5zM8 8h8M8 12h8m-8 4h4"/>',
  permits:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/>',
  overview:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  nuke:'<path d="M8 12V5a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v6-3a1.5 1.5 0 0 1 3 0v6a8 8 0 0 1-8 8h-1a6 6 0 0 1-5-3l-3-5a1.7 1.7 0 0 1 2.7-2L8 14"/>',
  raid:'<path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2m19 0v-2a4 4 0 0 0-3-4m-2-12a4 4 0 0 1 0 8"/><circle cx="9.5" cy="7" r="4"/>',
  logs:'<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  server:'<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>'
}
const icon = key => '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (iconPaths[key] ?? iconPaths.nuke) + '</svg>'
for (const tile of document.querySelectorAll('[data-icon]')) tile.innerHTML = icon(tile.dataset.icon)
const sections = { overview:'Overview', premium:'Premium', custom:'Custom Bot', nuke:'Anti-Nuke', raid:'Anti-Raid', logs:'Security Logs', checkpoint:'Checkpoint', automod:'Auto Moderation', moderation:'Moderation', permits:'Permits', lockdown:'Lockdown', backup:'Server Backups',verification:'Verification',appeals:'Ban Appeals' }
const paidGuards = ['channelRename','roleRename','emojiDelete','stickerDelete','soundboardDelete']
const paidFilters = ['ghost','malicious']
const crown = '<span class="premium-crown" title="Premium or Custom Bot" aria-label="Premium or Custom Bot">' + icon('premium') + '</span>'
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
    const command = event.kind === 'moderation' && event.detail.match(/^(ban|tempban|unban|kick|timeout|warn|lock-channel|unlock-channel|lock|unlock|purge|force-verify)\b/)?.[1]
    let detail = event.detail
    if (/^\d{17,20}$/.test(event.userId ?? '')) {
      const actor = event.userId
      if (['settings','backup'].includes(event.kind)) detail = detail.replace(new RegExp(' by ' + actor + '$'),'')
      if (event.kind === 'moderation') detail = detail.replace(new RegExp('^(\\w[\\w-]* · (?:member \\d+|channel \\d+|\\d+ messages · channel \\d+)) · moderator ' + actor + '(?= · |$)'),'$1')
      detail = detail.replace(new RegExp(' · initiated by ' + actor + '$'),'')
    }
    if (event.kind === 'settings') detail = detail.replace(/^([a-z]+) policy updated$/i,(_,kind) =>
      (sections[kind] ?? kind[0].toUpperCase() + kind.slice(1)) + ' Policy Updated')
    if (command && !moderation) detail = detail.replace(command,command.split('-').map(word => word[0].toUpperCase()+word.slice(1)).join(' '))
    const action = moderation && command ? '/' + command : detail.replace(/\b(?:invites_disabled_until|dms_disabled_until)\b/g,key => key === 'invites_disabled_until' ? 'invite pause' : 'DM pause').trim()
    return '<tr><td><div class="case-user">' + avatar + '<div><strong>' + esc(event.userName ?? (event.userId ? 'Unknown user' : 'System')) + '</strong><code>' + esc(event.userId ?? '—') + '</code></div></div></td><td><span title="' + esc(detail) + '">' + esc(action) + '</span></td><td><time datetime="' + new Date(event.at).toISOString() + '">' + esc(new Date(event.at).toLocaleString()) + '</time></td></tr>'
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
  identity:['Server Identity Changes','Watch for changes to the server name, icon, or vanity invite link.'],
  channelRename:['Anti-Channel Rename','Detect renames of selected channels and restore their names when enforcement is enabled.'],
  roleRename:['Anti-Role Rename','Detect renames of selected roles and restore their names when enforcement is enabled.'],
  emojiDelete:['Emoji Deletion Protection','Detect deleted server emoji and apply the configured response.'],
  stickerDelete:['Sticker Deletion Protection','Detect deleted server stickers and apply the configured response.'],
  soundboardDelete:['Soundboard Deletion Protection','Detect deleted server soundboard sounds and apply the configured response.']
}
const nukePermissions = {
  Administrator:'Administrator',KickMembers:'Kick Members',BanMembers:'Ban Members',ManageGuild:'Manage Server',
  ManageRoles:'Manage Roles',ManageChannels:'Manage Channels',ManageWebhooks:'Manage Webhooks',MentionEveryone:'Mention Everyone'
}
function nukeControls(form,config,{roles,channels,renameChannels},paid) {
  const check = (name,label,checked) => '<label class="toggle"><input type="checkbox" name="' + name + '"' + (checked ? ' checked' : '') + '>' + label + '</label>'
  const number = (name,label,value,max) => '<label>' + label + '<span class="nuke-stepper"><button type="button" data-step="-1" aria-label="Decrease ' + label + '">−</button><input required type="number" name="' + name + '" min="0" max="' + max + '" value="' + value + '"><button type="button" data-step="1" aria-label="Increase ' + label + '">+</button></span></label>'
  const gateRow = (gate = {role:'',required:[]}) => '<div class="nuke-gate"><div class="discord-field"><span>Gated Role</span>' + discordSelect('gate-role-' + gateIndex++,roles,[gate.role]) + '</div><div class="discord-field"><span>Required Roles</span>' + discordSelect('gate-required',roles,gate.required,true) + '</div><button class="button small" type="button" data-remove-gate>Remove</button></div>'
  let gateIndex = 0
  function row(key,label,description,saved,isRate) {
    if (!paid && paidGuards.includes(key)) return '<article class="nuke-row"><div><h4>' + label + crown + '</h4><p>' + description + '</p></div><a class="button small" href="premium">View Plans</a></article>'
    const rule = saved ?? {}
    const actionOptions = shortestFirst(actionsByKind.nuke.map(action => [action,actionLabels[action]]))
    const select = (name,label,items,value) => '<label>' + label + '<select name="' + key + '-' + name + '">' + items.map(([id,text]) => '<option value="' + id + '"' + (id === value ? ' selected' : '') + '>' + text + '</option>').join('') + '</select></label>'
    const choices = (name,items,selected) => Object.entries(items).map(([value,text]) => check(key + '-' + name + '-' + value,text,selected.includes(value))).join('')
    const permissions = ['publicRoles','assignments','rolePermissions'].includes(key)
      ? '<div class="nuke-choices"><strong>Dangerous Permissions</strong>' + choices('permission',nukePermissions,rule.permissions ?? Object.keys(nukePermissions)) + '</div>' : ''
    const extras = key === 'publicRoles' ? check('publicRoles-onboarding','Protect Self-Assignable Onboarding Roles',rule.onboarding !== false) +
      '<div class="discord-field"><span>Additional Protected Roles</span>' + discordSelect('publicRoles-roles',roles,rule.roles ?? [],true) + '</div>'
      : key === 'channelRename' ? '<div class="discord-field"><span>Protected Channels</span>' + discordSelect('channelRename-channels',renameChannels ?? channels,rule.channels ?? [],true) + '</div>'
      : key === 'roleRename' ? '<div class="discord-field"><span>Protected Roles</span>' + discordSelect('roleRename-roles',roles,rule.roles ?? [],true) + '</div>'
      : key === 'identity' ? '<div class="nuke-choices"><strong>Identity Changes to Watch</strong>' + choices('identity',{icon_hash:'Server Icon',name:'Server Name',vanity_url_code:'Vanity Invite Link'},rule.identity ?? ['icon_hash','name','vanity_url_code']) + '</div>'
      : key === 'gate' ? '<p>Members need at least one required role. With an enforcement response, Blackridge also removes unauthorized grants where it can.</p><div class="nuke-gates">' + (rule.gates ?? []).map(gateRow).join('') + '</div><button type="button" class="button small" data-add-gate>Add Gated Role</button>' : ''
    const time = isRate ? '<div class="fields">' + number(key + '-minute','Per Minute',rule.minute ?? 5,500) + number(key + '-hour','Per Hour',rule.hour ?? 15,500) + '</div><p>Set either limit to 0 to turn off that window.' +
      (saved && rule.minute === undefined ? ' This rule currently uses its previous ' + rule.threshold + ' in ' + rule.window + 's limit. Edit either limit to switch to rolling windows.' : '') + '</p>' : ''
    return '<article class="nuke-row" data-nuke="' + key + '" data-configured="' + Boolean(saved) + '" data-rolling="' + (rule.minute !== undefined) + '"><div><h4>' + label + (paidGuards.includes(key) ? crown : '') + '</h4><p>' + description + '</p></div><div class="nuke-row-actions"><button type="button" class="button small" data-nuke-config aria-label="Configure ' + label + '">' + icon('automod') + ' Configure</button><label class="nuke-switch"><input type="checkbox" role="switch" aria-label="Enable ' + label + '" name="' + key + '-enabled"' + (rule.enabled ? ' checked' : '') + '><span aria-hidden="true"></span></label></div><dialog class="nuke-dialog" aria-labelledby="nuke-title-' + key + '"><header><h3 id="nuke-title-' + key + '">' + label + '</h3><button type="button" class="button small" data-close-nuke aria-label="Close settings">×</button></header><div class="nuke-dialog-fields">' +
      select('action','Response',shortestFirst([['','Use Default Response'],...actionOptions]),rule.action ?? '') + '<div class="fields">' +
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
function shortestFirst(entries) {
  return entries.sort(([,a],[,b]) => a.length - b.length)
}
function options(labels, selected, byLength = false) {
  const entries = Object.entries(labels)
  return (byLength ? shortestFirst(entries) : entries).map(([value,label]) => '<option value="' + value + '"' + (selected === value ? ' selected' : '') + '>' + label + '</option>').join('')
}
const durationUnits = {seconds:1,minutes:60,hours:3600,days:86400}
const durationLabels = {seconds:'Seconds',minutes:'Minutes',hours:'Hours',days:'Days'}
function displayDuration(seconds,unit) {
  return Number((seconds / durationUnits[unit]).toFixed(10))
}
function durationField(name,label,value,min,max,base) {
  return '<div class="duration-field" data-duration data-base="' + base + '" data-min="' + min + '" data-max="' + max + '"><label>' + label +
    '<input type="number" required step="any" min="0" name="' + name + '" value="' + esc(value) + '"></label><label><select data-duration-unit data-previous="' + base + '" aria-label="' + label + ' unit">' +
    options(durationLabels,base) + '</select></label></div>'
}
function durationValue(input) {
  const field = input.closest('[data-duration]')
  const unit = field.querySelector('[data-duration-unit]').value
  return input.valueAsNumber * durationUnits[unit] / durationUnits[field.dataset.base]
}
function readDuration(input) {
  const base = durationUnits[input.closest('[data-duration]').dataset.base]
  return Math.round(durationValue(input) * base) / base
}
function validateDuration(input) {
  const {min,max,base} = input.closest('[data-duration]').dataset
  const seconds = durationValue(input) * durationUnits[base]
  const rounded = Math.round(seconds)
  const outOfRange = rounded < Number(min) * durationUnits[base] || rounded > Number(max) * durationUnits[base]
  input.setCustomValidity(outOfRange ? 'Enter a duration between ' + min + ' and ' + max + ' ' + base + '.' :
    Math.abs(seconds - rounded) > 0.00001 ? 'Use a duration in whole seconds.' : '')
}
document.addEventListener('input',event => {
  if (event.target.matches('[data-duration] input')) validateDuration(event.target)
},true)
document.addEventListener('change',event => {
  const select = event.target
  if (select.matches('[data-duration] input')) { select.reportValidity(); return }
  if (!select.matches('[data-duration-unit]')) return
  const input = select.closest('[data-duration]').querySelector('input')
  if (input.value !== '') input.value = displayDuration(input.valueAsNumber * durationUnits[select.dataset.previous],select.value)
  select.dataset.previous = select.value
  validateDuration(input)
},true)
function verificationForm(config,owner,choices) {
  const field = (name,label,items) => '<div class="discord-field"><span>' + label + '</span>' + discordSelect(name,items,[config[name]]) + '</div>'
  const channels = choices.channels.filter(channel => channel.sendable)
  return '<form id="settings"><fieldset class="settings-panels"' + (owner ? '' : ' disabled') + '><section class="card settings-section"><h3>Verification Setup</h3><p>Give the Verified Role access to your member channels in Discord. Keep the verification channel visible to new members.</p><div class="fields"><label>Verification Mode<select name="mode">' + options({button:'One-click verification',captcha:'Image CAPTCHA'},config.mode) + '</select></label>' +
    field('channel','Verification Channel',channels) + field('verifiedRole','Verified Role',choices.roles) +
    field('unverifiedRole','Unverified Role (optional)',choices.roles) + durationField('minAge','Minimum Account Age',config.minAge,0,365,'days') + '</div>' +
    (owner ? '<button class="button primary stack" type="button" id="publish-verification">Publish Verification Panel</button><p id="verification-publish-result" role="status"></p>' : '') +
    '</section><section class="card settings-section" id="captcha-settings"><h3>CAPTCHA Settings</h3><div class="fields"><label>Max Attempts<input name="attempts" type="number" min="1" max="5" required value="' + config.attempts + '"></label>' + durationField('minutes','Challenge Duration',config.minutes,1,10,'minutes') + '<label>After Failed Attempts<select name="failure">' + options({retry:'Keep Unverified',kick:'Kick Member'},config.failure,true) + '</select></label></div></section><section class="card settings-section"><h3>Discord Logging</h3>' + field('alertChannel','Logging Channel',channels) + '</section></fieldset><p id="notice" role="status"></p></form>'
}
function appealsPanel(path,config,channels) {
  const panel = document.querySelector('#appeals-panel')
  const row = value => {
    const question = typeof value === 'string' ? {label:value,type:'paragraph'} : value
    return '<div class="appeal-question card" draggable="true"><div class="fields"><label>Question<input name="label" maxlength="45" required value="' + esc(question.label) +
      '"></label><label>Answer Type<select name="type">' + options({paragraph:'Paragraph',short:'Short Answer',checkbox:'Checkbox (Yes or No)'},question.type) +
      '</select></label></div><div class="actions"><button type="button" class="button small" data-question="up">Move Up</button><button type="button" class="button small" data-question="down">Move Down</button><button type="button" class="button small" data-question="remove">Remove</button></div></div>'
  }
  const channelChoices = channels.filter(channel => channel.sendable)
  panel.innerHTML = (config ? '<form class="card stack"><h3>Appeal Form</h3><p>Add up to five questions. Drag to reorder, or use Move Up and Move Down.</p><div class="settings-panels" id="appeal-questions">' +
    config.questions.map(row).join('') + '</div><button type="button" class="button stack" id="add-appeal-question">Add Question</button><div class="fields"><div class="discord-field"><span>Private Review Channel</span>' +
    discordSelect('channel',channelChoices,[config.channel]) + '</div><div class="discord-field"><span>Appeal Log Channel</span>' + discordSelect('alertChannel',channelChoices,[config.alertChannel]) +
    '</div></div><p>Deny View Channel to @everyone on both channels. The log channel receives submission and decision notices.</p><p role="status"></p></form>' : '') +
    '<section class="card stack"><h3>Appeal Inbox</h3><div id="appeal-inbox"></div><p id="appeal-status" role="status"></p></section>'
  const form = panel.querySelector('form')
  const inbox = panel.querySelector('#appeal-inbox')
  const status = panel.querySelector('#appeal-status')
  if (form) {
    const list = form.querySelector('#appeal-questions')
    const add = form.querySelector('#add-appeal-question')
    const changed = () => {
      add.disabled = list.children.length >= 5
      form.dispatchEvent(new Event('change'))
    }
    add.disabled = list.children.length >= 5
    add.onclick = () => {
      if (list.children.length >= 5) return
      list.insertAdjacentHTML('beforeend',row({label:'',type:'paragraph'}))
      list.lastElementChild.querySelector('input').focus()
      changed()
    }
    list.onclick = event => {
      const button = event.target.closest('[data-question]')
      if (!button) return
      const question = button.closest('.appeal-question')
      if (button.dataset.question === 'up' && question.previousElementSibling) question.previousElementSibling.before(question)
      if (button.dataset.question === 'down' && question.nextElementSibling) question.nextElementSibling.after(question)
      if (button.dataset.question === 'remove' && list.children.length > 1) question.remove()
      if (button.isConnected) button.focus()
      else add.focus()
      changed()
    }
    let dragging
    list.ondragstart = event => {
      dragging = event.target.closest('.appeal-question')
      if (dragging) event.dataTransfer.setData('text/plain','appeal-question')
    }
    list.ondragend = () => { dragging = null }
    list.ondragover = event => { if (dragging) event.preventDefault() }
    list.ondrop = event => {
      const target = event.target.closest('.appeal-question')
      if (!dragging || !target || target === dragging) return
      event.preventDefault()
      const bounds = target.getBoundingClientRect()
      if (event.clientY > bounds.top + bounds.height/2) target.after(dragging)
      else target.before(dragging)
      changed()
    }
    autosave(form,form.querySelector('[role=status]'),async () => {
      const questions = [...list.children].map(item => ({label:item.querySelector('input').value.trim(),type:item.querySelector('select').value}))
      const fields = new FormData(form)
      await request(path + '/appeals',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        questions,channel:fields.get('channel') ?? '',alertChannel:fields.get('alertChannel') ?? ''
      }),keepalive:true})
    })
  }
  async function refresh() {
    const {appeals} = await request(path + '/appeals')
    inbox.innerHTML = appeals.length ? appeals.map(item => '<details class="appeal-item"><summary><span>' + esc(item.user) + '</span><span class="badge">' + esc(item.status) + '</span><time>' + esc(new Date(item.submitted).toLocaleString()) + '</time></summary><dl>' + item.questions.map((question,index) =>
      '<dt>' + esc(typeof question === 'string' ? question : question.label) + '</dt><dd>' + esc(item.answers[index]) + '</dd>').join('') + '</dl>' +
      (item.status === 'pending' ? '<div class="actions">' + [['accepted','Accept and Unban'],['rejected','Reject'],['blacklisted','Blacklist']].map(([decision,label]) =>
        '<button type="button" class="button small" data-decision="' + decision + '" data-appeal="' + esc(item.id) + '">' + label + '</button>').join('') + '</div>' : '') + '</details>').join('') : '<p>No appeals submitted yet.</p>'
  }
  inbox.onclick = async event => {
    const button = event.target.closest('[data-decision]')
    const prompts = {accepted:'Accept this appeal and lift the original ban?',rejected:'Reject this appeal?',blacklisted:'Reject this appeal and prevent future appeals from this account in this server?'}
    if (!button || !confirm(prompts[button.dataset.decision])) return
    button.disabled = true
    try {
      await request(path + '/appeals/' + encodeURIComponent(button.dataset.appeal),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision:button.dataset.decision})})
      status.textContent = 'Appeal ' + button.dataset.decision + '.'
      await refresh()
    } catch (error) { status.textContent = error.message }
    finally { button.disabled = false }
  }
  refresh().catch(error => { status.textContent = error.message })
}
function securityScore(checks) {
  const labels = {raid:'Anti-Raid Enabled',nuke:'Anti-Nuke Enabled',checkpoint:'Checkpoint Enabled',priority:'Highest Role Priority',admin:'Administrator Permission',quarantine:'Quarantine Role Configured'}
  const passed = Object.keys(labels).filter(key => checks?.[key]).length
  return '<section class="card security-summary"><div><h3>Security Score</h3><strong>' + Math.round(passed/6*100) + '%</strong><p>' + passed + ' of 6 checks passed</p></div><ul>' + Object.entries(labels).map(([key,label]) =>
    '<li><span class="security-check' + (checks?.[key] ? ' passed' : '') + '">' + (checks?.[key] ? '✓' : '–') + '</span><span>' + label + '</span><span class="muted">' + (checks?.[key] ? 'Pass' : 'Needs attention') + '</span></li>').join('') + '</ul></section>'
}
function renderServerPicker(guilds,userId) {
  const key = 'blackridge:pins:' + userId
  let pinned = new Set()
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? '[]')
    if (Array.isArray(saved)) pinned = new Set(saved)
  } catch {}
  function render(focusId) {
    const sorted = [...guilds].sort((a,b) => Number(pinned.has(b.id))-Number(pinned.has(a.id)))
    shell('<h2>Select a server</h2><div class="servers">' + sorted.map(guild => '<article class="card server-card"><div class="server-card-top"><div class="server-avatar">' + (guild.icon ? '<img alt="" src="https://cdn.discordapp.com/icons/' + esc(guild.id) + '/' + esc(guild.icon) + '.png">' : esc(guild.name.slice(0,2).toUpperCase())) + '</div><button type="button" class="button small pin-server" data-pin="' + esc(guild.id) + '" aria-pressed="' + pinned.has(guild.id) + '" aria-label="Pin ' + esc(guild.name) + '">' + icon('pin') + '</button></div><h3>' + esc(guild.name) + '</h3><div class="server-access ' + (guild.owner ? 'is-owner' : '') + '">' + icon(guild.owner ? 'premium' : 'server') + (guild.owner ? 'Owner' : 'Dashboard Access') + '</div><a class="button small" href="' + (guild.installed ? base + '/' + guild.id : '/invite?guild=' + guild.id) + '">' + (guild.installed ? 'Manage' : 'Set up') + '</a></article>').join('') + '</div>' + (guilds.length ? '' : '<div class="card">No servers with management access were found.</div>'))
    for (const button of app.querySelectorAll('[data-pin]')) {
      if (button.dataset.pin === focusId) button.focus()
      button.onclick = () => {
        const id = button.dataset.pin
        if (pinned.has(id)) pinned.delete(id)
        else pinned.add(id)
        try { localStorage.setItem(key,JSON.stringify([...pinned])) } catch {}
        render(id)
      }
    }
  }
  render()
}
const automodActions = {
  log:['Log Only','Record the detection in the security logs.','logs'],
  delete:['Delete Message','Remove the matching message after it is sent.','trash'],
  warn:['Warn Member','Record a warning and try to notify the member by DM.','warning'],
  timeout:['Time Out Member','Temporarily prevent the member from communicating.','timer']
}
const automodIcons = {
  trash:'<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5"/>',
  warning:'<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>',
  timer:'<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/>',
  repeat:'<path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15m-14 16-4-4 4-4m14-1v2a3 3 0 0 1-3 3H3"/>',
  links:'<path d="m10 13 4-4m-6 6-2 2a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0m4 0 2-2a3 3 0 0 1 4 4l-4 4a3 3 0 0 1-4 0"/>',
  emoji:'<circle cx="12" cy="12" r="9"/><path d="M8 14a4 4 0 0 0 8 0m-7-5h.01m6 0h.01"/>',
  mentions:'<circle cx="11" cy="12" r="4"/><path d="M15 9v5a2 2 0 0 0 4 0v-2a8 8 0 1 0-4 7"/>'
}
function automodIcon(key) {
  return automodIcons[key] ? icon('logs').replace(iconPaths.logs,automodIcons[key]) : icon(key)
}
function automodControls(config,paid) {
  const fieldMap = {badWords:['badWords','Blocked Phrases'],nsfw:['nsfwDomains','Additional NSFW Domains'],malicious:['maliciousDomains','Additional Malicious Domains']}
  const icons = {badWords:'warning',duplicate:'repeat',invites:'links',links:'links',emoji:'emoji',mentions:'mentions',spam:'timer',newlines:'logs',headers:'moderation',multiUser:'raid',scam:'warning',nsfw:'links',malicious:'links',ghost:'mentions'}
  const titles = {duplicate:'Repeat Messages',emoji:'Mass Emojis',spam:'Anti-Spam'}
  const limits = {emoji:'Emojis per message',duplicate:'Repeats per member',multiUser:'Members repeating the message',mentions:'Mentions per message',caps:'Percentage of uppercase letters',length:'Characters per message',newlines:'Line breaks per message'}
  const order = ['badWords','duplicate','invites','links','emoji','mentions','spam','newlines','headers',...Object.keys(filters).filter(key => !['badWords','duplicate','invites','links','emoji','mentions','newlines','headers'].includes(key))]
  const cards = order.map(key => {
    const spam = key === 'spam'
    const [name,limit] = spam ? ['Anti-Spam',config.threshold] : filters[key]
    const label = titles[key] ?? name
    const rule = spam ? {action:config.action,points:config.spamPoints,limit} : config.filters?.[key]
    const gated = paidFilters.includes(key)
    const head = '<div class="automod-card-head"><span class="automod-icon">' + automodIcon(icons[key] ?? 'configure') + '</span><div><h4>' + label + (gated ? crown : '') + '</h4>'
    if (gated && !paid) return '<article class="automod-card">' + head + '<p>Premium rule</p></div></div><a class="button small automod-edit" href="premium">View Plans</a></article>' +
      '<input type="hidden" name="' + key + '-action" value="off"><input type="hidden" name="' + key + '-limit" value="' + limit + '"><input type="hidden" name="' + key + '-points" value="0">' +
      (key === 'malicious' ? '<input type="hidden" name="maliciousDomains" value="">' : '')
    const enabled = spam ? config.spamEnabled !== false : Boolean(rule && rule.action !== 'off')
    const response = enabled || spam ? rule.action : rule?.response ?? (key === 'ghost' ? 'log' : 'delete')
    const actions = Object.entries(automodActions).filter(([action]) => key !== 'ghost' || action !== 'delete').map(([action,[title,description,symbol]]) =>
      '<label class="automod-action"><span class="automod-icon">' + automodIcon(symbol) + '</span><span><strong>' + title + '</strong><small>' + description + '</small></span><input type="radio" name="' + key + '-response" value="' + action + '"' + (response === action ? ' checked' : '') + '></label>').join('')
    const field = fieldMap[key]
    const list = field ? '<label>' + field[1] + ' (one per line)<textarea name="' + field[0] + '" maxlength="500" rows="5" spellcheck="false">' +
      esc((config[field[0]] ?? '').split(',').map(value => value.trim()).filter(Boolean).join('\n')) + '</textarea></label>' : ''
    const threshold = '<label>' + (spam ? 'Messages per member' : limits[key] ?? 'Trigger threshold') +
      '<input type="number" required min="' + (spam ? 3 : 1) + '" max="' + (spam ? 30 : 4000) + '" name="' + (spam ? 'threshold' : key + '-limit') + '" value="' + esc(rule?.limit ?? limit) + '"></label>'
    return '<article class="automod-card" data-automod-rule="' + key + '">' + head + '<p data-rule-summary>' + (enabled ? automodActions[response][0] : 'Disabled') +
      '</p></div><label class="nuke-switch"><input type="checkbox" role="switch" name="' + key + '-enabled" aria-label="Enable ' + label + '"' + (enabled ? ' checked' : '') + '><span aria-hidden="true"></span></label></div>' +
      '<input type="hidden" name="' + (spam ? 'action' : key + '-action') + '" value="' + (enabled || spam ? response : 'off') + '"><button type="button" class="button small automod-edit" data-edit-rule aria-label="Edit ' + label + '">Edit Rule</button>' +
      '<dialog class="nuke-dialog automod-dialog" aria-labelledby="automod-title-' + key + '"><header><h3 id="automod-title-' + key + '">' + label + '</h3><button type="button" class="button small" data-close-rule aria-label="Close rule editor">×</button></header>' +
      '<div class="nuke-dialog-fields"><fieldset class="automod-actions"><legend>Action</legend>' + actions + '</fieldset><div class="fields">' + threshold +
      '<label>Points<input type="number" required min="0" max="100" name="' + (spam ? 'spamPoints' : key + '-points') + '" value="' + esc(rule?.points ?? 0) + '"></label></div>' + list + '</div></dialog></article>'
  }).join('')
  return '<section class="card settings-section"><h3>AutoMod Rules</h3><p>Choose what Blackridge detects and how it responds. Text and attachment rules require Message Content access.</p><div class="automod-grid">' + cards + '</div></section>' +
    '<section class="card settings-section"><h3>Timing</h3><p>The detection window applies to message rate and repeat rules. Timeout duration also applies to point escalation.</p><div class="fields">' +
    durationField('window','Detection window',config.window,2,60,'seconds') + durationField('timeoutMinutes','Timeout duration',config.timeoutMinutes,1,1440,'minutes') + '</div></section>' +
    '<section class="card settings-section"><h3>Point Escalation</h3><p>When a member reaches a threshold within its time window, Blackridge applies the highest matching rule.</p><div class="settings-panels stack" id="point-rules">' +
    (config.pointRules ?? []).map(pointRule).join('') + '</div><button type="button" class="button small stack" id="add-point-rule">Add Points Rule</button></section>'
}
function wireAutomodRules(form) {
  for (const card of form.querySelectorAll('[data-automod-rule]')) {
    const key = card.dataset.automodRule
    const enabled = form.elements[key + '-enabled']
    const action = form.elements[key === 'spam' ? 'action' : key + '-action']
    const dialog = card.querySelector('dialog')
    card.querySelector('[data-edit-rule]').onclick = () => dialog.showModal()
    card.querySelector('[data-close-rule]').onclick = () => dialog.close()
    const update = () => {
      const response = form.elements[key + '-response'].value
      action.value = enabled.checked || key === 'spam' ? response : 'off'
      card.querySelector('[data-rule-summary]').textContent = enabled.checked ? automodActions[response][0] : 'Disabled'
    }
    card.addEventListener('change',event => {
      if (event.target === enabled || event.target.name === key + '-response') update()
    })
  }
}
function extraControls(section,config,paid) {
  if (section === 'automod') return automodControls(config,paid)
  if (section === 'checkpoint') {
    const rows = (config.rules ?? []).map(rule => checkpointRule(rule.score,rule.action)).join('')
    const botRules = ['verifiedBot','unverifiedBot'].map(key => {
      const rule = config[key] ?? {action:'off',quarantine:false}
      return '<article class="filter-card"><h3>' + (key === 'verifiedBot' ? 'Verified Bot Addition' : 'Unverified Bot Addition') + '</h3><div class="fields"><label>Response<select name="' + key + '-action">' + options({off:'Disabled',kick:'Kick Bot',ban:'Ban Bot'},rule.action,true) + '</select></label></div><label class="toggle"><input type="checkbox" name="' + key + '-quarantine"' + (rule.quarantine ? ' checked' : '') + '> Quarantine the Inviter</label></article>'
    }).join('')
    return '<section class="card settings-section"><h3>Risk Score Rules</h3><p>The highest matching threshold wins. Without rules, the minimum score controls logging and alerts.</p><div class="grid filter-grid" id="checkpoint-rules">' + rows + '</div><button type="button" class="button small stack" id="add-checkpoint-rule">Add Rule</button></section><section class="card settings-section"><h3>Bot Addition Rules</h3><p>Quarantining the inviter uses the quarantine role configured in Anti-Nuke.</p><div class="grid filter-grid">' + botRules + '</div></section>'
  }
  return ''
}
function pointRule(rule = {points:5,hours:24,action:'timeout'}) {
  return '<article class="filter-card point-rule"><div class="module-head"><h3>Escalation rule</h3><button type="button" class="button small remove-point-rule">Remove</button></div><div class="fields"><label>Points<input name="rule-points" type="number" min="1" max="1000" required value="' + esc(rule.points) + '"></label>' + durationField('rule-hours','Within',rule.hours,1,168,'hours') + '<label>Response<select name="rule-action">' + options({timeout:'Timeout',kick:'Kick',ban:'Ban'},rule.action,true) + '</select></label></div></article>'
}
function checkpointRule(score,action = 'log') {
  return '<article class="filter-card checkpoint-rule"><div class="module-head"><h3>Risk rule</h3><button type="button" class="button small remove-rule">Remove</button></div><div class="fields"><label>Minimum score<input type="number" min="1" max="25" required name="score" value="' + esc(score) + '"></label><label>Response<select name="rule">' + options({log:'Log and alert',kick:'Kick',quarantine:'Quarantine',tempban:'Temporary ban'},action,true) + '</select></label></div></article>'
}
function protectionControls(form, section, config, paid) {
  const alerts = form.querySelector('.discord-alerts')
  const insert = html => (alerts ?? form.querySelector('fieldset')).insertAdjacentHTML(alerts ? 'beforebegin' : 'beforeend',html)
  insert(extraControls(section,config,paid))
  if (section === 'automod') {
    wireAutomodRules(form)
    const list = form.querySelector('#point-rules')
    const add = form.querySelector('#add-point-rule')
    const changed = () => { add.disabled = list.children.length >= 4; form.dispatchEvent(new Event('change')) }
    add.disabled = list.children.length >= 4
    add.onclick = () => { if (list.children.length < 4) { list.insertAdjacentHTML('beforeend',pointRule()); changed() } }
    list.onclick = event => { if (event.target.matches('.remove-point-rule')) { event.target.closest('.point-rule').remove(); changed(); add.focus() } }
  }
  if (section === 'checkpoint') {
    const list = form.querySelector('#checkpoint-rules')
    const add = form.querySelector('#add-checkpoint-rule')
    const refresh = () => { add.disabled = list.children.length >= 4 }
    add.onclick = () => { if (list.children.length < 4) list.insertAdjacentHTML('beforeend',checkpointRule(config.threshold)); refresh(); form.dispatchEvent(new Event('change')) }
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
    const input = form.elements.window
    input.value = displayDuration(10,input.closest('[data-duration]').querySelector('select').value)
    validateDuration(input)
  }
  for (const key of ['threshold','window']) form.elements[key].oninput = () => { preset.value = '0' }
}
const alerts = [['alertChannel','Discord Logging Channel'],['alertRoles','Roles to Notify']]
const timedResponses = [['tempBanMinutes','Temporary ban duration',1,1440,'minutes'],['quarantineMinutes','Quarantine duration',1,1440,'minutes']]
const settingFields = {
  nuke: [['threshold','Default Actions Per Actor',2,30],['window','Detection window',5,120,'seconds'],['trusted','Trusted Discord user IDs (comma-separated)'],...alerts,...timedResponses],
  raid: [['threshold','Joins to trigger',3,100],['window','Detection window',5,120,'seconds'],['duration','Protection duration',15,600,'seconds'],['age','Maximum account age (0 for all)',0,365,'days'],['timeoutMinutes','Timeout duration',1,1440,'minutes'],...alerts,...timedResponses],
  checkpoint: [['age','Young account threshold',1,365,'days'],['agePoints','Points for a young account',0,5],['avatarPoints','Points for a default avatar',0,5],['rejoinPoints','Points for 3 joins in an hour',0,5],['similarPoints','Points for a burst of similar accounts',0,5],['inviteNamePoints','Points for invite links in display names',0,5],['threshold','Minimum score to log and alert',1,25],...timedResponses,...alerts],
  automod: [['threshold','Messages per member',3,30],['window','Detection window',2,60,'seconds'],['timeoutMinutes','Timeout duration',1,1440,'minutes'],...alerts,['spamPoints','Points per spam violation',0,100]]
}
const actionsByKind = {
  nuke:['log','strip','quarantine','kick','ban','tempban'],
  raid:['log','timeout','quarantine','kick','ban','tempban']
}
const actionLabels = {log:'Log only',timeout:'Time out',strip:'Remove dangerous roles',quarantine:'Quarantine',kick:'Kick',ban:'Ban',tempban:'Temporary ban'}
const commandNames = ['ban','tempban','unban','kick','timeout','warn','lock-channel','unlock-channel','purge','history','force-verify','info']
const ids = value => value.split(',').map(id => id.trim()).filter(Boolean)

const bypassLabels = {automod:'Auto Moderation',nuke:'Anti-Nuke',raid:'Anti-Raid',checkpoint:'Checkpoint'}
function permitCard(entry,roles) {
  const choices = (name,labels,selected) => Object.entries(labels).map(([id,label]) =>
    '<label class="toggle"><input type="checkbox" name="' + name + '" value="' + esc(id) + '"' + (selected.includes(id) ? ' checked' : '') + '> ' + esc(label) + '</label>'
  ).join('')
  const commands = Object.fromEntries(commandNames.map(name => [name,'/' + name]))
  return '<details class="card permit-card"><summary>' + esc(entry.name) + '</summary>' +
    '<section class="permit-section"><h3>Permit Name</h3><div class="fields"><label>Display name<input name="permit-name" maxlength="60" required value="' + esc(entry.name) + '"></label></div></section>' +
    '<section class="permit-section"><h3>Permit Access</h3><div class="fields"><label>Discord user IDs<input name="permit-users" data-commit-on-change maxlength="330" value="' + esc(entry.users.join(', ')) + '" placeholder="Comma-separated user IDs"></label><div class="discord-field"><span>Discord roles</span>' + discordSelect('permit-roles',roles,entry.roles,true) + '</div></div></section>' +
    '<section class="permit-section"><h3>Permit Command Access</h3><div class="permit-choices">' + choices('permit-commands',commands,entry.commands) + '</div></section>' +
    '<section class="permit-section"><h3>Management Access</h3><div class="permit-choices permit-management"><label class="toggle"><input type="checkbox" name="appeals-manager"' + (entry.appealsManager ? ' checked' : '') + '> Ban Appeals Manager</label><label class="toggle"><input type="checkbox" name="dashboard-access"' + (entry.dashboardAccess ? ' checked' : '') + '> Dashboard Access</label></div><p>Dashboard access is read-only unless another permit grants an action. Premium and Custom Bot are owner only.</p></section>' +
    '<section class="permit-section"><h3>Permit Bypass</h3><div class="permit-choices">' + choices('permit-bypasses',bypassLabels,entry.bypasses) + '</div></section>' +
    '<button type="button" class="button small remove-permit">Remove Permit</button></details>'
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
    list.lastElementChild.open = true
    const name = list.lastElementChild.querySelector('[name=permit-name]')
    name.focus()
    name.select()
    refresh()
    form.dispatchEvent(new Event('change'))
  }
  list.addEventListener('input',event => {
    if (event.target.name === 'permit-name') event.target.closest('.permit-card').querySelector('summary').textContent = event.target.value.trim() || 'New Permit'
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
      bypasses:selected('permit-bypasses'),
      appealsManager:card.querySelector('[name=appeals-manager]').checked,
      dashboardAccess:card.querySelector('[name=dashboard-access]').checked
    }
  })}
}

async function accountMenu(me) {
  if (!me?.user && account.tagName !== 'DETAILS') return
  if (account.tagName !== 'DETAILS') {
  const avatar = me.user.avatar ? '<img alt="" src="https://cdn.discordapp.com/avatars/' + esc(me.user.id) + '/' + esc(me.user.avatar) + '.png?size=64">' : '<span class="initial">' + esc(me.user.username.slice(0,1)) + '</span>'
  account.outerHTML = '<details class="account-menu"><summary class="button small">' + avatar + '<span>' + esc(me.user.username) + '</span></summary><div class="account-links">' + '<button type="button" id="sign-out">Log Out</button><a href="/premium">Premium</a><a href="/support">Support Server</a></div></details>'
  }
  const menu = document.querySelector('.account-menu')
  if (menu.dataset.wired) return
  menu.dataset.wired = 'true'
  document.addEventListener('click',event => { if (!menu.contains(event.target)) menu.open = false })
  menu.addEventListener('keydown',event => {
    if (event.key !== 'Escape' || !menu.open) return
    menu.open = false
    menu.querySelector('summary').focus()
  })
  document.querySelector('#sign-out').onclick = async () => {
    try {
      await Promise.all([...pendingSettings].map(flush => flush()))
      await request('/auth/logout',{method:'POST'})
      location.assign(base)
    }
    catch (error) { alert(error.message) }
  }
}
async function premium(me) {
  const [guilds,billing] = me?.user ? await Promise.all([
    request('/api/guilds').then(data => data.guilds).catch(() => []),
    request('/api/billing').catch(() => ({}))
  ]) : [[],{}]
  const servers = guilds.filter(guild => guild.owner && guild.installed)
  const picker = servers.length ? '<section class="stack billing-panel"><h3>Choose a Server</h3><div class="servers premium-servers">' +
    servers.map(guild => '<a class="card premium-server" href="/dashboard/' + encodeURIComponent(guild.id) + '/premium"><span class="server-avatar">' +
      (guild.icon ? '<img alt="" src="https://cdn.discordapp.com/icons/' + encodeURIComponent(guild.id) + '/' + encodeURIComponent(guild.icon) + '.png?size=64">' : esc(guild.name.slice(0,2).toUpperCase())) +
      '</span><span><strong>' + esc(guild.name) + '</strong><small>' + (guild.plan === 'free' ? 'Free' : planName(guild.plan)) + '</small></span><span class="premium-server-arrow" aria-hidden="true">›</span></a>').join('') +
    '</div></section>' : '<p class="stack"><a class="button" href="/dashboard">' + (me?.user ? 'Open Dashboard' : 'Sign In to Subscribe') + '</a></p>'
  const subscriptions = billing.subscriptions?.length ? '<section class="card stack billing-panel"><h3>Your Subscriptions</h3>' +
    billing.subscriptions.map(row => '<div class="actions stack"><span>' + esc(row.name) + ' · ' + planName(row.plan) +
      '</span><button type="button" class="button small" data-portal="manage" data-guild="' + esc(row.guild) + '"' + (billing.enabled ? '' : ' disabled') + '>Manage Billing</button></div>').join('') + '</section>' : ''
  shell('<h2>Blackridge Premium</h2>' + premiumPlans(guilds.map(guild => guild.plan)) + picker + subscriptions + '<p id="billing-status" role="status"></p>')
  wireBilling()
}
const planName = plan => plan === 'custom' ? 'Custom Bot' : 'Premium'
function premiumPlans(plans,billing = {}) {
  const features = ['Advanced Auto Moderation','Advanced Anti-Nuke','Server Backups']
  return '<div class="grid pricing">' + [
    ['premium','blue','$2.99',features],
    ['custom','custom','$4.99',[...features,'Custom Bot']]
  ].map(([plan,theme,price,items]) => {
    const purchase = billing.enabled && billing.purchasable ? '<button class="button plan-purchase" type="button" data-checkout="' + plan + '">Subscribe</button>' : ''
    const upgrade = billing.enabled && plan === 'custom' && billing.subscription?.plan === 'premium' && billing.subscription.status === 'active' && !billing.subscription.review
      ? '<button class="button plan-purchase" type="button" data-portal="upgrade">Upgrade to Custom Bot</button>' : ''
    return '<article class="card plan plan-' + theme + '"><span class="icon-tile">' + icon('premium') + '</span><h3>Blackridge ' + planName(plan) + '</h3><strong>' + price + '<small> / month</small></strong><ul>' +
      items.map(item => '<li>' + item + '</li>').join('') + '</ul>' + purchase + upgrade +
      (plans.includes(plan) ? '<span class="badge">Your Current Active Plan</span>' : '') + '</article>'
  }).join('') + '</div>'
}
function serverBilling(plan,billing) {
  const sub = billing.subscription
  const date = value => esc(new Date(value).toLocaleDateString())
  const processing = new URLSearchParams(location.search).get('billing') === 'processing' && plan === 'free'
  let message = billing.enabled ? '' : 'Subscription billing is currently unavailable.'
  if (processing) message = 'Stripe is confirming your payment. Refresh this page shortly to check your plan.'
  else if (sub?.review) message = 'Access is on hold due to a payment issue. Contact Blackridge Support for help.'
  else if (sub?.cancelAt) message = 'Your plan is scheduled to end on ' + date(sub.cancelAt) + '.'
  else if (sub?.status === 'past_due') message = 'A payment is overdue. Use Manage Billing to update your payment method.'
  else if (sub && plan === 'free') message = 'Payment confirmation is pending.'
  const manage = sub && billing.enabled ? '<section class="card stack billing-panel"><h3>Subscription Management</h3><div class="actions"><button type="button" class="button" data-portal="manage">Manage Billing</button>' +
    (!sub.cancelAt ? '<button type="button" class="button" data-portal="cancel">Cancel Plan</button>' : '') + '</div></section>' : ''
  const transfer = sub && billing.enabled && Array.isArray(billing.targets) && billing.remaining !== undefined ? '<section class="card stack billing-panel"><h3>Transfer Subscription</h3><p>' +
    billing.remaining + ' of 3 transfers remaining this calendar month (UTC). Only the subscription moves.</p>' +
    (billing.targets.length ? '<form id="billing-transfer"><div class="fields"><label>Destination Server<select name="target" required><option value="">Select a server</option>' +
      billing.targets.map(guild => '<option value="' + esc(guild.id) + '">' + esc(guild.name) + '</option>').join('') +
      '</select></label></div><button class="button" type="submit">Transfer Plan</button></form>' : '<p>No eligible destination servers are available.</p>') + '</section>' : ''
  return premiumPlans([plan],billing) + (message ? '<p class="stack">' + message + '</p>' : '') + manage + transfer + '<p id="billing-status" role="status"></p>'
}
function wireBilling(path,guild) {
  const status = document.querySelector('#billing-status')
  const send = (url,body) => request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  const run = async (button,operation) => {
    button.disabled = true
    status.textContent = ''
    try { await operation() } catch (error) { status.textContent = error.message }
    finally { button.disabled = false }
  }
  for (const button of document.querySelectorAll('[data-checkout],[data-portal]')) button.onclick = () => run(button,async () => {
    const result = button.dataset.checkout ? await send(path+'/billing/checkout',{plan:button.dataset.checkout})
      : await send('/api/billing/'+encodeURIComponent(button.dataset.guild ?? guild)+'/portal',{action:button.dataset.portal})
    location.assign(result.url)
  })
  const transfer = document.querySelector('#billing-transfer')
  if (transfer) transfer.onsubmit = event => {
    event.preventDefault()
    const target = transfer.elements.target
    if (!confirm('Transfer this plan to ' + target.selectedOptions[0].text + '? Paid features will move immediately.')) return
    void run(event.submitter,async () => {
      await send(path+'/billing/transfer',{target:target.value})
      location.assign('/dashboard/'+encodeURIComponent(target.value)+'/premium')
    })
  }
}
function planLock(title,description,href) {
  return '<section class="card stack plan-lock"><h3>' + title + crown + '</h3><p>' + description + '</p><a class="button small" href="' + href + '">View Plans</a></section>'
}
async function customBotPanel(path) {
  const panel = document.querySelector('#custom-bot-panel')
  const url = path + '/custom-bot'
  function render(state) {
    const profile = state.profile ?? {}
    panel.innerHTML = '<form class="card stack" id="bot-connection"><h3>Connect Your Discord Bot</h3><p>Enable Presence Intent, Server Members Intent, and Message Content Intent on the Bot page of the Discord Developer Portal. Check the token below to unlock the install link. Install your bot in this server only and keep Blackridge installed for dashboard access. <a href="/documentation#custom-bot-setup">Setup Guide</a></p><p class="badge">' +
      (state.connected ? 'Connected' : state.configured ? 'Reconnecting' : 'Disconnected') + '</p><div class="fields"><label>Discord Bot Token<input type="password" name="token" required autocomplete="off" spellcheck="false" maxlength="162"></label></div><div class="actions"><button type="button" class="button" id="check-bot">Check Intents</button><a class="button" id="install-bot" target="_blank" rel="noopener noreferrer" hidden>Add to Discord</a><button class="button primary" id="connect-bot" disabled>Connect Bot</button>' +
      (state.configured ? '<button type="button" class="button" id="disconnect-bot">Disconnect Bot</button>' : '') + '</div></form>' +
      (state.connected ? '<section class="card stack custom-profile"><form id="bot-profile"><h3>Profile</h3><div class="fields"><label>Bot Username<input name="username" required minlength="2" maxlength="32" value="' + esc(state.username) + '"></label>' +
        '<label>Status<select name="status">' + options({online:'Online',idle:'Idle',dnd:'Do Not Disturb',invisible:'Invisible'},profile.status ?? 'online') + '</select></label>' +
        '<label>Activity Type<select name="activityType">' + options({none:'Disabled',playing:'Playing',listening:'Listening',watching:'Watching',competing:'Competing'},profile.activityType ?? 'none') + '</select></label>' +
        '<label>Activity Text<input name="activity" maxlength="100" value="' + esc(profile.activity ?? '') + '"></label><label>Bio<textarea name="bio" maxlength="400" rows="4">' + esc(state.bio) + '</textarea></label></div><div class="fields stack"><label>Change Avatar<input type="file" name="avatar" accept="image/png,image/jpeg,image/webp"></label><label>Change Banner<input type="file" name="banner" accept="image/png,image/jpeg,image/webp"></label></div><p>PNG, JPEG, or WebP up to 3 MB. Verification panels posted by Blackridge should be republished after switching bots.</p><button class="button primary">Save Profile</button></form>' +
        '<aside class="custom-preview"><div class="custom-banner">' + (state.banner ? '<img alt="" src="' + esc(state.banner) + '">' : '') + '</div><div class="custom-preview-body"><div class="custom-preview-avatar"><img alt="" src="' + esc(state.avatar || '/icon.png') + '"><span class="presence-dot presence-' + esc(profile.status ?? 'online') + '"></span></div><h3><span data-profile-name>' + esc(state.username) + '</span> <small class="app-badge">APP</small></h3><p data-profile-status>' + ({online:'Online',idle:'Idle',dnd:'Do Not Disturb',invisible:'Invisible'}[profile.status] ?? 'Online') + '</p><div class="custom-preview-bio"><strong>Bio</strong><p data-profile-bio>' + esc(state.bio || 'No bio set.') + '</p></div></div></aside></section>' : '') +
      '<p id="custom-status" role="status"></p>'
    const action = async (button,run,message) => {
      const status = panel.querySelector('#custom-status')
      button.disabled = true
      try { render(await run()); panel.querySelector('#custom-status').textContent = message }
      catch (error) { status.textContent = error.message }
      finally { button.disabled = false }
    }
    const json = (method,body) => ({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    const connection = panel.querySelector('#bot-connection')
    const tokenField = connection.elements.token
    const checkButton = panel.querySelector('#check-bot')
    const install = panel.querySelector('#install-bot')
    const connect = panel.querySelector('#connect-bot')
    const status = panel.querySelector('#custom-status')
    let inputVersion = 0
    function resetCheck() {
      inputVersion++
      install.hidden = true
      install.removeAttribute('href')
      connect.disabled = true
      status.textContent = ''
    }
    tokenField.oninput = resetCheck
    checkButton.onclick = async () => {
      if (!tokenField.reportValidity()) return
      resetCheck()
      const version = inputVersion
      checkButton.disabled = true
      try {
        const result = await request(url+'/check',json('POST',{token:tokenField.value}))
        if (version !== inputVersion) return
        if (!result.installUrl) {
          status.textContent = 'Enable these intents in Discord: ' + result.missingIntents.join(', ') + '.'
          return
        }
        install.href = result.installUrl
        install.hidden = false
        connect.disabled = false
        status.textContent = 'All three intents are enabled. Add the bot to Discord, then select Connect Bot.'
      } catch (error) {
        if (version === inputVersion) status.textContent = error.message
      } finally { checkButton.disabled = false }
    }
    connection.onsubmit = async event => {
      event.preventDefault()
      if (connect.disabled) return
      tokenField.disabled = checkButton.disabled = connect.disabled = true
      try {
        const next = await request(url,json('POST',{token:tokenField.value}))
        render(next)
        panel.querySelector('#custom-status').textContent = 'Custom Bot connected.'
      } catch (error) { status.textContent = error.message }
      finally { tokenField.disabled = checkButton.disabled = connect.disabled = false }
    }
    const disconnect = panel.querySelector('#disconnect-bot')
    if (disconnect) disconnect.onclick = () => {
      if (!confirm('Disconnect this bot and switch back to Blackridge?')) return
      void action(disconnect,async () => { await request(url+'/disconnect',{method:'POST'}); return {} },'Custom Bot disconnected.')
    }
    const form = panel.querySelector('#bot-profile')
    form?.addEventListener('input',() => {
      const {username,status,bio} = form.elements
      panel.querySelector('[data-profile-name]').textContent = username.value || state.username
      panel.querySelector('[data-profile-status]').textContent = status.selectedOptions[0].text
      panel.querySelector('.presence-dot').className = 'presence-dot presence-' + status.value
      panel.querySelector('[data-profile-bio]').textContent = bio.value || 'No bio set.'
    })
    if (form) form.onsubmit = event => {
      event.preventDefault()
      const fields = new FormData(form)
      void action(event.submitter,async () => {
        const images = ['avatar','banner'].flatMap(field => {
          const file = fields.get(field)
          if (!file.size) return []
          if (file.size > 3*1024*1024 || !['image/png','image/jpeg','image/webp'].includes(file.type))
            throw new Error('Choose a PNG, JPEG, or WebP image up to 3 MB.')
          return [[field,file]]
        })
        const body = Object.fromEntries(['username','status','activityType','activity','bio'].map(key => [key,fields.get(key)]))
        let next = await request(url+'/profile',json('PUT',body))
        for (const [field,file] of images) next = await request(url+'/image/'+field,{method:'PUT',headers:{'Content-Type':file.type},body:file})
        return next
      },'Profile updated.')
    }
  }
  try { render(await request(url)) }
  catch (error) { panel.textContent = error.message }
}
function form(kind, config, owner) {
  const disabled = owner ? '' : ' disabled'
  const fields = group => group.map(([key,label,min,max,unit]) => unit ? durationField(key,label,config[key],min,max,unit) : '<label>' + label + '<input name="' + key + '" value="' + esc(Array.isArray(config[key]) ? config[key].join(', ') : config[key]) + '"' + (min === undefined ? ' maxlength="500"' : ' type="number" required min="' + min + '" max="' + max + '"') + '></label>').join('')
  const response = actionsByKind[kind] ? '<label>Response<select name="action">' + options(Object.fromEntries(actionsByKind[kind].map(action => [action,actionLabels[action]])),config.action,true) + '</select></label>' : ''
  const alertFields = settingFields[kind].filter(([key]) => key.startsWith('alert'))
  const baseFields = settingFields[kind].filter(([key]) => !key.startsWith('alert'))
  return '<form id="settings"><fieldset class="settings-panels"' + disabled + '>' + (kind === 'automod' ? '' : '<section class="card settings-section"><h3>' + sections[kind] + ' Policy' + '</h3><p>' + (owner ? (kind === 'nuke' ? 'The default threshold applies to monitored actions without a per-action limit. Individual rules can override it.' : 'Set detection thresholds and how Blackridge responds.') : 'Only the server owner can change this policy.') + '</p><div class="fields">' + fields(baseFields) + response + '</div></section>') + (alertFields.length ? '<section class="card settings-section discord-alerts"><h3>Discord Alerts</h3><div class="fields">' + fields(alertFields) + '</div></section>' : '') + '</fieldset><p role="status" id="notice"></p></form>'
}
function wireResponseDurations(form,section) {
  const refresh = () => {
    const actions = new Set([form.elements.action?.value])
    if (section === 'nuke') for (const row of form.querySelectorAll('[data-nuke]')) {
      const key = row.dataset.nuke
      if (form.elements[key+'-enabled'].checked) {
        actions.add(form.elements[key+'-action'].value)
        if (Number(form.elements[key+'-escalate'].value)) actions.add(form.elements[key+'-escalateTo'].value)
      }
    }
    if (section === 'checkpoint') {
      for (const rule of form.querySelectorAll('select[name=rule]')) actions.add(rule.value)
      if (form.querySelector('input[name$="-quarantine"]:checked')) actions.add('quarantine')
    }
    if (section === 'automod') {
      if (!form.elements['spam-enabled'].checked) actions.delete(form.elements.action.value)
      if (Object.keys(filters).some(key => form.elements[key + '-action'].value === 'timeout') ||
          [...form.querySelectorAll('.point-rule select[name="rule-action"]')].some(select => select.value === 'timeout')) actions.add('timeout')
    }
    for (const [key,response] of Object.entries({timeoutMinutes:'timeout',tempBanMinutes:'tempban',quarantineMinutes:'quarantine'})) {
      const input = form.elements[key]
      if (!input) continue
      const field = input.closest('[data-duration]')
      field.hidden = input.disabled = !actions.has(response)
      field.querySelector('select').disabled = input.disabled
    }
  }
  form.addEventListener('change',refresh)
  refresh()
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
      (history ? '<form class="card stack" data-operation="restore"><h3>Backup Manager</h3><p>Restore supported settings and recreate eligible deleted roles and channels. Messages, role memberships, member overwrites, and ordering require manual recovery.</p><div class="fields"><label>Backup<select name="id">' + history + '</select></label></div><div class="actions"><button class="button" type="button" data-backup-preview>View Backup</button><button class="button primary">Restore Backup</button></div></form>' : '<section class="card stack"><h3>Backup Manager</h3><p>No backups yet.</p></section>')
  }
  const logging = '<form class="card stack" data-operation="logging"><h3>Discord Logging</h3><div class="fields"><div class="discord-field"><span>Logging Channel</span>' + channel + '</div></div></form>'
  const deleteInvites = section === 'lockdown' ? '<form class="card stack" data-operation="delete-invites"><h3>Invite Cleanup</h3><p>Enable the Lockdown module to revoke standard server invites. Lifting Lockdown cannot restore these links.</p><button class="button lockdown-submit"' + (data.config.lockdown.enabled ? '' : ' disabled') + '>Delete All Invites</button></form>' : ''
  panel.innerHTML = controls + deleteInvites + (section === 'backup' ? '' : logging) + '<p class="stack" role="status"></p>'
  const status = panel.querySelector('[role="status"]')
  const preview = panel.querySelector('[data-backup-preview]')
  if (preview) preview.onclick = async () => {
    preview.disabled = true
    try {
      const id = preview.form.elements.id.value
      const {snapshot} = await request(path+'/recovery/backup/'+encodeURIComponent(id))
      const dialog = document.createElement('dialog')
      dialog.className = 'nuke-dialog backup-preview'
      const settingsLabels = {name:'Server Name',verificationLevel:'Verification Level',defaultMessageNotifications:'Default Notifications',explicitContentFilter:'Explicit Content Filter'}
      const list = entries => entries.length ? '<ul>' + entries.join('') + '</ul>' : '<p>None recorded.</p>'
      dialog.innerHTML = '<header><h3>Backup Preview</h3><form method="dialog"><button class="button small" aria-label="Close backup preview">Close</button></form></header><div class="nuke-dialog-fields"><p>Blackridge restores supported settings and eligible objects. Discord permissions and role hierarchy can limit restoration.</p><h4>Server Settings</h4>' +
        list(Object.entries(snapshot.settings).map(([key,value]) => '<li>' + esc(settingsLabels[key] ?? key) + ' · ' + esc(value) + '</li>')) +
        '<h4>Roles</h4>' + list(snapshot.roles.filter(role => !role.managed && role.id !== path.split('/').at(-1)).map(role => '<li>' + esc(role.name) + ' · Permission flags <code>' + esc(role.permissions) + '</code></li>')) +
        '<h4>Channels and Categories</h4>' + list(snapshot.channels.map(channel => '<li>' + esc(channel.name) + ' · ' + ({0:'Text',2:'Voice',4:'Category',5:'Announcement',13:'Stage',15:'Forum',16:'Media'}[channel.type] ?? 'Channel') + ' · ' + channel.overwrites.filter(item => item.type === 0).length + ' role overwrites</li>')) +
        '<p>Messages, role memberships, member overwrites, and ordering require manual recovery.</p></div>'
      dialog.addEventListener('close',() => dialog.remove(),{once:true})
      document.body.append(dialog)
      dialog.showModal()
    } catch (error) { status.textContent = error.message }
    finally { preview.disabled = false }
  }
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
    if (operation === 'delete-invites') {
      if (!window.confirm('Permanently delete all standard server invites? Existing links will stop working.')) return
      payload.confirm = 'DELETE ALL INVITES'
    }
    if (operation === 'restore') {
      if (!window.confirm('Confirm you want to restore this backup?')) return
      payload.id = Number(payload.id)
      payload.confirm = 'RESTORE BACKUP'
    }
    const button = form.querySelector('button')
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
  const open = async () => {
    const button = panel.querySelector('button')
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
  panel.querySelector('button').onclick = open
  void open()
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
      renderServerPicker(guilds,me.user.id)
      return
    }
    const path = '/api/guilds/' + encodeURIComponent(id)
    const data = await request(path)
    if ((['permits','premium','custom'].includes(section) && !data.owner) || (section === 'appeals' && !data.appealsManager)) throw new Error('You do not have access to this page.')
    const paid = data.plan === 'premium' || data.plan === 'custom'
    const customAllowed = data.owner && data.plan === 'custom'
    const backupLocked = section === 'backup' && !paid
    const recoverySection = !backupLocked && ['lockdown','backup','moderation'].includes(section)
    const needsOptions = (section === 'appeals' && data.owner) || Object.hasOwn(settingFields,section) || ['permits','verification'].includes(section) || (recoverySection && data.owner)
    const [choices,recoveryState,eventData] = await Promise.all([
      needsOptions ? request(path + '/options') : null,
      recoverySection && data.owner && section !== 'moderation' ? request(path + '/recovery') : {},
      ['logs','moderation'].includes(section) ? request(path + '/events' + (section === 'moderation' ? '?kind=moderation' : '')) : {events:[]}
    ])
    const billing = section === 'premium' ? await request(path + '/billing') : null
    const linkedSwitch = Object.hasOwn(settingFields,section) || ['permits','verification'].includes(section)
    const serviceSwitch = !backupLocked && ['backup','moderation','lockdown'].includes(section)
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
    const modules = ['nuke','raid','checkpoint','automod','lockdown','moderation','backup','permits','appeals','verification','custom'].map(key => {
      const restricted = ['permits','custom'].includes(key) && !data.owner ? 'Owner only' : key === 'appeals' && !data.appealsManager ? 'Manager access required' : ''
      const enabled = key === 'appeals' ? data.appealsConfigured : key === 'custom' ? data.customConnected : data.config[key]?.enabled
      const state = enabled ? '<i class="dot"></i> Enabled' : '<i class="dot disabled-dot"></i> Disabled'
      return '<article class="card compact-module' + (key === 'verification' ? ' module-wide' : '') + '"><div class="module-head"><span class="icon-tile">' + icon(key) + '</span><div><h3>' + sections[key] + (key === 'backup' ? crown : '') + '</h3><span class="badge">' + state + '</span></div></div>' + (restricted ? '<span class="button module-configure" aria-disabled="true">' + restricted + '</span>' : '<a class="button module-configure" href="' + serverPath + '/' + key + '" aria-label="Configure ' + sections[key] + '">' + icon('configure') + ' Configure</a>') + '</article>'
    }).join('')
    const overview = securityScore(data.security) + '<section class="module-section"><div class="module-grid">' + modules + '</div></section>'
    document.body.classList.add('has-workspace')
    shell('<div class="dash-layout"><nav class="sidebar" aria-label="Server navigation"><a class="server-switch" title="Switch server" href="' + base + '">' + (data.icon ? '<img class="switch-avatar" src="https://cdn.discordapp.com/icons/' + encodeURIComponent(id) + '/' + encodeURIComponent(data.icon) + '.png?size=64" alt="">' : icon('server')) + '<span>' + esc(data.name) + '</span></a>' + navigation('overview') + (data.owner ? navigation('premium') + navigation('custom') : '') + navigation('logs') + '<span class="nav-label">Protection</span>' + navigation('raid') + navigation('nuke') + navigation('lockdown') + navigation('verification') + navigation('checkpoint') + '<span class="nav-label">Administration</span>' + (data.owner ? navigation('permits') : '') + navigation('moderation') + (data.appealsManager ? navigation('appeals') : '') + navigation('backup') + navigation('automod') + '</nav><div class="dash-pane"><div class="dash-main">' + heading + (section === 'overview' ? overview : section === 'premium' ? serverBilling(data.plan,billing) : section === 'custom' ? (customAllowed ? '<div id="custom-bot-panel"></div>' : planLock('Custom Bot','The server owner can connect a bot with the Custom Bot plan.',serverPath + '/premium')) : backupLocked ? planLock('Server Backups','Create, schedule, and restore backups with Premium or Custom Bot.',serverPath + '/premium') : section === 'logs' ? activity : section === 'appeals' ? '<div id="appeals-panel"></div>' : section === 'permits' ? permitsForm(data.config.permits,choices.roles) : ['lockdown','backup'].includes(section) ? '<div id="recovery"></div>' : section === 'moderation' ? '<section class="card"><h3>Slash Commands</h3><p>' + commandNames.map(name => '/' + name).join(' · ') + '</p><h3 class="stack">Recent Cases</h3>' + logList(events.filter(event => event.kind === 'moderation').slice(0,5),true) + '</section><div id="recovery"></div>' : section === 'verification' ? verificationForm(data.config.verification,data.owner,choices) : form(section,data.config[section],data.owner)) + '<p id="refresh" role="status"></p></div></div></div>')
    if (section === 'premium') wireBilling(path,id)
    if (section === 'appeals') appealsPanel(path,data.config.appeals,choices?.channels ?? [])
    if (section === 'custom' && customAllowed) void customBotPanel(path)
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
      const cleanup = document.querySelector('[data-operation="delete-invites"] button')
      if (cleanup) cleanup.disabled = !enabled
    })
    if (settings?.elements.alertChannel && section !== 'verification') wireDiscordSelectors(settings,choices)
    if (section === 'permits') wirePermits(settings,choices.roles)
    if (settings && settingFields[section]) protectionControls(settings,section,data.config[section],paid)
    if (settings && section === 'nuke') nukeControls(settings,data.config.nuke,choices,paid)
    if (settings && settingFields[section]) wireResponseDurations(settings,section)
    if (settings && section === 'nuke' && data.owner) setupQuarantine(settings,path)
    if (recoverySection) await recoveryPanel(section,path,data,[choices,recoveryState])
    if (settings && data.owner) autosave(settings,settings.querySelector('#notice'),async () => {
      const fields = new FormData(settings)
      const payload = section === 'permits' ? {...readPermits(settings),enabled:fields.has('enabled')} : {enabled:fields.has('enabled')}
      if (section === 'verification') {
        for (const key of ['mode','channel','verifiedRole','unverifiedRole','alertChannel','failure']) payload[key] = fields.get(key)
        payload.attempts = Number(fields.get('attempts'))
        for (const key of ['minAge','minutes']) payload[key] = readDuration(settings.elements[key])
      }
      if (fields.has('action')) payload.action = fields.get('action')
      if (section === 'automod') payload.filters = Object.fromEntries(Object.keys(filters).map(key => [key,{
        action:fields.get(key + '-action'),response:fields.get(key + '-response') ?? undefined,limit:Number(fields.get(key + '-limit')),points:Number(fields.get(key + '-points'))
      }]))
      if (section === 'automod') {
        payload.spamEnabled = fields.has('spam-enabled')
        for (const name of ['badWords','nsfwDomains','maliciousDomains']) payload[name] = fields.get(name).split(/[\n,]/).map(value => value.trim()).filter(Boolean).join(',')
        payload.pointRules = [...settings.querySelectorAll('.point-rule')].map(row => ({
          points:Number(row.querySelector('[name=rule-points]').value),
          hours:readDuration(row.querySelector('[name=rule-hours]')),
          action:row.querySelector('[name=rule-action]').value
        }))
      }
      if (section === 'checkpoint') {
        payload.rules = fields.getAll('score').map((score,index) => ({score:Number(score),action:fields.getAll('rule')[index]}))
        for (const key of ['verifiedBot','unverifiedBot']) payload[key] = {
          action:fields.get(key + '-action'),quarantine:fields.has(key + '-quarantine')
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
          if (key === 'channelRename') rule.channels = fields.getAll('channelRename-channels')
          if (key === 'roleRename') rule.roles = fields.getAll('roleRename-roles')
          if (key === 'gate') rule.gates = [...row.querySelectorAll('.nuke-gate')].flatMap(gate => {
            const role = gate.querySelector('input[type=radio]:checked')?.value
            const required = [...gate.querySelectorAll('input[name=gate-required]:checked')].map(input => input.value).filter(id => id !== role)
            return role && required.length ? [{role,required}] : []
          })
          payload.guards[key] = rule
        }
      }
      for (const [key,,min,,unit] of (settingFields[section] ?? [])) {
        payload[key] = unit ? (settings.elements[key].disabled ? data.config[section][key] : readDuration(settings.elements[key])) : min === undefined ? fields.get(key) : Number(fields.get(key))
      }
      if (fields.has('alertChannel') && section !== 'verification') {
        payload.alertChannel = payload.alertChannel.trim()
        payload.alertRoles = fields.getAll('alertRoles')
      }
      await request(path + '/' + section,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),keepalive:true})
      Object.assign(data.config[section],payload)
    })
    if (section === 'verification') {
      const mode = settings.elements.mode
      const update = () => { document.querySelector('#captcha-settings').hidden = mode.value !== 'captcha' }
      mode.addEventListener('change',update)
      update()
      const publish = settings.querySelector('#publish-verification')
      if (publish) publish.onclick = async () => {
        const result = settings.querySelector('#verification-publish-result')
        publish.disabled = true
        try {
          if (!settings.reportValidity()) return
          await Promise.all([...pendingSettings].map(flush => flush()))
          if (settings.querySelector('#notice').textContent) throw new Error('Correct the verification settings before publishing.')
          const {url} = await request(path + '/verification-panel',{method:'POST'})
          const link = document.createElement('a')
          link.href = url
          link.textContent = 'Open Verification Panel in Discord'
          result.replaceChildren(link)
        } catch (error) { result.textContent = error.message }
        finally { publish.disabled = false }
      }
    }
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
if (account.tagName === 'DETAILS') void accountMenu(null)
if (location.pathname.startsWith(base)) dashboard()
else {
  if (Object.hasOwn(resources,location.pathname)) shell('<div class="resource-page">' + resources[location.pathname] + '</div>')
  const me = request('/api/me').catch(() => null)
  if (location.pathname === '/premium') void me.then(premium)
  void me.then(data => { if (data) accountMenu(data) })
}

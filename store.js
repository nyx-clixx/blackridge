import { billingStore } from './billing-store.js'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

const integer = (min,max) => z.number().int().min(min).max(max)
const duration = (min,max,secondsPerUnit) => z.number().min(min).max(max).refine(value => {
  const seconds = value * secondsPerUnit
  return Math.abs(seconds - Math.round(seconds)) < 1e-7
}, 'Use a whole number of seconds.')
const nukeAction = z.enum(['log','strip','kick','ban','tempban','quarantine'])
const ruleResponse = {action:nukeAction.optional(),escalateAfter:integer(0,100).optional(),escalateTo:nukeAction.optional()}
const rate = z.strictObject({enabled:z.boolean(),threshold:integer(2,30),window:integer(5,120),
  minute:integer(0,500).optional(),hour:integer(0,500).optional(),...ruleResponse})
const rates = z.strictObject(Object.fromEntries(
  ['moderation','roleCreate','roleDelete','channelCreate','channelDelete','webhookCreate'].map(key => [key,rate.optional()])
))
const snowflake = z.string().regex(/^\d{17,20}$/)
export const premiumGuards = ['channelRename','roleRename','emojiDelete','stickerDelete','soundboardDelete']
export const premiumFilters = ['ghost','malicious']
const customPlans = new Set((process.env.BLACKRIDGE_CUSTOM_BOT_GUILDS ?? '').split(',').map(id => id.trim()).filter(Boolean))
const premiumPlans = new Set((process.env.BLACKRIDGE_PREMIUM_GUILDS ?? '').split(',').map(id => id.trim()).filter(Boolean))
const lifetimeCustomPlans = new Set(['1567348176866902119','1567687590532878467'])
export function guildPlan(id) {
  return lifetimeCustomPlans.has(id) || customPlans.has(id) ? 'custom' : premiumPlans.has(id) ? 'premium' : 'free'
}
const guards = z.strictObject(Object.fromEntries(['identity','gate','publicRoles','rolePermissions','assignments','botAdd',...premiumGuards].map(key => [key,z.strictObject({
  enabled:z.boolean(),...ruleResponse,
  permissions:z.array(z.enum(['Administrator','KickMembers','BanMembers','ManageGuild','ManageRoles','ManageChannels','ManageWebhooks','MentionEveryone'])).max(8).optional(),
  identity:z.array(z.enum(['icon_hash','name','vanity_url_code'])).max(3).optional(),
  onboarding:z.boolean().optional(),
  roles:z.array(snowflake).max(100).optional(),
  channels:z.array(snowflake).max(100).optional(),
  gates:z.array(z.strictObject({role:snowflake,required:z.array(snowflake).min(1).max(15)})).max(100).optional()
}).optional()])))
export const commandNames = ['ban','tempban','unban','kick','timeout','warn','lock-channel','unlock-channel','purge','history','force-verify','info','slowmode']
const principals = z.array(snowflake).max(15)
export const permitBypasses = ['automod','nuke','raid','checkpoint']
const permit = z.strictObject({
  name:z.string().trim().min(1).max(60),
  users:principals,
  roles:principals,
  commands:z.array(z.enum(commandNames)).max(commandNames.length),
  bypasses:z.array(z.enum(permitBypasses)).max(permitBypasses.length),
  appealsManager:z.boolean().optional(),dashboardAccess:z.boolean().optional()
})

export function matchesPermit(permit,userId,guildId,roles) {
  return permit.users.includes(userId) || permit.roles.some(id => id !== guildId && roles?.has(id))
}

function normalizePermits(config) {
  if (Array.isArray(config.entries)) {
    return {enabled:config.enabled ?? true,entries:config.entries.filter(entry =>
      !(entry.name === '/kick' && entry.commands.length === 1 && entry.commands[0] === 'kick' && !entry.bypasses.length && !entry.appealsManager && !entry.dashboardAccess)
    ).map(entry => ({...entry,commands:[...new Set(entry.commands.map(name =>
      name === 'lock' || name === 'unlock' ? name + '-channel' : name
    ))]}))}
  }
  return {enabled:Object.keys(config).length > 0,entries:['ban','tempban','timeout','warn','lock','unlock'].flatMap(command => {
    const entry = config[command]
    if (!entry || !(entry.users.length || entry.roles.length)) return []
    const name = command === 'lock' || command === 'unlock' ? command + '-channel' : command
    return [{name:'/' + name,users:entry.users,roles:entry.roles,commands:[name],bypasses:[]}]
  })}
}
const alerts = {alertChannel:z.union([snowflake,z.literal('')]).optional(),alertRoles:z.array(snowflake).max(5).optional()}
const botRule = z.strictObject({action:z.enum(['off','kick','ban']),quarantine:z.boolean()})
const timedResponse = {tempBanMinutes:duration(1,1440,60).optional(),quarantineMinutes:duration(1,1440,60).optional()}
export const spamFilters = ['mentions','files','images','stickers','invites','links','caps','newlines','length','emoji','headers','duplicate','multiUser','badWords','scam','nsfw','malicious','ghost']
const automodActions = z.array(z.enum(['delete','warn','timeout'])).max(3)
const filter = z.strictObject({actions:automodActions.optional(),action:z.enum(['off','log','delete','warn','timeout']),limit:integer(1,4000),points:integer(0,100).optional(),response:z.enum(['log','delete','warn','timeout']).optional()})
export const policies = {
  appeals:z.strictObject({questions:z.array(z.union([z.string().trim().min(1).max(45),z.strictObject({label:z.string().trim().min(1).max(45),type:z.enum(['paragraph','short','checkbox'])})])).min(1).max(5),channel:z.union([snowflake,z.literal('')]).optional(),alertChannel:z.union([snowflake,z.literal('')]).optional()}),
  reports:z.strictObject({enabled:z.boolean(),channel:z.union([snowflake,z.literal('')]),
    emoji:z.string().trim().max(100).refine(value => !value || /^(?:<a?:\w+:\d{17,20}>|\d{17,20})$/.test(value) ||
      (/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value) &&
        [...new Intl.Segmenter().segment(value)].length === 1))}),
  honeypot:z.strictObject({
    enabled:z.boolean(),channel:z.union([snowflake,z.literal('')]),
    action:z.enum(['delete','warn','timeout','kick','ban']),
    actions:z.array(z.enum(['delete','warn','timeout','kick','ban'])).max(3).optional(),
    timeoutMinutes:duration(1,1440,60),alertChannel:z.union([snowflake,z.literal('')])
  }),
  verification:z.strictObject({
    enabled:z.boolean(),mode:z.enum(['button','captcha']),channel:z.union([snowflake,z.literal('')]),
    verifiedRole:z.union([snowflake,z.literal('')]),unverifiedRole:z.union([snowflake,z.literal('')]),
    alertChannel:z.union([snowflake,z.literal('')]),minAge:duration(0,365,86400),attempts:integer(1,5),
    minutes:duration(1,10,60),failure:z.enum(['retry','kick'])
  }),
  permits: z.strictObject({enabled:z.boolean().optional(),entries:z.array(permit).max(30)}),
  automod: z.strictObject({enabled:z.boolean(),spamEnabled:z.boolean().optional(),spamActions:automodActions.optional(),threshold:integer(3,30),window:integer(2,60),action:z.enum(['off','log','delete','warn','timeout']),timeoutMinutes:duration(1,1440,60),filters:z.strictObject(Object.fromEntries(spamFilters.map(key => [key,key === 'malicious' ? filter.optional() : filter]))).optional(),badWords:z.string().max(500).optional(),nsfwDomains:z.string().max(500).optional(),maliciousDomains:z.string().max(500).optional(),spamPoints:integer(0,100).optional(),pointRules:z.array(z.strictObject({points:integer(1,1000),hours:duration(1,168,3600),action:z.enum(['timeout','kick','ban'])})).max(4).optional(),...alerts}),
  moderation:z.strictObject({enabled:z.boolean().optional(),alertChannel:z.union([snowflake,z.literal('')]).optional()}),
  lockdown:z.strictObject({enabled:z.boolean().optional(),alertChannel:z.union([snowflake,z.literal('')]).optional()}),
  backup:z.strictObject({enabled:z.boolean()}),
  checkpoint: z.strictObject({enabled:z.boolean(),age:duration(1,365,86400),agePoints:integer(0,5),avatarPoints:integer(0,5),threshold:integer(1,25),alertChannel:z.union([snowflake,z.literal('')]),alertRoles:z.array(snowflake).max(5),rejoinPoints:integer(0,5).optional(),similarPoints:integer(0,5).optional(),inviteNamePoints:integer(0,5).optional(),verifiedBot:botRule.optional(),unverifiedBot:botRule.optional(),rules:z.array(z.strictObject({score:integer(1,25),action:z.enum(['log','kick','quarantine','tempban'])})).max(4).optional(),...timedResponse}),
  nuke: z.strictObject({enabled:z.boolean(),threshold:integer(2,30),window:integer(5,120),trusted:z.string().max(500).regex(/^\s*(?:\d{17,20}(?:\s*,\s*\d{17,20})*)?\s*$/),action:nukeAction,rates:rates.optional(),guards:guards.optional(),...alerts,...timedResponse}),
  raid: z.strictObject({enabled:z.boolean(),threshold:integer(3,100),window:integer(5,120),duration:integer(15,600),age:duration(0,365,86400),action:z.enum(['log','timeout','kick','ban','tempban','quarantine']),timeoutMinutes:duration(1,1440,60).optional(),...alerts,...timedResponse})
}
const defaults = {
  appeals:{questions:['Why should the server lift your ban?','What would you do differently?'],channel:''},
  reports:{enabled:false,channel:'',emoji:''},
  honeypot:{enabled:false,channel:'',action:'delete',timeoutMinutes:10,alertChannel:''},
  verification:{enabled:false,mode:'button',channel:'',verifiedRole:'',unverifiedRole:'',alertChannel:'',minAge:0,attempts:3,minutes:2,failure:'retry'},
  permits:{entries:[]},
  automod:{enabled:false,threshold:6,window:8,action:'off',timeoutMinutes:5,badWords:'',nsfwDomains:'',maliciousDomains:'',spamPoints:0,pointRules:[]},
  moderation:{enabled:false,alertChannel:''},
  backup:{enabled:false},
  lockdown:{enabled:false,alertChannel:''},
  checkpoint:{enabled:false,age:7,agePoints:3,avatarPoints:2,threshold:5,alertChannel:'',alertRoles:[],rejoinPoints:0,similarPoints:0,inviteNamePoints:0,quarantineMinutes:10,tempBanMinutes:60},
  nuke:{enabled:false,threshold:3,window:20,trusted:'',action:'log',alertChannel:'',alertRoles:[],tempBanMinutes:60,quarantineMinutes:10},
  raid:{enabled:false,threshold:8,window:15,duration:60,age:7,action:'log',timeoutMinutes:10,alertChannel:'',alertRoles:[],tempBanMinutes:60,quarantineMinutes:10}
}
export function createStore(file) {
  if (file !== ':memory:') mkdirSync(dirname(file),{recursive:true})
  const db = new DatabaseSync(file)
  const billing = billingStore(db,guildPlan)
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS policy (guild TEXT, kind TEXT, config TEXT, PRIMARY KEY(guild,kind));
    CREATE TABLE IF NOT EXISTS event (id INTEGER PRIMARY KEY, guild TEXT, kind TEXT, detail TEXT, at INTEGER);
    CREATE INDEX IF NOT EXISTS event_guild_time ON event(guild,at DESC);
    CREATE INDEX IF NOT EXISTS event_time ON event(at);`)
  db.exec('CREATE TABLE IF NOT EXISTS temp_ban (guild TEXT, user TEXT, marker TEXT, expires INTEGER, PRIMARY KEY(guild,user))')
  db.exec('CREATE TABLE IF NOT EXISTS channel_lock (guild TEXT, channel TEXT, PRIMARY KEY(guild,channel))')
  db.exec(`CREATE TABLE IF NOT EXISTS web_session (id TEXT PRIMARY KEY, data TEXT, expires INTEGER);
    CREATE TABLE IF NOT EXISTS recovery (guild TEXT, kind TEXT, data TEXT, PRIMARY KEY(guild,kind));
    CREATE TABLE IF NOT EXISTS backup (id INTEGER PRIMARY KEY, guild TEXT, at INTEGER, data TEXT);
    CREATE INDEX IF NOT EXISTS backup_guild ON backup(guild,id DESC);`)
  db.exec(`DELETE FROM backup WHERE id IN (
    SELECT id FROM (SELECT id,row_number() OVER (PARTITION BY guild ORDER BY id DESC) AS rank FROM backup) WHERE rank>3
  );
  DELETE FROM recovery WHERE kind LIKE 'restore:%' AND NOT EXISTS (
    SELECT 1 FROM backup WHERE backup.guild=recovery.guild AND backup.id=CAST(substr(recovery.kind,9) AS INTEGER)
  );
  CREATE TABLE IF NOT EXISTS quarantine_member (
    guild TEXT, user TEXT, role TEXT, expires INTEGER, PRIMARY KEY(guild,user,role)
  );`)
  const append = db.prepare('INSERT INTO event (guild,kind,detail,at) VALUES (?,?,?,?)')
  const read = db.prepare('SELECT config FROM policy WHERE guild=? AND kind=?')
  const write = db.prepare('INSERT INTO policy VALUES (?,?,?) ON CONFLICT(guild,kind) DO UPDATE SET config=excluded.config')
  db.exec(`CREATE TABLE IF NOT EXISTS automod_points (
    guild TEXT, user TEXT, event TEXT, points INTEGER, at INTEGER, PRIMARY KEY(guild,event)
  ); CREATE INDEX IF NOT EXISTS automod_points_user ON automod_points(guild,user,at);
  CREATE INDEX IF NOT EXISTS automod_points_age ON automod_points(at);`)
  const awardPoints = db.prepare('INSERT OR IGNORE INTO automod_points VALUES (?,?,?,?,?)')
  db.exec(`CREATE TABLE IF NOT EXISTS ban_appeal (
    id TEXT PRIMARY KEY, guild TEXT NOT NULL, user TEXT NOT NULL, questions TEXT NOT NULL,
    answers TEXT, status TEXT NOT NULL, created INTEGER NOT NULL, submitted INTEGER, reviewed INTEGER
  ); CREATE INDEX IF NOT EXISTS ban_appeal_inbox ON ban_appeal(guild,status,submitted DESC);`)
  db.exec(`CREATE TABLE IF NOT EXISTS ban_appeal_blacklist (guild TEXT,user TEXT,PRIMARY KEY(guild,user));
    CREATE TABLE IF NOT EXISTS ban_appeal_delivery (id TEXT PRIMARY KEY REFERENCES ban_appeal(id) ON DELETE CASCADE,channel TEXT,message TEXT);`)
  db.exec(`CREATE TABLE IF NOT EXISTS moderation_history (id INTEGER PRIMARY KEY, guild TEXT, user TEXT, action TEXT, detail TEXT, at INTEGER, audit TEXT UNIQUE);
    CREATE INDEX IF NOT EXISTS moderation_history_target ON moderation_history(guild,user,at DESC);
    CREATE TABLE IF NOT EXISTS blackridge_migration (name TEXT PRIMARY KEY);`)
  db.exec(`BEGIN IMMEDIATE;
    UPDATE policy SET config=json_set(config,'$.enabled',json('true'))
    WHERE kind IN ('nuke','raid','moderation','lockdown','backup') AND json_type(config,'$.enabled') IS NULL
      AND NOT EXISTS (SELECT 1 FROM blackridge_migration WHERE name='disabled-defaults');
    INSERT OR IGNORE INTO blackridge_migration VALUES ('disabled-defaults');
    COMMIT;`)
  const recordCase = db.prepare('INSERT OR IGNORE INTO moderation_history(guild,user,action,detail,at,audit) VALUES (?,?,?,?,?,?)')
  const caseParts = /^(warn|kick|ban|tempban) · member (\d{17,20}) · moderator \d{17,20} · ([\s\S]*)$/
  if (!db.prepare("SELECT 1 FROM blackridge_migration WHERE name='history'").get()) {
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of db.prepare("SELECT guild,detail,at FROM event WHERE kind='moderation'").iterate()) {
        const match = row.detail.match(caseParts)
        if (match) recordCase.run(row.guild,match[2],match[1],match[3],row.at,null)
      }
      db.exec("INSERT INTO blackridge_migration VALUES ('history'); COMMIT")
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS nuke_detection (guild TEXT, actor TEXT, rule TEXT, entry TEXT, at INTEGER, PRIMARY KEY(guild,rule,entry));
    CREATE INDEX IF NOT EXISTS nuke_detection_actor ON nuke_detection(guild,actor,rule,at);
    CREATE INDEX IF NOT EXISTS nuke_detection_age ON nuke_detection(at);`)
  const addDetection = db.prepare('INSERT OR IGNORE INTO nuke_detection VALUES (?,?,?,?,?)')
  const countDetections = db.prepare('SELECT COUNT(*) AS total FROM nuke_detection WHERE guild=? AND actor=? AND rule=? AND at>?')
  const sumPoints = db.prepare('SELECT coalesce(sum(points),0) AS total FROM automod_points WHERE guild=? AND user=? AND at>?')
  return {
    billing,guildPlan:billing.plan,
    inviteAppeal(id,guild,user,questions) {
      db.prepare("INSERT INTO ban_appeal(id,guild,user,questions,status,created) VALUES (?,?,?,?,'invited',?)")
        .run(id,guild,user,JSON.stringify(questions),Date.now())
    },
    appeal(id) { return db.prepare('SELECT * FROM ban_appeal WHERE id=?').get(id) },
    appealBlacklisted(guild,user) { return Boolean(db.prepare('SELECT 1 FROM ban_appeal_blacklist WHERE guild=? AND user=?').get(guild,user)) },
    appealDelivery(id) { return db.prepare('SELECT channel,message FROM ban_appeal_delivery WHERE id=?').get(id) },
    saveAppealDelivery(id,channel,message) { db.prepare('INSERT OR REPLACE INTO ban_appeal_delivery VALUES (?,?,?)').run(id,channel,message) },
    submitAppeal(id,user,answers) {
      return db.prepare("UPDATE ban_appeal SET answers=?,status='pending',submitted=? WHERE id=? AND user=? AND status='invited' AND created>? AND NOT EXISTS (SELECT 1 FROM ban_appeal_blacklist blocked WHERE blocked.guild=ban_appeal.guild AND blocked.user=ban_appeal.user)")
        .run(JSON.stringify(answers),Date.now(),id,user,Date.now()-30*86400000).changes === 1
    },
    appeals(guild) {
      return db.prepare("SELECT id,user,questions,answers,status,submitted,reviewed FROM ban_appeal WHERE guild=? AND submitted IS NOT NULL ORDER BY (status='pending') DESC,submitted DESC LIMIT 50").all(guild)
        .map(row => ({...row,questions:JSON.parse(row.questions),answers:JSON.parse(row.answers)}))
    },
    reviewAppeal(id,guild,status) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const changed = db.prepare("UPDATE ban_appeal SET status=?,reviewed=? WHERE id=? AND guild=? AND status='pending'")
          .run(status,Date.now(),id,guild).changes === 1
        if (changed && status === 'blacklisted') db.prepare('INSERT OR IGNORE INTO ban_appeal_blacklist SELECT guild,user FROM ban_appeal WHERE id=?').run(id)
        db.exec('COMMIT')
        return changed
      } catch (error) { db.exec('ROLLBACK'); throw error }
    },
    nukeDetection(guild,actor,rule,entry,now) {
      if (!addDetection.run(guild,actor,rule,entry,now).changes) return 0
      return countDetections.get(guild,actor,rule,now-86400000).total
    },
    escalation(guild,user,event,points,rules,now=Date.now()) {
      if (!points || !awardPoints.run(guild,user,event,points,now).changes) return null
      const matched = rules.filter(rule => {
        const total = sumPoints.get(guild,user,now-rule.hours*3600000).total
        return total >= rule.points && total-points < rule.points
      })
      return matched.sort((a,b) => b.points-a.points)[0] ?? null
    },
    quarantineMember(guild,user,role,expires) {
      db.prepare('INSERT INTO quarantine_member VALUES (?,?,?,?) ON CONFLICT(guild,user,role) DO UPDATE SET expires=max(expires,excluded.expires)').run(guild,user,role,expires)
    },
    hasQuarantine(guild,user,role) { return Boolean(db.prepare('SELECT 1 FROM quarantine_member WHERE guild=? AND user=? AND role=?').get(guild,user,role)) },
    dueQuarantines() { return db.prepare('SELECT * FROM quarantine_member WHERE expires<=? ORDER BY expires LIMIT 100').all(Date.now()) },
    removeQuarantine(row) { db.prepare('DELETE FROM quarantine_member WHERE guild=? AND user=? AND role=? AND expires=?').run(row.guild,row.user,row.role,row.expires) },
    session(id) { return db.prepare('SELECT data FROM web_session WHERE id=? AND expires>?').get(id,Date.now())?.data },
    sessionCount() { return db.prepare('SELECT count(*) AS count FROM web_session WHERE expires>?').get(Date.now()).count },
    saveSession(id,data,expires) { db.prepare('INSERT INTO web_session VALUES (?,?,?)').run(id,data,expires) },
    deleteSession(id) { db.prepare('DELETE FROM web_session WHERE id=?').run(id) },
    recovery(guild,kind) { return JSON.parse(db.prepare('SELECT data FROM recovery WHERE guild=? AND kind=?').get(guild,kind)?.data ?? 'null') },
    saveRecovery(guild,kind,data) { db.prepare('INSERT INTO recovery VALUES (?,?,?) ON CONFLICT(guild,kind) DO UPDATE SET data=excluded.data').run(guild,kind,JSON.stringify(data)) },
    clearRecovery(guild,kind) { db.prepare('DELETE FROM recovery WHERE guild=? AND kind=?').run(guild,kind) },
    saveBackup(guild,data) {
      db.prepare('INSERT INTO backup (guild,at,data) VALUES (?,?,?)').run(guild,Date.now(),JSON.stringify(data))
      db.prepare('DELETE FROM backup WHERE guild=? AND id NOT IN (SELECT id FROM backup WHERE guild=? ORDER BY id DESC LIMIT 3)').run(guild,guild)
      db.prepare("DELETE FROM recovery WHERE guild=? AND kind LIKE 'restore:%' AND CAST(substr(kind,9) AS INTEGER) NOT IN (SELECT id FROM backup WHERE guild=?)").run(guild,guild)
    },
    backups(guild) { return db.prepare('SELECT id,at FROM backup WHERE guild=? ORDER BY id DESC').all(guild) },
    backup(guild,id) { return JSON.parse(db.prepare('SELECT data FROM backup WHERE guild=? AND id=?').get(guild,id)?.data ?? 'null') },
    recoveries(kind) { return db.prepare('SELECT guild FROM recovery WHERE kind=?').all(kind) },
    scheduledBackups() { return db.prepare("SELECT guild FROM recovery WHERE kind='backupSchedule'").all() },
    lock(guild,channel) { db.prepare('INSERT INTO channel_lock VALUES (?,?)').run(guild,channel) },
    hasLock(guild,channel) { return Boolean(db.prepare('SELECT 1 FROM channel_lock WHERE guild=? AND channel=?').get(guild,channel)) },
    unlock(guild,channel) { db.prepare('DELETE FROM channel_lock WHERE guild=? AND channel=?').run(guild,channel) },
    tempBan(guild,user,marker,expires) { db.prepare('INSERT INTO temp_ban VALUES (?,?,?,?)').run(guild,user,marker,expires) },
    dueBans() { return db.prepare('SELECT * FROM temp_ban WHERE expires<=? ORDER BY expires LIMIT 100').all(Date.now()) },
    pendingTempBan(guild,user) { return db.prepare('SELECT marker,expires FROM temp_ban WHERE guild=? AND user=?').get(guild,user) },
    removeTempBan(guild,user,marker) { db.prepare('DELETE FROM temp_ban WHERE guild=? AND user=? AND marker=?').run(guild,user,marker) },
    config(guild,kind) {
      const saved = JSON.parse(read.get(guild,kind)?.config ?? '{}')
      if (kind === 'permits') return normalizePermits(saved)
      const config = {...defaults[kind],...saved}
      if (kind === 'honeypot') config.actions ??= [config.action]
      if (kind === 'automod') config.pointRules = config.pointRules.slice(0,4)
      return config
    },
    save(guild,kind,config,actor) {
      db.exec('BEGIN IMMEDIATE')
      try {
        write.run(guild,kind,JSON.stringify(config))
        append.run(guild,'settings',kind + ' policy updated by ' + actor,Date.now())
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
    },
    event(guild,kind,detail) {
      const at = Date.now()
      const match = kind === 'moderation' && detail.match(caseParts)
      if (!match) { append.run(guild,kind,detail,at); return }
      db.exec('BEGIN IMMEDIATE')
      try {
        append.run(guild,kind,detail,at)
        recordCase.run(guild,match[2],match[1],match[3],at,null)
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
    },
    recordModeration(guild,user,action,detail,at=Date.now(),audit=null) { recordCase.run(guild,user,action,detail,at,audit) },
    history(guild,user) { return db.prepare('SELECT action,detail,at FROM moderation_history WHERE guild=? AND user=? ORDER BY at DESC,id DESC').all(guild,user) },
    recent(guild,kind) {
      return kind === 'moderation'
        ? db.prepare("SELECT kind,detail,at FROM event WHERE guild=? AND kind='moderation' ORDER BY at DESC,id DESC LIMIT 5").all(guild)
        : db.prepare('SELECT kind,detail,at FROM event WHERE guild=? ORDER BY at DESC,id DESC LIMIT 10').all(guild)
    },
    activity(guild,now=Date.now()) {
      const day = 86400000
      const start = Math.floor(now / day) * day - 29 * day
      const counts = db.prepare(`SELECT CAST((at - ?) / ? AS INTEGER) AS bucket,
        COUNT(*) AS total,
        SUM(CASE WHEN kind IN ('raid','nuke','checkpoint','automod','honeypot') THEN 1 ELSE 0 END) AS protection
        FROM event WHERE guild=? AND at>=? AND at<=? GROUP BY bucket`).all(start,day,guild,start,now)
      const byDay = new Map(counts.map(({bucket,total,protection}) => [bucket,{total,protection}]))
      return Array.from({length:30},(_,index) => ({
        at:start + index * day,
        ...(byDay.get(index) ?? {total:0,protection:0})
      }))
    },
    stats(guild) { return db.prepare("SELECT COUNT(*) total,COUNT(CASE WHEN kind='nuke' THEN 1 END) nuke,COUNT(CASE WHEN kind='raid' THEN 1 END) raid FROM event WHERE guild=? AND at>=?").get(guild,Date.now()-86400000) },
    prune() {
      db.prepare('DELETE FROM event WHERE at<?').run(Date.now()-30*86400000)
      db.prepare("DELETE FROM ban_appeal WHERE (status='invited' AND created<=?) OR (reviewed IS NOT NULL AND reviewed<=?)")
        .run(Date.now()-30*86400000,Date.now()-90*86400000)
      db.prepare('DELETE FROM nuke_detection WHERE at<=?').run(Date.now()-86400000)
      db.prepare('DELETE FROM web_session WHERE expires<=?').run(Date.now())
      db.prepare('DELETE FROM automod_points WHERE at<=?').run(Date.now()-168*3600000)
    },
    close() { db.close() }
  }
}

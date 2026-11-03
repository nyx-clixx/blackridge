import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

const integer = (min,max) => z.number().int().min(min).max(max)
const rate = z.strictObject({enabled:z.boolean(),threshold:integer(2,30),window:integer(5,120)})
const rates = z.strictObject(Object.fromEntries(
  ['moderation','roleCreate','roleDelete','channelCreate','channelDelete','webhookCreate'].map(key => [key,rate])
))
const snowflake = z.string().regex(/^\d{17,20}$/)
export const commandNames = ['ban','kick','timeout','warn','tempban','lock','unlock']
const principals = z.array(snowflake).max(15)
const permit = z.strictObject({users:principals,roles:principals})
const alerts = {alertChannel:z.union([snowflake,z.literal('')]).optional(),alertRoles:z.array(snowflake).max(5).optional()}
const timedResponse = {tempBanMinutes:integer(1,1440).optional(),quarantineMinutes:integer(1,1440).optional()}
export const spamFilters = ['mentions','files','images','stickers','invites','links','caps','newlines','length','emoji','headers','duplicate','multiUser','badWords','scam','nsfw','ghost']
const filter = z.strictObject({action:z.enum(['off','log','delete','timeout']),limit:integer(1,4000)})
export const policies = {
  permits: z.strictObject(Object.fromEntries(commandNames.map(name => [name,permit]))),
  automod: z.strictObject({enabled:z.boolean(),threshold:integer(3,30),window:integer(2,60),action:z.enum(['log','timeout']),timeoutMinutes:integer(1,1440),filters:z.strictObject(Object.fromEntries(spamFilters.map(key => [key,filter]))).optional(),badWords:z.string().max(500).optional(),nsfwDomains:z.string().max(500).optional(),...alerts}),
  moderation:z.strictObject({alertChannel:z.union([snowflake,z.literal('')])}),
  lockdown:z.strictObject({alertChannel:z.union([snowflake,z.literal('')])}),
  backup:z.strictObject({alertChannel:z.union([snowflake,z.literal('')])}),
  checkpoint: z.strictObject({enabled:z.boolean(),age:integer(1,365),agePoints:integer(0,5),avatarPoints:integer(0,5),threshold:integer(1,25),alertChannel:z.union([snowflake,z.literal('')]),alertRoles:z.array(snowflake).max(5),rejoinPoints:integer(0,5).optional(),similarPoints:integer(0,5).optional(),inviteNamePoints:integer(0,5).optional(),rules:z.array(z.strictObject({score:integer(1,25),action:z.enum(['log','kick','quarantine','tempban'])})).max(3).optional(),...timedResponse}),
  nuke: z.strictObject({enabled:z.boolean(),threshold:integer(2,30),window:integer(5,120),trusted:z.string().max(500).regex(/^\s*(?:\d{17,20}(?:\s*,\s*\d{17,20})*)?\s*$/),action:z.enum(['log','strip','kick','ban','tempban','quarantine']),rates:rates.optional(),...alerts,...timedResponse}),
  raid: z.strictObject({enabled:z.boolean(),threshold:integer(3,100),window:integer(5,120),duration:integer(15,600),age:integer(0,365),action:z.enum(['log','timeout','kick','ban','tempban','quarantine']),timeoutMinutes:integer(1,1440).optional(),...alerts,...timedResponse})
}
const defaults = {
  permits:Object.fromEntries(commandNames.map(name => [name,{users:[],roles:[]}])),
  automod:{enabled:false,threshold:6,window:8,action:'log',timeoutMinutes:5,badWords:'',nsfwDomains:''},
  checkpoint:{enabled:false,age:7,agePoints:3,avatarPoints:2,threshold:5,alertChannel:'',alertRoles:[],rejoinPoints:0,similarPoints:0,inviteNamePoints:0,quarantineMinutes:10,tempBanMinutes:60},
  nuke:{enabled:true,threshold:3,window:20,trusted:'',action:'log',alertChannel:'',alertRoles:[],tempBanMinutes:60,quarantineMinutes:10},
  raid:{enabled:true,threshold:8,window:15,duration:60,age:7,action:'log',timeoutMinutes:10,alertChannel:'',alertRoles:[],tempBanMinutes:60,quarantineMinutes:10}
}
export function createStore(file) {
  if (file !== ':memory:') mkdirSync(dirname(file),{recursive:true})
  const db = new DatabaseSync(file)
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
  const append = db.prepare('INSERT INTO event (guild,kind,detail,at) VALUES (?,?,?,?)')
  const read = db.prepare('SELECT config FROM policy WHERE guild=? AND kind=?')
  const write = db.prepare('INSERT INTO policy VALUES (?,?,?) ON CONFLICT(guild,kind) DO UPDATE SET config=excluded.config')
  return {
    session(id) { return db.prepare('SELECT data FROM web_session WHERE id=? AND expires>?').get(id,Date.now())?.data },
    sessionCount() { return db.prepare('SELECT count(*) AS count FROM web_session WHERE expires>?').get(Date.now()).count },
    saveSession(id,data,expires) { db.prepare('INSERT INTO web_session VALUES (?,?,?)').run(id,data,expires) },
    deleteSession(id) { db.prepare('DELETE FROM web_session WHERE id=?').run(id) },
    recovery(guild,kind) { return JSON.parse(db.prepare('SELECT data FROM recovery WHERE guild=? AND kind=?').get(guild,kind)?.data ?? 'null') },
    saveRecovery(guild,kind,data) { db.prepare('INSERT INTO recovery VALUES (?,?,?) ON CONFLICT(guild,kind) DO UPDATE SET data=excluded.data').run(guild,kind,JSON.stringify(data)) },
    clearRecovery(guild,kind) { db.prepare('DELETE FROM recovery WHERE guild=? AND kind=?').run(guild,kind) },
    saveBackup(guild,data) {
      db.prepare('INSERT INTO backup (guild,at,data) VALUES (?,?,?)').run(guild,Date.now(),JSON.stringify(data))
      db.prepare('DELETE FROM backup WHERE guild=? AND id NOT IN (SELECT id FROM backup WHERE guild=? ORDER BY id DESC LIMIT 20)').run(guild,guild)
      db.prepare("DELETE FROM recovery WHERE guild=? AND kind LIKE 'restore:%' AND CAST(substr(kind,9) AS INTEGER) NOT IN (SELECT id FROM backup WHERE guild=?)").run(guild,guild)
    },
    backups(guild) { return db.prepare('SELECT id,at FROM backup WHERE guild=? ORDER BY id DESC').all(guild) },
    backup(guild,id) { return JSON.parse(db.prepare('SELECT data FROM backup WHERE guild=? AND id=?').get(guild,id)?.data ?? 'null') },
    scheduledBackups() { return db.prepare("SELECT guild FROM recovery WHERE kind='backupSchedule'").all() },
    lock(guild,channel) { db.prepare('INSERT INTO channel_lock VALUES (?,?)').run(guild,channel) },
    hasLock(guild,channel) { return Boolean(db.prepare('SELECT 1 FROM channel_lock WHERE guild=? AND channel=?').get(guild,channel)) },
    unlock(guild,channel) { db.prepare('DELETE FROM channel_lock WHERE guild=? AND channel=?').run(guild,channel) },
    tempBan(guild,user,marker,expires) { db.prepare('INSERT INTO temp_ban VALUES (?,?,?,?)').run(guild,user,marker,expires) },
    dueBans() { return db.prepare('SELECT * FROM temp_ban WHERE expires<=? ORDER BY expires LIMIT 100').all(Date.now()) },
    removeTempBan(guild,user,marker) { db.prepare('DELETE FROM temp_ban WHERE guild=? AND user=? AND marker=?').run(guild,user,marker) },
    config(guild,kind) { return {...defaults[kind], ...JSON.parse(read.get(guild,kind)?.config ?? '{}')} },
    save(guild,kind,config,actor) {
      db.exec('BEGIN IMMEDIATE')
      try {
        write.run(guild,kind,JSON.stringify(config))
        append.run(guild,'settings',kind + ' policy updated by ' + actor,Date.now())
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
    },
    event(guild,kind,detail) { append.run(guild,kind,detail,Date.now()) },
    recent(guild) { return db.prepare('SELECT kind,detail,at FROM event WHERE guild=? ORDER BY at DESC,id DESC LIMIT 100').all(guild) },
    stats(guild) { return db.prepare("SELECT COUNT(*) total,COUNT(CASE WHEN kind='nuke' THEN 1 END) nuke,COUNT(CASE WHEN kind='raid' THEN 1 END) raid FROM event WHERE guild=? AND at>=?").get(guild,Date.now()-86400000) },
    prune() {
      db.prepare('DELETE FROM event WHERE at<?').run(Date.now()-30*86400000)
      db.prepare('DELETE FROM web_session WHERE expires<=?').run(Date.now())
    },
    close() { db.close() }
  }
}


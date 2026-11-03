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
export const policies = {
  nuke: z.strictObject({enabled:z.boolean(),threshold:integer(2,30),window:integer(5,120),trusted:z.string().max(500).regex(/^\s*(?:\d{17,20}(?:\s*,\s*\d{17,20})*)?\s*$/),action:z.enum(['log','strip','kick']),rates:rates.optional()}),
  raid: z.strictObject({enabled:z.boolean(),threshold:integer(3,100),window:integer(5,120),duration:integer(15,600),age:integer(0,365),action:z.enum(['log','timeout','kick']),timeoutMinutes:integer(1,1440).optional(),alertChannel:z.union([snowflake,z.literal('')]).optional(),alertRoles:z.array(snowflake).max(5).optional()})
}
const defaults = {
  nuke:{enabled:true,threshold:3,window:20,trusted:'',action:'log'},
  raid:{enabled:true,threshold:8,window:15,duration:60,age:7,action:'log',timeoutMinutes:10,alertChannel:'',alertRoles:[]}
}
export function createStore(file) {
  if (file !== ':memory:') mkdirSync(dirname(file),{recursive:true})
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS policy (guild TEXT, kind TEXT, config TEXT, PRIMARY KEY(guild,kind));
    CREATE TABLE IF NOT EXISTS event (id INTEGER PRIMARY KEY, guild TEXT, kind TEXT, detail TEXT, at INTEGER);
    CREATE INDEX IF NOT EXISTS event_guild_time ON event(guild,at DESC);
    CREATE INDEX IF NOT EXISTS event_time ON event(at);`)
  const append = db.prepare('INSERT INTO event (guild,kind,detail,at) VALUES (?,?,?,?)')
  const read = db.prepare('SELECT config FROM policy WHERE guild=? AND kind=?')
  const write = db.prepare('INSERT INTO policy VALUES (?,?,?) ON CONFLICT(guild,kind) DO UPDATE SET config=excluded.config')
  return {
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
    prune() { db.prepare('DELETE FROM event WHERE at<?').run(Date.now()-30*86400000) },
    close() { db.close() }
  }
}


import { Events } from 'discord.js'

const hour = 3600000
const day = 24 * hour

export function analyticsStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS analytics_start (
    guild TEXT PRIMARY KEY, at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS analytics_count (
    guild TEXT NOT NULL, span INTEGER NOT NULL, at INTEGER NOT NULL,
    messages INTEGER NOT NULL, joins INTEGER NOT NULL, leaves INTEGER NOT NULL,
    PRIMARY KEY (guild,span,at)
  );
  CREATE INDEX IF NOT EXISTS analytics_retention ON analytics_count(span,at);`)
  const begin = db.prepare('INSERT OR IGNORE INTO analytics_start VALUES (?,?)')
  const started = db.prepare('SELECT at FROM analytics_start WHERE guild=?')
  const write = db.prepare(`INSERT INTO analytics_count VALUES (?,?,?,?,?,?)
    ON CONFLICT(guild,span,at) DO UPDATE SET messages=messages+excluded.messages,
    joins=joins+excluded.joins, leaves=leaves+excluded.leaves`)
  const read = db.prepare('SELECT at,messages,joins,leaves FROM analytics_count WHERE guild=? AND span=? AND at>=? AND at<=?')
  const remove = db.prepare('DELETE FROM analytics_count WHERE span=? AND at<?')
  const pending = new Map()
  const pendingStarts = new Map()

  function flush() {
    if (!pending.size && !pendingStarts.size) return
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const [guild,at] of pendingStarts) begin.run(guild,at)
      for (const {guild,at,messages,joins,leaves} of pending.values()) {
        write.run(guild,hour,at,messages,joins,leaves)
        write.run(guild,day,Math.floor(at/day)*day,messages,joins,leaves)
      }
      db.exec('COMMIT')
      pending.clear()
      pendingStarts.clear()
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  function range(guild,period,now=Date.now()) {
    const since = started.get(guild)?.at ?? null
    const span = period === 'day' ? hour : day
    const end = Math.floor(now/span)*span
    const current = new Date(now)
    const length = {day:24,week:7,month:30}[period]
    const dates = period === 'year'
      ? Array.from({length:12},(_,i) => Date.UTC(current.getUTCFullYear(),current.getUTCMonth()-11+i,1))
      : Array.from({length},(_,i) => end - (length-1-i)*span)
    const buckets = new Map(dates.map(at => [at,{at,messages:0,joins:0,leaves:0}]))
    for (const row of read.all(guild,span,dates[0],end)) {
      const date = new Date(row.at)
      const at = period === 'year' ? Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1) : row.at
      const bucket = buckets.get(at)
      for (const metric of ['messages','joins','leaves']) bucket[metric] += row[metric]
    }
    return {since,buckets:[...buckets.values()]}
  }

  return {
    start(guild,now=Date.now()) {
      if (!pendingStarts.has(guild)) pendingStarts.set(guild,now)
    },
    add(guild,metric,now=Date.now()) {
      const at = Math.floor(now/hour)*hour
      const key = guild + ':' + at
      let row = pending.get(key)
      if (!row) {
        if (!pendingStarts.has(guild)) pendingStarts.set(guild,now)
        row = {guild,at,messages:0,joins:0,leaves:0}
        pending.set(key,row)
      }
      row[metric]++
    },
    flush,
    range(guild,period,now) { flush(); return range(guild,period,now) },
    prune(now=Date.now()) {
      flush()
      remove.run(hour,Math.floor(now/hour)*hour-47*hour)
      remove.run(day,Math.floor(now/day)*day-365*day)
    }
  }
}

export function mountAnalytics(client,analytics) {
  const start = guild => analytics.start(guild.id)
  const startAvailable = () => {
    for (const guild of client.guilds.cache.values()) if (guild.available) start(guild)
  }
  if (client.isReady()) startAvailable()
  else client.once(Events.ClientReady,startAvailable)
  client.on(Events.GuildCreate,start)
  client.on(Events.GuildAvailable,start)
  client.on(Events.MessageCreate,message => {
    if (message.guildId && message.author?.bot === false && !message.webhookId && !message.system)
      analytics.add(message.guildId,'messages')
  })
  client.on(Events.GuildMemberAdd,member => {
    if (member.user.bot === false) analytics.add(member.guild.id,'joins')
  })
  client.on(Events.GuildMemberRemove,member => {
    if (member.user.bot === false) analytics.add(member.guild.id,'leaves')
  })
}

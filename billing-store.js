export const transferLimit = 3
const terminal = new Set(['canceled','incomplete_expired'])
export const billingError = (message,status = 409) => Object.assign(new Error(message),{status})
export function billingStore(db, complimentaryPlan) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_checkout (
      guild TEXT PRIMARY KEY, owner TEXT NOT NULL, plan TEXT NOT NULL, ref TEXT NOT NULL UNIQUE,
      price TEXT NOT NULL, expires INTEGER NOT NULL, session TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS billing_subscription (
      id TEXT PRIMARY KEY, guild TEXT NOT NULL, owner TEXT NOT NULL, customer TEXT NOT NULL,
      plan TEXT NOT NULL, status TEXT NOT NULL, paid_until INTEGER NOT NULL DEFAULT 0,
      cancel_at INTEGER NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS billing_current_guild ON billing_subscription(guild) WHERE closed=0;
    CREATE TABLE IF NOT EXISTS billing_transfer (owner TEXT NOT NULL, month TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(owner,month));
    CREATE TABLE IF NOT EXISTS billing_risk (subscription TEXT PRIMARY KEY, reason TEXT NOT NULL);
  `)
  const current = db.prepare('SELECT s.*, r.reason AS risk FROM billing_subscription s LEFT JOIN billing_risk r ON r.subscription=s.id WHERE s.guild=? AND s.closed=0')
  const checkout = db.prepare('SELECT * FROM billing_checkout WHERE guild=?')
  const byRef = db.prepare('SELECT * FROM billing_checkout WHERE ref=?')
  const lookup = db.prepare('SELECT * FROM billing_subscription WHERE id=?')
  const month = () => new Date().toISOString().slice(0,7)
  const count = db.prepare('SELECT count FROM billing_transfer WHERE owner=? AND month=?')
  const remaining = owner => transferLimit - (count.get(owner,month())?.count ?? 0)
  const transaction = work => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      db.exec('COMMIT')
      return result
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function available(guild) {
    return complimentaryPlan(guild) === 'free' && !current.get(guild) && !checkout.get(guild)
  }
  return {
    current:guild => current.get(guild),
    subscription:id => lookup.get(id),
    owned:owner => db.prepare('SELECT guild,plan FROM billing_subscription WHERE owner=? AND closed=0 ORDER BY guild').all(owner),
    remaining,
    available,
    plan(guild) {
      const grant = complimentaryPlan(guild)
      const row = current.get(guild)
      const paid = row && !row.risk && ['active','past_due'].includes(row.status) && row.paid_until > Date.now() ? row.plan : 'free'
      return grant === 'custom' || paid === 'custom' ? 'custom' : grant === 'premium' || paid === 'premium' ? 'premium' : 'free'
    },
    reserve(guild,owner,plan,ref,price,expires) {
      return transaction(() => {
        const existing = checkout.get(guild)
        if (existing) {
          if (existing.owner !== owner) throw billingError('A checkout is already pending for this server.')
          return existing
        }
        if (!available(guild)) throw billingError('This server already has a plan.')
        db.prepare('INSERT INTO billing_checkout(guild,owner,plan,ref,price,expires) VALUES (?,?,?,?,?,?)').run(guild,owner,plan,ref,price,expires)
        return checkout.get(guild)
      })
    },
    remember(ref,session) { db.prepare('UPDATE billing_checkout SET session=? WHERE ref=? AND session IS NULL').run(session,ref) },
    release(ref,session) { db.prepare('DELETE FROM billing_checkout WHERE ref=? AND (session=? OR session IS NULL)').run(ref,session) },
    attach(ref,session,id,customer) {
      return transaction(() => {
        const order = byRef.get(ref)
        if (!order || (order.session && order.session !== session)) return
        db.prepare("INSERT INTO billing_subscription(id,guild,owner,customer,plan,status) VALUES (?,?,?,?,?,'incomplete')").run(id,order.guild,order.owner,customer,order.plan)
        db.prepare('DELETE FROM billing_checkout WHERE ref=?').run(ref)
      })
    },
    sync(id,status,plan,paidUntil,cancelAt) {
      db.prepare(`UPDATE billing_subscription SET status=?, plan=CASE WHEN ?>0 THEN ? ELSE plan END,
        paid_until=CASE WHEN ?>0 THEN ? ELSE paid_until END, cancel_at=?, closed=? WHERE id=?`)
        .run(status,paidUntil,plan,paidUntil,paidUntil,cancelAt,Number(terminal.has(status)),id)
    },
    flag(id,reason) { db.prepare('INSERT OR IGNORE INTO billing_risk VALUES (?,?)').run(id,reason) },
    move(source,target,owner) {
      return transaction(() => {
        const row = current.get(source)
        if (!row || row.owner !== owner || row.risk || row.status !== 'active' || row.paid_until <= Date.now())
          throw billingError('Only the billing owner can transfer an active subscription.')
        if (source === target || !available(target)) throw billingError('The destination server must be on Free with no pending checkout.')
        const period = month()
        if ((count.get(owner,period)?.count ?? 0) >= transferLimit) throw billingError('You have used all three transfers this month.')
        db.prepare('UPDATE billing_subscription SET guild=? WHERE id=?').run(target,row.id)
        db.prepare('INSERT INTO billing_transfer VALUES (?,?,1) ON CONFLICT(owner,month) DO UPDATE SET count=count+1').run(owner,period)
      })
    }
  }
}

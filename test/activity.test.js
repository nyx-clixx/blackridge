import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'

test('overview activity counts every retained event in its server and UTC day', t => {
  const db = createStore(':memory:')
  t.after(() => db.close())
  const firstDay = Date.UTC(2026,9,9)
  const today = Date.UTC(2026,10,7)
  const now = today + 1000
  const clock = t.mock.method(Date,'now',() => firstDay - 1)
  db.event('one','raid','outside range')
  clock.mock.mockImplementation(() => firstDay)
  db.event('one','raid','at start')
  db.event('other','nuke','belongs to another server')
  clock.mock.mockImplementation(() => today - 1)
  db.event('one','settings','yesterday')
  clock.mock.mockImplementation(() => today)
  for (let index = 0; index < 12; index++) db.event('one','nuke','today')
  clock.mock.mockImplementation(() => now)
  db.event('one','verification','up to current time')
  clock.mock.mockImplementation(() => now + 1)
  db.event('one','raid','future')

  const days = db.activity('one',now)
  assert.equal(days.length,30)
  assert.deepEqual(days[0],{at:firstDay,total:1,protection:1})
  assert.deepEqual(days[1],{at:firstDay+86400000,total:0,protection:0})
  assert.deepEqual(days.at(-2),{at:today-86400000,total:1,protection:0})
  assert.deepEqual(days.at(-1),{at:today,total:13,protection:12})
  assert.equal(db.activity('other',now).reduce((sum,day) => sum+day.total,0),1)
})

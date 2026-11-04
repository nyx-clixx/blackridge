import { test } from 'node:test'
import assert from 'node:assert/strict'
import Stripe from 'stripe'
import { createStore } from '../store.js'
import { stripeBilling } from '../billing.js'

test('paid plans transfer atomically and only three times per billing owner per month',t => {
  const db = createStore(':memory:')
  t.after(() => db.close())
  const store = db.billing
  const until = Date.now()+3600000
  store.reserve('source','owner','premium','ref','price',123)
  assert.throws(() => store.reserve('source','other','custom','ref2','price2',123),/pending/)
  store.remember('ref','session')
  store.attach('ref','other-session','sub','customer')
  assert.equal(store.current('source'),undefined)
  store.attach('ref','session','sub','customer')
  store.attach('ref','session','sub','customer')
  assert.equal(db.guildPlan('source'),'free')
  store.sync('sub','active','premium',until,0)
  assert.equal(db.guildPlan('source'),'premium')
  assert.throws(() => store.move('source','dest','other'),/billing owner/)
  assert.throws(() => store.move('source','1567348176866902119','owner'),/destination/)
  store.move('source','dest','owner')
  assert.equal(db.guildPlan('source'),'free')
  assert.equal(db.guildPlan('dest'),'premium')
  store.sync('sub','active','custom',until,0)
  assert.equal(db.guildPlan('dest'),'custom')
  store.move('dest','source','owner')
  store.move('source','dest','owner')
  assert.equal(store.remaining('owner'),0)
  assert.throws(() => store.move('dest','source','owner'),/three transfers/)
  assert.equal(db.guildPlan('dest'),'custom')
  store.flag('sub','charge.dispute.created')
  assert.equal(db.guildPlan('dest'),'free')
  store.sync('sub','canceled','custom',0,0)
  assert.equal(store.available('dest'),true)
})

test('Stripe webhook verifies the signature and mode before binding checkout',async t => {
  const db = createStore(':memory:')
  t.after(() => db.close())
  const secret = 'fixture-signing-secret'
  const key = ['sk','test','fixture'].join('_')
  const billing = stripeBilling(db.billing,'https://example.test',{STRIPE_SECRET_KEY:key,STRIPE_WEBHOOK_SECRET:secret,
    STRIPE_PREMIUM_PRICE:'price_premium',STRIPE_CUSTOM_PRICE:'price_custom',STRIPE_PORTAL_CONFIGURATION:'bpc_test'})
  const stripe = new Stripe(key)
  db.billing.reserve('guild','owner','premium','ref','price_premium',123)
  const make = livemode => Buffer.from(JSON.stringify({livemode,type:'checkout.session.completed',data:{object:{
    id:'cs_test',mode:'subscription',payment_status:'unpaid',client_reference_id:'ref',subscription:'sub',customer:'cus'
  }}}))
  const signature = body => stripe.webhooks.generateTestHeaderString({payload:body.toString(),secret})
  await assert.rejects(billing.webhook(make(false),'bad'),/Invalid webhook signature/)
  await assert.rejects(billing.webhook(make(true),signature(make(true))),/Unexpected Stripe mode/)
  await billing.webhook(make(false),signature(make(false)))
  assert.equal(db.billing.current('guild').owner,'owner')
  assert.equal(db.guildPlan('guild'),'free')
})

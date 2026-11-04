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

test('billing switches open sessions and follows Stripe payment, upgrade, renewal and cancellation',async t => {
  const db = createStore(':memory:')
  t.after(() => db.close())
  const secret = 'fixture-signing-secret'
  const key = ['sk','test','fixture'].join('_')
  const env = {STRIPE_SECRET_KEY:key,STRIPE_WEBHOOK_SECRET:secret,STRIPE_PREMIUM_PRICE:'price_premium',
    STRIPE_CUSTOM_PRICE:'price_custom',STRIPE_PORTAL_CONFIGURATION:'bpc_test'}
  const {webhooks} = new Stripe(key)
  const sessions = new Map()
  const subs = new Map()
  let portalFlow
  let finishesDuringSwitch = false
  const billing = stripeBilling(db.billing,'https://example.test',env,() => ({
    webhooks,subscriptions:{retrieve:async id => subs.get(id)},
    billingPortal:{sessions:{create:async params => { portalFlow = params.flow_data; return {url:'https://portal.example.test'} }}},
    checkout:{sessions:{
      retrieve:async id => sessions.get(id),
      expire:async id => {
        const session = sessions.get(id)
        if (finishesDuringSwitch) {
          session.status = 'complete'
          throw new Error('Checkout completed')
        }
        session.status = 'expired'
        return session
      },
      create:async params => {
        assert.equal(params.managed_payments.enabled,false)
        const id = 'cs_' + (sessions.size+1)
        const session = {id,status:'open',mode:params.mode,client_reference_id:params.client_reference_id,
          price:params.line_items[0].price,url:'https://checkout.example.test/'+id}
        sessions.set(id,session)
        return session
      }
    }}
  }))
  const event = (type,object) => {
    const payload = JSON.stringify({type,livemode:false,data:{object}})
    return billing.webhook(Buffer.from(payload),webhooks.generateTestHeaderString({payload,secret}))
  }
  const first = await billing.checkout('guild','owner','custom')
  assert.equal(await billing.checkout('guild','owner','custom'),first)
  const second = await billing.checkout('guild','owner','premium')
  assert.notEqual(first,second)
  assert.equal(sessions.get('cs_1').status,'expired')
  await event('checkout.session.expired',sessions.get('cs_1'))
  assert.equal(await billing.checkout('guild','owner','premium'),second)
  finishesDuringSwitch = true
  await assert.rejects(billing.checkout('guild','owner','custom'),/awaiting payment/)
  assert.equal(sessions.size,2)
  const session = sessions.get('cs_2')
  Object.assign(session,{customer:'cus',subscription:'sub',payment_status:'unpaid'})
  const item = {id:'si',quantity:1,price:{id:session.price},current_period_end:Math.floor(Date.now()/1000)+3600}
  const invoice = {id:'in',status:'open',parent:{subscription_details:{subscription:'sub'}}}
  const sub = {id:'sub',status:'active',items:{data:[item]},latest_invoice:invoice}
  subs.set('sub',sub)
  await event('invoice.paid',invoice)
  await event('checkout.session.completed',session)
  assert.equal(db.guildPlan('guild'),'free')
  invoice.status = 'paid'
  session.payment_status = 'paid'
  await event('checkout.session.async_payment_succeeded',session)
  await event('invoice.paid',invoice)
  assert.equal(db.guildPlan('guild'),'premium')
  await assert.rejects(billing.portal('guild','other','upgrade'),/billing owner/)
  await billing.portal('guild','owner','upgrade')
  assert.deepEqual(portalFlow.subscription_update_confirm.items,[{id:'si',price:'price_custom',quantity:1}])
  invoice.status = 'open'
  item.price.id = 'price_custom'
  await event('customer.subscription.updated',sub)
  assert.equal(db.guildPlan('guild'),'premium')
  invoice.status = 'paid'
  await event('invoice.paid',invoice)
  assert.equal(db.guildPlan('guild'),'custom')
  const paidUntil = db.billing.current('guild').paid_until
  item.current_period_end += 3600
  invoice.status = 'open'
  sub.status = 'past_due'
  await event('invoice.payment_failed',invoice)
  assert.equal(db.billing.current('guild').paid_until,paidUntil)
  sub.status = 'active'
  invoice.status = 'paid'
  await event('invoice.paid',invoice)
  assert.ok(db.billing.current('guild').paid_until > paidUntil)
  await billing.portal('guild','owner','cancel')
  assert.equal(portalFlow.subscription_cancel.subscription,'sub')
  sub.cancel_at_period_end = true
  await event('customer.subscription.updated',sub)
  assert.equal(db.guildPlan('guild'),'custom')
  assert.equal(db.billing.current('guild').cancel_at,item.current_period_end*1000)
  sub.status = 'canceled'
  await event('customer.subscription.deleted',sub)
  assert.equal(db.guildPlan('guild'),'free')
  assert.equal(db.billing.available('guild'),true)
})


import Stripe from 'stripe'
import { randomUUID } from 'node:crypto'
import { billingError } from './billing-store.js'

const objectId = value => typeof value === 'string' ? value : value?.id
const invoiceSubscription = invoice => objectId(invoice?.parent?.subscription_details?.subscription)
export function stripeBilling(db,base,env = process.env,makeStripe = (key,options) => new Stripe(key,options)) {
  const prices = {premium:env.STRIPE_PREMIUM_PRICE,custom:env.STRIPE_CUSTOM_PRICE}
  const live = env.STRIPE_LIVEMODE === 'true'
  const keyMode = live ? 'live' : 'test'
  const keyMatchesMode = new RegExp('^(?:sk|rk)_' + keyMode + '_').test(env.STRIPE_SECRET_KEY ?? '')
  const enabled = Boolean(keyMatchesMode && env.STRIPE_WEBHOOK_SECRET && prices.premium && prices.custom &&
    prices.premium !== prices.custom && env.STRIPE_PORTAL_CONFIGURATION)
  const stripe = enabled ? makeStripe(env.STRIPE_SECRET_KEY,{timeout:12000,maxNetworkRetries:1}) : null
  const queue = new Map()
  async function serialized(key,operation) {
    const next = (queue.get(key) ?? Promise.resolve()).catch(() => {}).then(operation)
    queue.set(key,next)
    try { return await next } finally { if (queue.get(key) === next) queue.delete(key) }
  }
  const back = guild => base + '/dashboard/' + guild + '/premium'
  const check = () => { if (!enabled) throw billingError('Subscription billing is unavailable.',503) }
  async function sync(id) {
    if (!id || !db.subscription(id)) return
    const sub = await stripe.subscriptions.retrieve(id,{expand:['latest_invoice']})
    const item = sub.items.data[0]
    const plan = sub.items.data.length === 1 && item.quantity === 1
      ? Object.keys(prices).find(key => prices[key] === item.price.id) : null
    const periodEnd = item?.current_period_end
    const paidUntil = plan && sub.status === 'active' && sub.latest_invoice?.status === 'paid' &&
      Number.isSafeInteger(periodEnd) && periodEnd > 0 ? periodEnd * 1000 : 0
    db.sync(id,plan ? sub.status : ['canceled','incomplete_expired'].includes(sub.status) ? sub.status : 'unrecognized',
      plan ?? '',paidUntil,(sub.cancel_at ?? (sub.cancel_at_period_end ? item?.current_period_end : 0) ?? 0) * 1000)
  }
  async function checkout(guild,owner,plan) {
    check()
    if (!Object.hasOwn(prices,plan)) throw billingError('Choose a valid Blackridge plan.',400)
    return serialized('guild:'+guild,async () => {
      let order = db.reserve(guild,owner,plan,randomUUID(),prices[plan],Math.floor(Date.now()/1000)+3600)
      if (order.session) {
        let previous = await stripe.checkout.sessions.retrieve(order.session)
        if (previous.status === 'open' && order.plan === plan && previous.url) return previous.url
        if (previous.status === 'open' && order.plan !== plan) {
          try { previous = await stripe.checkout.sessions.expire(order.session) }
          catch (error) {
            // Checkout may have completed or expired while the switch was in progress.
            previous = await stripe.checkout.sessions.retrieve(order.session)
            if (previous.status === 'open') {
              console.error('Stripe Checkout switch failed:',error.type ?? error.name,error.code ?? '',error.requestId ?? '')
              throw billingError('Stripe could not switch plans. Please try again shortly.',503)
            }
          }
        }
        if (previous.status !== 'expired') throw billingError('Your checkout is awaiting payment confirmation.')
        db.release(order.ref,order.session)
        order = db.reserve(guild,owner,plan,randomUUID(),prices[plan],Math.floor(Date.now()/1000)+3600)
      }
      if (order.plan !== plan) throw billingError('A checkout for another plan is already pending.')
      const session = await stripe.checkout.sessions.create({
        managed_payments:{enabled:false},
        mode:'subscription',billing_address_collection:'auto',client_reference_id:order.ref,
        integration_identifier:'blackridge_jmxtwqfz',line_items:[{price:order.price,quantity:1}],
        subscription_data:{billing_mode:{type:'flexible'}},
        expires_at:order.expires,success_url:back(guild)+'?billing=processing',cancel_url:back(guild)
      },{idempotencyKey:'blackridge-direct-checkout-'+order.ref}).catch(error => {
        console.error('Stripe Checkout failed:',error.type ?? error.name,error.code ?? '',error.requestId ?? '')
        throw billingError('Stripe could not start checkout. Please try again shortly.',503)
      })
      db.remember(order.ref,session.id)
      if (!session.url) throw billingError('Checkout is awaiting payment confirmation.')
      return session.url
    })
  }
  async function portal(guild,owner,action) {
    check()
    const row = db.current(guild)
    if (!row || row.owner !== owner) throw billingError('Only the billing owner can manage this subscription.',403)
    if (!['manage','upgrade','cancel'].includes(action)) throw billingError('Invalid billing action.',400)
    const params = {customer:row.customer,configuration:env.STRIPE_PORTAL_CONFIGURATION,return_url:back(guild)}
    if (action === 'cancel') params.flow_data = {type:'subscription_cancel',subscription_cancel:{subscription:row.id}}
    if (action === 'upgrade') {
      const sub = await stripe.subscriptions.retrieve(row.id)
      const item = sub.items.data[0]
      if (sub.status !== 'active' || sub.items.data.length !== 1 || item.price.id !== prices.premium || row.risk)
        throw billingError('Only an active Premium subscription can be upgraded.')
      params.flow_data = {type:'subscription_update_confirm',subscription_update_confirm:{
        subscription:row.id,items:[{id:item.id,price:prices.custom,quantity:1}]
      }}
    }
    return (await stripe.billingPortal.sessions.create(params)).url
  }
  async function webhook(body,signature) {
    check()
    let event
    try { event = stripe.webhooks.constructEvent(body,signature,env.STRIPE_WEBHOOK_SECRET) }
    catch { throw billingError('Invalid webhook signature.',400) }
    if (event.livemode !== live) throw billingError('Unexpected Stripe mode.',400)
    const object = event.data.object
    if (event.type.startsWith('checkout.session.')) {
      if (object.mode !== 'subscription' || !object.client_reference_id) return
      if (event.type === 'checkout.session.expired') return db.release(object.client_reference_id,object.id)
      const id = objectId(object.subscription)
      const customer = objectId(object.customer)
      if (!id || !customer) return
      return serialized(id,async () => {
        db.attach(object.client_reference_id,object.id,id,customer)
        if (object.payment_status === 'paid') await sync(id)
      })
    }
    if (event.type.startsWith('customer.subscription.') || ['invoice.paid','invoice.payment_failed'].includes(event.type)) {
      const id = event.type.startsWith('customer.subscription.') ? object.id : invoiceSubscription(object)
      if (id) await serialized(id,() => sync(id))
      return
    }
    if (!['charge.refunded','charge.dispute.created','radar.early_fraud_warning.created'].includes(event.type)) return
    if (event.type === 'charge.refunded' && !object.refunded) return
    const intent = objectId(object.payment_intent)
    if (!intent) return
    for await (const payment of stripe.invoicePayments.list({payment:{type:'payment_intent',payment_intent:intent}})) {
      const invoice = await stripe.invoices.retrieve(objectId(payment.invoice))
      const id = invoiceSubscription(invoice)
      if (id) await serialized(id,() => db.flag(id,event.type))
    }
  }
  return {enabled,checkout,portal,webhook,refresh:id => serialized(id,() => { check(); return sync(id) })}
}

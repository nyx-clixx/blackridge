const crown = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linejoin="round" aria-hidden="true"><path d="m3 6 4 4 5-6 5 6 4-4-2 12H5L3 6Zm3 15h12"/></svg>'
export const planName = plan => plan === 'custom' ? 'Custom Bot' : 'Premium'
export function premiumPlans(plans = [],billing = {}) {
  const features = ['Advanced Auto Moderation','Advanced Anti-Nuke','Server Backups']
  return '<div class="grid pricing">' + [
    ['premium','blue','$2.99',features],
    ['custom','custom','$4.99',[...features,'Custom Bot']]
  ].map(([plan,theme,price,items]) => {
    const purchase = billing.enabled && billing.purchasable ? '<button class="button plan-purchase" type="button" data-checkout="' + plan + '">Subscribe</button>' : ''
    const upgrade = billing.enabled && plan === 'custom' && billing.subscription?.plan === 'premium' && billing.subscription.status === 'active' && !billing.subscription.review
      ? '<button class="button plan-purchase" type="button" data-portal="upgrade">Upgrade to Custom Bot</button>' : ''
    return '<article class="card plan plan-' + theme + '"><span class="icon-tile">' + crown + '</span><h3>Blackridge ' + planName(plan) + '</h3><strong>' + price + '<small> / month</small></strong><ul>' +
      items.map(item => '<li>' + item + '</li>').join('') + '</ul>' + purchase + upgrade +
      (plans.includes(plan) ? '<span class="badge">Your Current Active Plan</span>' : '') + '</article>'
  }).join('') + '</div>'
}

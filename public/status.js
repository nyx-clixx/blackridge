export function wireStatus(request) {
  const target = document.querySelector('#service-status')
  if (!target) return
  const number = value => value === null ? 'Unavailable' : value.toLocaleString()
  const refresh = async () => {
    try {
      const data = await request('/api/status')
      const state = data.connected ? 'Connected to Discord' : 'Discord Connection Unavailable'
      const uptime = Math.floor(data.uptime / 3600) + 'h ' + Math.floor(data.uptime % 3600 / 60) + 'm'
      const cards = [['Servers',number(data.servers)],['Members',number(data.members)],['Service Uptime',uptime],['Gateway Latency',data.latency === null ? 'Unavailable' : data.latency + ' ms']]
      target.innerHTML = '<section class="status-banner ' + (data.connected ? 'healthy' : 'degraded') + '"><div><span class="status-dot"></span><h2>' + state + '</h2></div><p>Updated ' + new Date(data.checkedAt).toLocaleTimeString() + '</p><div class="status-track" aria-hidden="true"></div></section>' +
        '<div class="status-metrics">' + cards.map(([label,value]) => '<article><p>' + label + '</p><strong>' + value + '</strong></article>').join('') + '</div>' +
        '<section class="status-services"><h2>Services</h2>' +
        [['Blackridge Website',data.dashboard],['Blackridge Bot',data.connected],['Blackridge Custom Bots',data.customBotsAvailable]].map(([name,available]) =>
          '<div><span>' + name + '</span><span class="' + (available ? 'healthy-label' : 'unavailable-label') + '">' + (available ? 'Available' : 'Unavailable') + '</span></div>').join('') + '</section>'
    } catch {
      target.innerHTML = '<section class="status-banner degraded"><h2>Status Could Not Be Retrieved</h2><p>Retrying automatically. Service health is currently unknown.</p></section>'
    }
  }
  void refresh()
  const timer = setInterval(() => { if (!document.hidden) void refresh() },30000)
  window.addEventListener('pagehide',() => clearInterval(timer),{once:true})
}

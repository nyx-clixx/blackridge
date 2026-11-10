export function wireStatus(request) {
  const target = document.querySelector('#service-status')
  if (!target) return
  const number = value => value === null ? 'Unavailable' : value.toLocaleString()
  const refresh = async () => {
    try {
      const data = await request('/api/status')
      const state = data.connected ? 'Connected to Discord' : 'Discord Connection Unavailable'
      const uptime = Math.floor(data.uptime / 3600) + 'h ' + Math.floor(data.uptime % 3600 / 60) + 'm'
      const cards = [['Servers',number(data.servers),'Shared Blackridge bot'],['Members',number(data.members),'Memberships across connected servers'],['Service Uptime',uptime,'Since the current process started'],['Gateway Latency',data.latency === null ? 'Unavailable' : data.latency + ' ms','Discord heartbeat round trip']]
      target.innerHTML = '<section class="status-banner ' + (data.connected ? 'healthy' : 'degraded') + '"><div><span class="status-dot"></span><h2>' + state + '</h2></div><p>Updated ' + new Date(data.checkedAt).toLocaleTimeString() + '</p><div class="status-track" aria-hidden="true"></div></section>' +
        '<div class="status-metrics">' + cards.map(([label,value,description]) => '<article><p>' + label + '</p><strong>' + value + '</strong><small>' + description + '</small></article>').join('') + '</div>' +
        '<section class="status-services"><h2>Services</h2><div><span>Website and Dashboard</span><span class="healthy-label">Available</span></div><div><span>Discord Gateway</span><span>' + (data.connected ? 'Connected' : 'Unavailable') + '</span></div></section>'
    } catch {
      target.innerHTML = '<section class="status-banner degraded"><h2>Status Could Not Be Retrieved</h2><p>Retrying automatically. Service health is currently unknown.</p></section>'
    }
  }
  void refresh()
  const timer = setInterval(() => { if (!document.hidden) void refresh() },30000)
  window.addEventListener('pagehide',() => clearInterval(timer),{once:true})
}

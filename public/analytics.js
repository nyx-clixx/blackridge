const metrics = {messages:'Messages',joins:'Joins',leaves:'Leaves'}
const number = new Intl.NumberFormat()
const date = new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',timeZone:'UTC'})
const day = 86400000

export function analyticsPanel() {
  return '<section class="server-analytics" aria-label="Weekly server analytics" aria-busy="true">' +
    '<div class="analytics-metrics">' + Object.entries(metrics).map(([key,label]) =>
      '<article class="card analytics-metric" data-metric="' + key + '"><div class="analytics-copy"><h3>' +
      label + '</h3><strong>—</strong><p>Last 7 days</p></div><div class="analytics-spark"></div></article>').join('') +
    '</div><p class="analytics-note" role="status">Loading weekly activity…</p></section>'
}

function sparkline(rows,key) {
  const width = 280
  const height = 56
  const scale = Math.max(1,...rows.map(row => row[key]))
  const points = rows.map((row,index) => [rows.length === 1 ? width/2 : width*index/(rows.length-1),48-36*row[key]/scale])
  const curve = points.reduce((path,[x,y],index) => {
    if (!index) return 'M ' + x + ' ' + y
    const [previousX,previousY] = points[index-1]
    const middle = (previousX+x)/2
    return path + ' C ' + middle + ' ' + previousY + ', ' + middle + ' ' + y + ', ' + x + ' ' + y
  },'')
  const [firstX] = points[0]
  return '<svg viewBox="0 0 '+width+' '+height+'" preserveAspectRatio="none" aria-hidden="true">' +
    '<defs><linearGradient id="fill-'+key+'" x2="0%" y2="100%"><stop stop-color="currentColor" stop-opacity=".23"/>' +
    '<stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>' +
    (points.length === 1 ? '<circle cx="'+firstX+'" cy="'+points[0][1]+'" r="3" fill="currentColor"/>' :
      '<path d="'+curve+' V '+height+' H '+firstX+' Z" fill="url(#fill-'+key+')"/><path d="'+curve+'" class="analytics-series"/>') + '</svg>' +
    '<span class="visually-hidden">Daily counts in UTC. ' + rows.map(row => date.format(row.at)+': '+number.format(row[key])).join('. ') + '.</span>'
}

export async function wireAnalytics(panel,path,request) {
  const note = panel.querySelector('.analytics-note')
  try {
    const {since,buckets} = await request(path + '/analytics?period=week')
    const rows = since == null ? [] : buckets.filter(row => row.at+day > since)
    for (const card of panel.querySelectorAll('[data-metric]')) {
      const key = card.dataset.metric
      if (!rows.length) continue
      card.querySelector('strong').textContent = number.format(rows.reduce((total,row) => total+row[key],0))
      if (rows.length < 7) card.querySelector('p').textContent = 'Since ' + date.format(since)
      card.querySelector('.analytics-spark').innerHTML = sparkline(rows,key)
    }
    note.textContent = rows.length ? '' :
      'Weekly activity will appear once Blackridge starts tracking this server.'
  } catch {
    note.textContent = 'Weekly analytics are temporarily unavailable.'
  } finally {
    panel.setAttribute('aria-busy','false')
  }
}

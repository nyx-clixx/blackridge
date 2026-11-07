const metrics = {messages:'Messages',joins:'Joins',leaves:'Leaves'}
const periods = {day:'Day',week:'Week',month:'Month',year:'Year'}
const formatNumber = new Intl.NumberFormat()
const formattedDate = (at,period) => new Intl.DateTimeFormat(undefined,{
  timeZone:'UTC',...(period === 'day' ? {hour:'numeric',minute:'2-digit'} : period === 'year' ? {month:'short',year:'numeric'} : {month:'short',day:'numeric'})
}).format(at)

export function analyticsPanel() {
  return '<section class="card server-analytics" aria-labelledby="server-analytics-title">' +
    '<div class="analytics-heading"><h3 id="server-analytics-title">Server Analytics</h3><div class="analytics-periods" role="group" aria-label="Analytics period">' +
    Object.entries(periods).map(([key,label]) => '<button class="button small" type="button" data-analytics-period="' + key +
      '" aria-pressed="' + (key === 'week') + '">' + label + '</button>').join('') + '</div></div>' +
    '<div class="analytics-chart" aria-busy="true"><p>Loading analytics…</p></div>' +
    '<div class="analytics-metrics" role="group" aria-label="Analytics metric">' + Object.entries(metrics).map(([key,label]) =>
      '<button type="button" class="analytics-metric" data-analytics-metric="' + key + '" aria-pressed="' + (key === 'messages') +
      '"><span>' + label + '</span><strong>—</strong><svg viewBox="0 0 160 34" preserveAspectRatio="none" aria-hidden="true"><polyline/></svg></button>').join('') +
    '</div><p class="analytics-note">UTC · Messages from channels Blackridge can see. Leaves include kicks and bans.</p></section>'
}

function linePoints(buckets,key,width,height,scale) {
  return buckets.map((row,index) => {
    const x = buckets.length === 1 ? width/2 : index*width/(buckets.length-1)
    return [x,height-row[key]*height/scale]
  })
}

export function wireAnalytics(panel,path,request) {
  const chart = panel.querySelector('.analytics-chart')
  const periodButtons = [...panel.querySelectorAll('[data-analytics-period]')]
  const metricButtons = [...panel.querySelectorAll('[data-analytics-metric]')]
  let period = 'week'
  let metric = 'messages'
  let data
  let controller
  function select(buttons,attribute,key) {
    for (const button of buttons) button.setAttribute('aria-pressed',String(button.dataset[attribute] === key))
  }
  function show() {
    const buckets = data.since == null ? [] : data.buckets.filter((row,index) =>
      (data.buckets[index+1]?.at ?? Infinity) > data.since)
    const name = metrics[metric]
    for (const button of metricButtons) {
      const key = button.dataset.analyticsMetric
      const total = buckets.reduce((count,row) => count + row[key],0)
      const max = Math.max(1,...buckets.map(row => row[key]))
      button.querySelector('strong').textContent = buckets.length ? formatNumber.format(total) : '—'
      button.querySelector('polyline').setAttribute('points',linePoints(buckets,key,160,29,max).map(pair => pair.join(',')).join(' '))
    }
    if (!buckets.length) {
      chart.innerHTML = '<p class="analytics-empty">Analytics will appear once Blackridge starts tracking this server.</p>'
      return
    }
    const width = 780
    const height = 138
    const peak = Math.max(1,...buckets.map(row => row[metric]))
    const scale = Math.ceil(peak/4)*4
    const points = linePoints(buckets,metric,width,height,scale)
    const pathPoints = points.map(pair => pair.join(',')).join(' ')
    const axis = [scale,scale*.75,scale*.5,scale*.25,0]
    chart.innerHTML = '<div class="analytics-chart-head"><div><h4>' + name + '</h4><strong>' +
      formatNumber.format(buckets.reduce((count,row) => count+row[metric],0)) +
      '</strong></div><p class="analytics-point-readout" aria-live="polite"></p></div>' +
      '<div class="analytics-plot"><div class="analytics-axis" aria-hidden="true">' + axis.map(number => '<span>'+formatNumber.format(number)+'</span>').join('') +
      '</div><div class="analytics-interaction" tabindex="0" role="group" aria-label="' + name + ' chart. Use left and right arrows to inspect values.">' +
      '<svg viewBox="0 -5 ' + width + ' ' + (height+10) + '" preserveAspectRatio="none" aria-hidden="true">' +
      axis.map((_,index) => '<line class="analytics-grid-line" x1="0" x2="' + width + '" y1="' + index*height/4 + '" y2="' + index*height/4 + '"/>').join('') +
      '<polyline class="analytics-series" points="' + pathPoints + '"/><line class="analytics-guide" y1="0" y2="' + height + '"/><circle class="analytics-marker" r="3"/></svg>' +
      '<div class="analytics-dates" aria-hidden="true"><span>' + formattedDate(buckets[0].at,period) + '</span><span>' +
      formattedDate(buckets.at(-1).at,period) + '</span></div></div></div>' +
      '<details class="analytics-table"><summary>View counts</summary><table class="event-table"><thead><tr><th scope="col">UTC</th><th scope="col">' + name +
      '</th></tr></thead><tbody>' + buckets.map(row => '<tr><th scope="row">' + formattedDate(row.at,period) + '</th><td>' +
      formatNumber.format(row[metric]) + '</td></tr>').join('') + '</tbody></table></details>'
    const interaction = chart.querySelector('.analytics-interaction')
    const plot = interaction.querySelector('svg')
    const guide = plot.querySelector('.analytics-guide')
    const marker = plot.querySelector('.analytics-marker')
    const readout = chart.querySelector('.analytics-point-readout')
    let selected = -1
    function move(index) {
      index = Math.max(0,Math.min(points.length-1,index))
      if (index === selected) return
      selected = index
      const [x,y] = points[index]
      guide.setAttribute('x1',x)
      guide.setAttribute('x2',x)
      marker.setAttribute('cx',x)
      marker.setAttribute('cy',y)
      readout.textContent = formattedDate(buckets[index].at,period) + ' · ' + formatNumber.format(buckets[index][metric])
    }
    function point(event) {
      const rect = plot.getBoundingClientRect()
      move(Math.round((event.clientX-rect.left)/rect.width*(points.length-1)))
    }
    plot.addEventListener('pointermove',point)
    plot.addEventListener('pointerdown',point)
    interaction.addEventListener('keydown',event => {
      const index = {ArrowLeft:selected-1,ArrowRight:selected+1,Home:0,End:points.length-1}[event.key]
      if (index === undefined) return
      event.preventDefault()
      move(index)
    })
    move(points.length-1)
  }
  async function refresh() {
    controller?.abort()
    const current = new AbortController()
    controller = current
    data = null
    chart.setAttribute('aria-busy','true')
    chart.innerHTML = '<p>Loading analytics…</p>'
    for (const button of metricButtons) {
      button.querySelector('strong').textContent = '—'
      button.querySelector('polyline').removeAttribute('points')
    }
    try {
      const result = await request(path + '/analytics?period=' + period,{signal:current.signal})
      if (current.signal.aborted) return
      data = result
      show()
    } catch {
      if (!current.signal.aborted) chart.innerHTML = '<p role="status">Server analytics are temporarily unavailable.</p>'
    } finally {
      if (!current.signal.aborted) chart.setAttribute('aria-busy','false')
    }
  }
  for (const button of periodButtons) button.onclick = () => {
    period = button.dataset.analyticsPeriod
    select(periodButtons,'analyticsPeriod',period)
    void refresh()
  }
  for (const button of metricButtons) button.onclick = () => {
    metric = button.dataset.analyticsMetric
    select(metricButtons,'analyticsMetric',metric)
    if (data) show()
  }
  void refresh()
}

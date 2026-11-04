const sources = {
  base:'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts',
  adult:'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn/hosts',
  phishing:'https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/phishing-domains-ACTIVE.txt'
}
const lists = {nsfw:new Set(),malicious:new Set()}
const hostPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
async function loadDomains(url,hostsFile) {
  const response = await fetch(url,{signal:AbortSignal.timeout(25000),redirect:'error'})
  if (!response.ok) throw new Error('Feed HTTP ' + response.status)
  const decoder = new TextDecoder()
  let body = ''
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.byteLength
    if (bytes > 24*1024*1024) throw new Error('Feed size limit exceeded')
    body += decoder.decode(chunk,{stream:true})
  }
  body += decoder.decode()
  const domains = new Set()
  for (const line of body.split('\n')) {
    const host = (hostsFile ? line.match(/^0\.0\.0\.0\s+(\S+)/)?.[1] : line.trim())?.toLowerCase()
    if (host && hostPattern.test(host)) domains.add(host)
  }
  if (domains.size < 100) throw new Error('Feed contained too few domains')
  return domains
}
export function onDomainList(kind,hostname) {
  const labels = hostname.split('.')
  for (let index=0; index<labels.length-1; index++) {
    if (lists[kind].has(labels.slice(index).join('.'))) return true
  }
  return false
}
export function startDomainFeeds() {
  let active = false
  const refresh = async () => {
    if (active) return
    active = true
    try {
      const [adult,phishing] = await Promise.allSettled([
        Promise.all([loadDomains(sources.base,true),loadDomains(sources.adult,true)]),
        loadDomains(sources.phishing,false)
      ])
      if (adult.status === 'fulfilled') {
        const [base,combined] = adult.value
        for (const host of base) combined.delete(host)
        if (combined.size >= 100) {
          lists.nsfw = combined
          console.log('NSFW domain feed loaded:',combined.size)
        } else console.error('NSFW domain feed had too few distinct entries')
      } else console.error('NSFW domain feed unavailable')
      if (phishing.status === 'fulfilled') {
        lists.malicious = phishing.value
        console.log('Phishing domain feed loaded:',lists.malicious.size)
      } else console.error('Phishing domain feed unavailable')
    } finally { active = false }
  }
  void refresh()
  setInterval(refresh,6*3600000).unref()
}

export function documentationLayout(html) {
  const sections = [...html.matchAll(/<section class="card stack"([^>]*)><h3>([^<]+)<\/h3>([\s\S]*?)<\/section>/g)].map(([,attributes,title,body]) => ({
    id:attributes.match(/id="([^"]+)"/)?.[1] ?? title.toLowerCase().replace(/[^a-z0-9]+/g,'-'),
    title,body
  }))
  sections.unshift({id:'introduction',title:'Introduction',body:
    '<p>Blackridge brings Discord server protection and moderation into one dashboard. Choose the modules your community needs, configure each response, and review activity in your staff channels.</p>' +
    '<h3 id="guides">Guides</h3><div class="docs-guides">' +
    [['getting-started','Set Up Blackridge','Invite the bot, arrange roles, and configure your first protection.'],['protection-modules','Security Setup','Configure Anti-Nuke, Anti-Raid, Checkpoint, and Auto Moderation.'],['moderation-and-recovery','Permissions and Recovery','Delegate command access and prepare server recovery.'],['custom-bot-setup','Custom Bot Setup','Connect your own Discord application.']].map(([id,title,description]) =>
      '<a class="docs-guide" href="#' + id + '"><span aria-hidden="true">◇</span><h3>' + title + '</h3><p>' + description + '</p></a>').join('') + '</div>'})
  const groups = [
    ['Overview',[['introduction','overview'],['getting-started','server'],['plans-and-custom-bot','premium'],['manage-a-subscription','premium'],['custom-bot-setup','custom'],['server-analytics','overview']]],
    ['Protection',[['anti-raid','raid'],['anti-nuke','nuke'],['rename-and-deletion-protection','nuke'],['lockdown','lockdown'],['delete-all-invites','lockdown'],['honeypot','honeypot'],['verification','verification'],['checkpoint','checkpoint'],['auto-moderation','automod']]],
    ['Administration',[['permits','permits'],['logging','logging'],['moderation-commands','moderation'],['ban-appeals','appeals'],['report-system','reports'],['server-backups','backup']]]
  ]
  const split = (id,ids) => {
    const parent = sections.find(section => section.id === id)
    if (!parent) return
    const guides = [...parent.body.matchAll(/<li><strong>([^<]+)<\/strong>([\s\S]*?)<\/li>/g)]
      .filter(([,title]) => ids.includes(title.toLowerCase().replaceAll(' ','-')))
      .map(([,title,body]) => ({id:title.toLowerCase().replaceAll(' ','-'),title,body:'<p>'+title+body+'</p>'}))
    sections.push(...guides)
    if (guides.length) parent.body = '<ul>'+guides.map(guide => '<li><a href="#'+guide.id+'">'+guide.title+'</a></li>').join('')+'</ul>'
  }
  split('protection-modules',['anti-nuke','anti-raid','checkpoint','auto-moderation'])
  split('moderation-and-recovery',['permits','lockdown','server-backups'])
  const navigation = groups.map(([label,items]) => '<div class="docs-nav-group"><p>'+label+'</p>'+items.map(([id,icon]) => {
    const section = sections.find(item => item.id === id)
    return section ? '<a href="#'+id+'"><span data-icon="'+icon+'" aria-hidden="true"></span>'+section.title+'</a>' : ''
  }).join('')+'</div>').join('')
  return '<div class="docs-layout"><nav class="docs-nav" aria-label="Documentation sections">' +
    navigation +
    '</nav><article class="docs-content">' + sections.map(section =>
      '<section class="docs-article" id="' + section.id + '"><p class="docs-eyebrow">Documentation</p><h1>' + section.title + '</h1>' + section.body + '</section>').join('') +
    '</article><aside class="docs-toc"><strong>On This Page</strong><a href="#introduction">Introduction</a><a href="#getting-started">Bot Setup</a><a href="/support">Support Server</a></aside></div>'
}

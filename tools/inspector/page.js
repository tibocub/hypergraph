// The inspector's page: reads the JSON views and draws them. Read-only: it
// only ever sends GET requests.

const state = { space: null, tab: 'overview', type: null, pages: [null], page: 0, instance: null, allRows: false }
const $ = (sel) => document.querySelector(sel)

// --- small helpers ---

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const short = (k) => k ? `${k.slice(0, 6)}…${k.slice(-4)}` : '—'
const keyHtml = (k, label) => k ? `<span class="key" title="${esc(label ? label + ': ' : '')}${esc(k)}">${esc(short(k))}</span>` : '<span class="muted">—</span>'
const tip = (text, help) => `<span title="${esc(help)}">${text}</span>`
const yes = (b) => b ? 'yes' : 'no'
const isRecordId = (v) => typeof v === 'string' && /^[ybndrfg8ejkmcpqxot1uwisza345h769]{53,}$/.test(v)

function bytes (n) {
  if (n === null || n === undefined) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++ }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}

function when (ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  const today = d.toDateString() === new Date().toDateString()
  return `<span title="${esc(d.toLocaleString())}">${today ? d.toLocaleTimeString() : d.toLocaleDateString()}</span>`
}

// Replaces an element's HTML only when it changed (keeps hovers and scroll).
function setHtml (el, html) {
  if (el._html === html) return false
  el._html = html
  el.innerHTML = html
  return true
}

async function get (path) {
  const res = await fetch(path, { cache: 'no-store' })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error || res.statusText)
  return body
}

// Who someone is, in words: "you", or the short key.
function who (identity) {
  if (state.instance && identity === state.instance.identity) return `<b title="This person (the identity running this app): ${esc(identity)}">you</b>`
  return keyHtml(identity, 'identity')
}

function deviceName (device) {
  if (!state.instance) return keyHtml(device, 'device')
  const d = state.instance.devices.find((x) => x.publicKey === device)
  if (d) return `<span title="One of your devices: ${esc(device)}">${esc(d.name || 'this device')}${d.current ? ' (this one)' : ''}</span>`
  return keyHtml(device, 'device')
}

// --- the left column ---

async function drawInstance () {
  const i = state.instance = await get('api/instance')
  const s = i.storage
  const pct = s.budget ? Math.min(100, Math.round(100 * s.used / s.budget)) : 0
  setHtml($('#instance'), `
    <h2 title="This running app: the person (identity) and the device it runs on.">This app</h2>
    <dl class="facts">
      <dt>${tip('Person', 'The identity: the same on all of this person\'s devices. Others see it as the author of their records.')}</dt><dd>${keyHtml(i.identity, 'identity')}</dd>
      <dt>${tip('Device', 'This device\'s own key. Each device writes its own log.')}</dt><dd>${deviceName(i.device)}</dd>
      <dt>${tip('Devices', 'All the devices of this person (removed ones left out).')}</dt><dd>${i.devices.map((d) => esc(d.name || short(d.publicKey)) + (d.current ? ' <span class="muted">(this one)</span>' : '')).join(', ') || '—'}</dd>
      <dt>${tip('Disk', 'What the app stores on this device (an estimate) out of its budget: the room it may use. Past it, the oldest content of others is dropped and fetched back when needed.')}</dt>
      <dd>${bytes(s.used)} of ${bytes(s.budget)}<div class="bar" title="${pct}% of the budget"><i style="width:${pct}%"></i></div></dd>
      <dt>${tip('Free disk', 'Free space on the disk holding the app\'s folder.')}</dt><dd>${bytes(s.free)}</dd>
    </dl>`)
}

async function drawSpaces () {
  const spaces = await get('api/spaces')
  if (!state.space && spaces.length > 1) state.space = spaces[1].key
  if (!state.space) state.space = spaces[0].key
  setHtml($('#spaces'), spaces.map((s) => `
    <li data-key="${esc(s.key)}" class="${s.key === state.space ? 'on' : ''}">
      <div class="name">${s.parent ? '<span class="muted" title="A sub-space: inside another space, with its members and roles.">↳ </span>' : ''}${esc(s.name || '(no name)')}${s.personal ? ' <span class="badge" title="Only this person\'s devices share it. Nobody else can find or read it.">private</span>' : ''}${s.private ? ' <span class="badge" title="Its content is sealed: only the people let in (and the parent\'s owner and admins) read it.">private</span>' : ''}</div>
      <div class="sub">
        ${s.complete ? '<span class="ok" title="Every block this device knows of is here, and it reached another member (or it is the only one).">complete</span>' : '<span class="warn" title="Some data this device knows exists is not here yet, or it has not reached any other member since it opened. Reads say complete: false.">not complete</span>'}
        · ${tip(`${s.peers} peer${s.peers === 1 ? '' : 's'}`, 'Other devices connected right now for this space.')}
        · ${tip(`${s.members} member${s.members === 1 ? '' : 's'}`, 'People whose writing this device has seen (or will accept).')}
        · ${tip(`${s.records} rows`, 'Records in this device\'s index, every type, shown or not.')}
        ${s.warnings.length ? `· <span class="warn" title="${esc(s.warnings.map((w) => w.message).join('\n'))}">⚠ ${s.warnings.length}</span>` : ''}
      </div>
    </li>`).join(''))
  for (const li of document.querySelectorAll('#spaces li')) {
    li.onclick = () => { state.space = li.dataset.key; state.type = null; state.pages = [null]; state.page = 0; refresh() }
  }
}

// --- one space ---

const TABS = [
  ['overview', 'Overview', 'What this space is and how this device holds it.'],
  ['members', 'Members & roles', 'Who is in, what they may do.'],
  ['decisions', 'Decisions', 'The shared log of roles, invites and moderation every member applies in the same order.'],
  ['logs', 'Device logs', 'Each device of each member writes its own append-only log. This is how much of each this device has.'],
  ['records', 'Records', 'The data itself, by type.']
]

async function drawSpace () {
  const s = await get('api/space?key=' + encodeURIComponent(state.space))
  const tabs = `<div class="tabs">${TABS.map(([id, label, help]) => `<button data-tab="${id}" class="${state.tab === id ? 'on' : ''}" title="${esc(help)}">${label}</button>`).join('')}</div>`
  const title = `<h2>${esc(s.personal ? 'Personal space' : s.name || '(no name)')} ${keyHtml(s.key, 'space key')}</h2>`
  const body = await ({ overview, members, decisions, logs, records })[state.tab](s)
  setHtml($('#view'), title + tabs + body)
  for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => { state.tab = b.dataset.tab; refresh() }
  wireRecords(s)
}

function overview (s) {
  const st = s.storage
  const share = st.share ? Math.min(100, Math.round(100 * st.stored / st.share)) : 0
  const total = Object.values(s.records).reduce((a, b) => a + b, 0)
  return `
    ${s.warnings.map((w) => `<div class="warning"><b>${esc(w.code)}</b>: ${esc(w.message)}</div>`).join('')}
    <dl class="facts">
      ${s.parent ? `<dt>${tip('Inside', 'A sub-space of another space: that space\'s members and roles count here, then its own; a ban there applies here.')}</dt><dd>${keyHtml(s.parent, 'parent space')}</dd>` : ''}
      ${s.subspaces && s.subspaces.length ? `<dt>${tip('Sub-spaces', 'Spaces inside this one (sub-forums, folders with their own rules). Its members have them without joining; private ones only who is let in.')}</dt><dd>${s.subspaces.map((x) => esc(x.name || '(no name)') + (x.private ? ' <span class="chip">private</span>' : '')).join(', ')}</dd>` : ''}
      ${s.private ? `<dt>${tip('Private', 'Content is sealed with a key that changes when someone loses access (the epoch counts the changes). Readable: this device holds the current key. Keys are never shown.')}</dt><dd>key epoch ${s.epoch === null ? '—' : s.epoch} · ${s.readable ? '<span class="ok">readable here</span>' : '<span class="warn">not readable here (no key)</span>'}</dd>` : ''}
      <dt>${tip('Complete', 'Yes when every block this device knows exists is held here, and it reached another member since it opened (or it is the only one). When not, reads answer with what is here and say complete: false.')}</dt>
      <dd>${s.complete ? '<span class="ok">yes</span>' : '<span class="warn">not yet</span>'}</dd>
      <dt>${tip('Peers', 'Other devices connected right now for this space: the person and the device.')}</dt>
      <dd>${s.peerList.length ? s.peerList.map((p) => `${p.identity ? who(p.identity) : '<span class="muted">someone</span>'} <span class="muted">on</span> ${deviceName(p.device)}`).join('<br>') : '0'}</dd>
      <dt>${tip('Policy', '"auto": each member keeps what fits its budget, the newest part first. "everything": members are asked to keep it all (an archive).')}</dt><dd>${esc(st.policy)}</dd>
      <dt>${tip('Held here', '"all": every record\'s content is on this device. "part": some old content of others was dropped to stay within the budget; it is fetched back when a read needs it.')}</dt><dd>${esc(st.held)}</dd>
      <dt>${tip('Stored', 'Bytes this space takes on this device (an estimate).')}</dt><dd>${bytes(st.stored)}</dd>
      <dt>${tip('Share', 'The room this space may use here: its own budget, or its part of the app\'s budget. Empty until the first budget pass.')}</dt>
      <dd>${st.share === null ? '<span class="muted">not computed yet</span>' : `${bytes(st.share)}<div class="bar" title="${share}% used"><i style="width:${share}%"></i></div>`}</dd>
      <dt>${tip('Own budget', 'A budget set for this space alone (setBudget). Empty: it shares the app\'s.')}</dt><dd>${st.budget === null ? '<span class="muted">shares the app\'s</span>' : bytes(st.budget)}</dd>
      <dt>${tip('Below policy', 'The space asks to keep everything and this device can\'t (not enough room).')}</dt><dd>${yes(st.belowPolicy)}</dd>
      <dt>${tip('Rows', 'Records in this device\'s index, every type, shown or not (hidden, deleted and older versions included).')}</dt><dd>${total}</dd>
      <dt>${tip('Device logs', 'Logs this device knows of in the space (one per device of each member).')}</dt><dd>${s.logs.length}</dd>
      <dt>${tip('Decisions', 'Entries in the shared decision log (the log’s own acknowledgements included; the Decisions tab lists the decisions).')}</dt><dd>${s.decisions.length}</dd>
    </dl>`
}

function members (s) {
  if (s.personal) return '<p class="help">The personal space has no roles: only this person\'s devices are in it.</p>' + memberTable(s)
  return `
    <p class="help">The members with their role here, then people banned or removed: what they wrote before stays, nothing after counts.</p>
    ${memberTable(s)}
    <h3 title="What each role may do. Built-in roles first, highest first; then the roles this space defined.">Roles</h3>
    <div class="table-wrap"><table>
      <tr><th>Role</th><th>May</th><th>Kind</th></tr>
      ${s.roles.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.permissions.map((p) => `<span class="chip" title="${esc(PERMS[p] || 'A permission this app defined')}">${esc(p)}</span>`).join('')}</td><td class="muted">${r.custom ? 'defined by this space' : 'built-in'}</td></tr>`).join('')}
    </table></div>`
}

const PERMS = {
  post: 'Write records.',
  moderate: 'Hide, reveal, flag and take down records; ban people.',
  invite: 'Make invite links.',
  roles: 'Give and define roles.',
  decide: 'Record decisions others apply (roles, invites, moderation).'
}

function memberTable (s) {
  return `<div class="table-wrap"><table>
    <tr><th>Person</th><th>${tip('Role', 'Their role in this space; banned or removed: no longer a member.')}</th><th>${tip('Devices', 'The devices this person writes from, here.')}</th><th>${tip('Decides', 'Their devices may record decisions (owner, admins, moderators). A settler also settles the order of decisions.')}</th></tr>
    ${s.members.map((m) => `<tr>
      <td>${who(m.identity)}</td>
      <td>${s.personal ? '<span class="muted">—</span>' : m.role ? esc(m.role) : m.banned ? '<span class="chip bad" title="Banned: not let back in until unbanned.">banned</span>' : m.removed ? '<span class="chip bad" title="Taken out of the space.">removed</span>' : '<span class="chip bad">out</span>'}</td>
      <td>${m.devices.map((d) => `${d.name ? esc(d.name) : keyHtml(d.device, 'device')}${d.cut !== null ? ` <span class="chip bad" title="Cut at block ${d.cut}: nothing this device wrote after counts.">cut</span>` : ''}${d.refused ? ' <span class="chip bad" title="Not kept: refused for good.">refused</span>' : ''}${d.waiting ? ' <span class="chip warn" title="Not kept yet: waiting for its author to become a member.">waiting</span>' : ''}`).join('<br>') || '<span class="muted">nothing written yet</span>'}</td>
      <td>${m.settler ? '<span title="Records decisions and settles their order">settler</span>' : m.decides ? 'yes' : '<span class="muted">no</span>'}</td>
    </tr>`).join('')}
  </table></div>`
}

function decisions (s) {
  const d = s.decisions
  return `
    <p class="help">Roles, invites and moderation are decisions: entries in one shared log that every member applies in the same order. The owner and admins (one device each) are the settlers: they agree on that order. Settled entries are final.</p>
    <dl class="facts">
      <dt>${tip('Entries', 'Entries in the log as far as this device knows, the log’s own acknowledgements included.')}</dt><dd>${d.length}</dd>
      <dt>${tip('Settled', 'Entries whose order the settlers agreed on: final.')}</dt><dd>${d.settled} of ${d.length}</dd>
      <dt>${tip('Settlers', 'Devices that settle the order of decisions. With one only, the space can\'t settle new decisions if it is lost: give the space an admin.')}</dt><dd>${d.settlers.length}</dd>
    </dl>
    <h3 title="Devices that may add decisions to the log.">Who records decisions</h3>
    <div class="table-wrap"><table>
      <tr><th>Person</th><th>Device</th><th>${tip('Settler', 'Also settles the order.')}</th><th>Writer key</th></tr>
      ${d.writers.map((w) => `<tr><td>${who(w.identity)}</td><td>${w.device ? deviceName(w.device) : '<span class="muted">—</span>'}</td><td>${w.settler ? 'yes' : '<span class="muted">no</span>'}</td><td>${keyHtml(w.key, 'decision writer key')}</td></tr>`).join('')}
    </table></div>
    <h3 title="Every decision in the order every member applies it, newest first.">What was decided</h3>
    <div class="table-wrap"><table>
      <tr><th>#</th><th>${tip('When', 'The decider\'s clock when it was made.')}</th><th>Who</th><th>What</th><th>${tip('Why', 'The reason given (moderation).')}</th><th>${tip('Counted', 'no: its author wasn\'t allowed to make it at that point; listed, it changed nothing.')}</th></tr>
      ${s.recent.map((x) => `<tr><td class="num">${x.seq}</td><td>${when(x.at)}</td><td>${x.by ? who(x.by) : '<span class="muted">nobody</span>'}</td><td>${what(x)}</td><td>${esc(x.reason || '')}</td><td>${x.counted ? 'yes' : '<span class="chip bad">no</span>'}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">none</td></tr>'}
    </table></div>
    ${s.recent.length >= 50 ? '<p class="help">The 50 newest (api/decisions?key=…&after=… pages further).</p>' : ''}`
}

// A decision in words.
function what (x) {
  const target = (k) => isRecordId(k) ? `<a class="link" data-open="${esc(k)}">a record</a>` : who(k)
  switch (x.type) {
    case 'space/init': return `created the space “${esc(x.name)}”`
    case 'member/add': return `added ${who(x.identity)}`
    case 'member/remove': return `removed ${who(x.identity)}`
    case 'role/define': return `defined the role <b>${esc(x.name)}</b>: ${(x.permissions || []).map((p) => `<span class="chip">${esc(p)}</span>`).join('')}`
    case 'role/set': return `gave ${who(x.identity)} the role <b>${esc(x.role)}</b>`
    case 'moderate': return `<b>${esc(x.action)}</b> ${target(x.target)}`
    case 'invite/redeem': return `let ${who(x.identity)} in as <b>${esc(x.role)}</b> (an invite by ${who(x.maker)})`
    case 'invite/revoke': return `revoked an invite (${esc(x.role)}) by ${who(x.maker)}`
    case 'settings/set': return [x.policy && `storage policy <b>${esc(x.policy)}</b>`, x.rules && `app rules: ${x.rules.map((r) => `<span class="chip">${esc(r)}</span>`).join('') || 'none'}`].filter(Boolean).join('; ')
    case 'writer/add': return `a device of theirs records decisions ${keyHtml(x.key, 'writer key')}`
    case 'device/remove': return `removed their device ${keyHtml(x.removed, 'device')}`
    case 'subspace/create': return `created the sub-space “${esc(x.name)}”${x.private ? ' (private)' : ''}`
    case 'key/rotate': return `changed the key (epoch ${esc(String(x.epoch))})`
    default: return esc(x.type)
  }
}

function logs (s) {
  return `
    <p class="help">Each device of each member writes its own log of blocks. "Known" is how long this device knows the log is, "held" how many blocks it has, "indexed" how many it has read into its index. All three equal: up to date.</p>
    <div class="table-wrap"><table>
      <tr><th>Person</th><th>Device</th>
        <th class="num">${tip('Known', 'Blocks this device knows exist in that log.')}</th>
        <th class="num">${tip('Held', 'Blocks held on this device.')}</th>
        <th class="num">${tip('Indexed', 'Blocks read into the index (everything below is done).')}</th>
        <th class="num">${tip('Dropped', 'Records whose content was dropped here to stay within the budget (fetched back when needed).')}</th>
        <th>${tip('State', 'cut: a ban or removal stopped it at that block. refused: not kept, for good. waiting: not kept until its author becomes a member.')}</th></tr>
      ${s.logs.map((l) => `<tr>
        <td>${l.identity ? who(l.identity) : '<span class="muted">unknown</span>'}${l.own ? ' <span class="badge" title="The log this device writes.">mine</span>' : ''}</td>
        <td>${l.device ? deviceName(l.device) : '<span class="muted">—</span>'}<br>${keyHtml(l.key, 'log key')}</td>
        <td class="num">${l.length}</td>
        <td class="num ${l.held < l.length ? 'warn' : ''}">${l.held}</td>
        <td class="num ${l.indexed < l.held ? 'warn' : ''}">${l.indexed}</td>
        <td class="num">${l.dropped || 0}</td>
        <td>${l.cut !== null ? `<span class="chip bad" title="Nothing after block ${l.cut} counts.">cut at ${l.cut}</span>` : ''}${l.refused ? '<span class="chip bad">refused</span>' : ''}${l.waiting ? '<span class="chip warn">waiting</span>' : ''}${l.cut === null && !l.refused && !l.waiting ? '<span class="ok">ok</span>' : ''}</td>
      </tr>`).join('')}
    </table></div>`
}

// --- records ---

async function records (s) {
  if (!s.types.length) return '<p class="help">No records yet.</p>'
  if (!state.type || !s.types.includes(state.type)) { state.type = s.types[0]; state.pages = [null]; state.page = 0 }
  const after = state.pages[state.page]
  const r = await get(`api/${state.allRows ? 'rows' : 'records'}?key=${encodeURIComponent(state.space)}&type=${encodeURIComponent(state.type)}${after ? '&after=' + encodeURIComponent(after) : ''}`)
  const decl = state.instance && state.instance.types[state.type]
  if (r.next) state.pages[state.page + 1] = r.next
  const rows = s.records[state.type]
  return `
    <div class="pager">
      <label title="hg/... types are hypergraph's own: tags, relations, devices, settings.">Type <select id="type">${s.types.map((t) => `<option ${t === state.type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      <span class="muted" title="Rows in the index count every version, hidden and deleted records included; the list shows what an app's query shows.">${rows} row${rows === 1 ? '' : 's'} in the index</span>
      ${r.complete === false ? '<span class="warn" title="Some records known to exist are not held here (or no other member was reached yet). The inspector never waits or fetches.">not complete</span>' : ''}
      <label title="Every row this device holds of the type: hidden, superseded (an older vote), and those whose content was dropped here, too."><input type="checkbox" id="all-rows" ${state.allRows ? 'checked' : ''}> all rows</label>
    </div>
    <p class="help">${decl ? `Declared: ${Object.entries(decl.fields).map(([f, k]) => `<b>${esc(f)}</b> <span class="muted">${esc(k)}${decl.links[f] ? ' → ' + esc(decl.links[f].join(' | ')) : ''}</span>`).join(', ')}${decl.index.length ? `; indexed by ${decl.index.map((i) => esc(i.join(', '))).join('; ')}` : ''}${decl.onePerMember ? '; one per member' : ''}; edited by ${esc(typeof decl.editable === 'string' ? decl.editable : 'permission ' + decl.editable.permission)}.` : 'A type this app doesn\'t declare (another version\'s): kept, counted, not readable.'}</p>
    <p class="help">Newest first${state.allRows ? ': every row held, those no list shows included' : ', as an app\'s query shows them: hidden and deleted records are left out (click a link to see one)'}. Click a row for its details.</p>
    <div class="table-wrap"><table>
      <tr><th>Fields</th><th>Author</th><th>Device</th><th>${tip('Put', 'When it was put (its stamp).')}</th><th>${tip('Flags', 'edited: changed since it was put. hidden: hidden by a moderator. flagged: flagged by a moderator. future: stamped more than 10 minutes ahead.')}</th></tr>
      ${r.items.map((rec) => `<tr data-id="${esc(rec.id)}" style="cursor:pointer">
        <td>${fieldList(rec)}</td><td>${who(rec.author)}</td><td>${deviceName(rec.device)}</td><td>${when(rec.stamp)}</td><td>${flags(rec)}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing shown (every row is hidden, deleted or an older version).</td></tr>'}
    </table></div>
    <div class="pager">
      <button class="small" id="prev" ${state.page === 0 ? 'disabled' : ''}>← Newer</button>
      <span class="muted">page ${state.page + 1}</span>
      <button class="small" id="next" ${r.next ? '' : 'disabled'}>Older →</button>
    </div>`
}

const SKIP = new Set(['id', 'type', 'author', 'device', 'stamp', 'edited', 'hidden', 'flagged', 'futureStamp', 'state'])

function fieldList (rec) {
  const items = Object.entries(rec).filter(([k]) => !SKIP.has(k))
  if (!items.length) return '<span class="muted">(no fields)</span>'
  return `<ul class="fields">${items.map(([k, v]) => `<li><b>${esc(k)}</b> ${value(v)}</li>`).join('')}</ul>`
}

function value (v) {
  if (isRecordId(v)) return `<a class="link" data-open="${esc(v)}" title="A link to another record: ${esc(v)}">→ record ${esc(short(v))}</a>`
  if (v === null || v === undefined) return '<span class="muted">—</span>'
  if (typeof v === 'object') return `<span class="key">${esc(JSON.stringify(v))}</span>`
  const s = String(v)
  return esc(s.length > 200 ? s.slice(0, 200) + '…' : s)
}

function flags (rec) {
  const st = rec.state || {}
  return [rec.edited && '<span class="chip">edited</span>', (rec.hidden || st.hidden) && '<span class="chip bad">hidden</span>', rec.flagged && '<span class="chip warn">flagged</span>', rec.futureStamp && '<span class="chip warn">future</span>', st.superseded && '<span class="chip" title="An older one of the same member: only the latest counts.">superseded</span>', st.dropped && '<span class="chip warn" title="Its content was dropped here to stay within the budget.">dropped</span>'].filter(Boolean).join('')
}

function wireRecords () {
  const sel = $('#type')
  if (sel) sel.onchange = () => { state.type = sel.value; state.pages = [null]; state.page = 0; refresh() }
  const all = $('#all-rows')
  if (all) all.onchange = () => { state.allRows = all.checked; state.pages = [null]; state.page = 0; refresh() }
  const prev = $('#prev'); const next = $('#next')
  if (prev) prev.onclick = () => { state.page--; refresh() }
  if (next) next.onclick = () => { state.page++; refresh() }
  for (const tr of document.querySelectorAll('tr[data-id]')) tr.onclick = (e) => { if (!e.target.dataset.open) openRecord(tr.dataset.id) }
  wireLinks(document)
}

function wireLinks (root) {
  for (const a of root.querySelectorAll('a[data-open]')) a.onclick = (e) => { e.stopPropagation(); openRecord(a.dataset.open) }
}

// A record's versions and deletes (inspect({ record })).
function history (h) {
  if (!h || (!h.versions.length && !h.deletes.length)) return ''
  const counts = (c) => c === null ? '<span class="muted">?</span>' : c ? 'yes' : '<span class="chip bad">no</span>'
  return `<h3 title="Its first version and every edit and delete held here, oldest first. Counts: whether it is allowed (an edit by someone who may not edit it doesn't count).">History</h3>
    <div class="table-wrap"><table>
      <tr><th>What</th><th>Who</th><th>When</th><th>Counts</th><th>Fields</th></tr>
      ${h.versions.map((v) => `<tr><td>${v.kind}</td><td>${who(v.by)}</td><td>${when(v.stamp)}</td><td>${counts(v.counts)}</td><td>${fieldList(Object.fromEntries(Object.entries(v).filter(([k]) => !['id', 'kind', 'by', 'device', 'stamp', 'counts'].includes(k))))}</td></tr>`).join('')}
      ${h.deletes.map((d) => `<tr><td>delete</td><td>${who(d.by)}</td><td>${when(d.stamp)}</td><td>${counts(d.counts)}</td><td></td></tr>`).join('')}
    </table></div>`
}

async function openRecord (id) {
  const box = $('#record-body')
  try {
    const r = await get(`api/record?key=${encodeURIComponent(state.space)}&id=${encodeURIComponent(id)}`)
    if (!r.record) {
      const h = r.history
      box.innerHTML = `<h3>Record ${keyHtml(id, 'record id')}</h3><p class="help">${h.removed ? 'Taken down by a moderator.' : h.deleted ? 'Deleted by its author.' : `Not here: not held by this device${r.complete ? '' : ' (this device is not complete yet)'}.`}</p>${history(h)}`
    } else {
      const rec = r.record
      box.innerHTML = `
        <h3>${esc(rec.type)} ${keyHtml(rec.id, 'record id')} ${flags(rec)}</h3>
        <dl class="facts">
          <dt>Author</dt><dd>${who(rec.author)}</dd>
          <dt>${tip('Device', 'The device that wrote the current version.')}</dt><dd>${deviceName(rec.device)}</dd>
          <dt>Put</dt><dd>${when(rec.stamp)}</dd>
          ${Object.entries(rec).filter(([k]) => !SKIP.has(k)).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${value(v)}</dd>`).join('')}
          <dt>${tip('Tags', 'Tags on this record (the latest tag or untag wins).')}</dt><dd>${r.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('') || '<span class="muted">none</span>'}</dd>
        </dl>
        <h3 title="Records with a link field pointing at this one (comments, votes...), oldest first.">Pointing at it (${r.linked.length})</h3>
        ${r.linked.length ? `<ul class="fields">${r.linked.map((l) => `<li><a class="link" data-open="${esc(l.id)}">${esc(l.type)}</a> by ${who(l.author)} ${when(l.stamp)} ${flags(l)}</li>`).join('')}</ul>` : '<p class="muted">nothing</p>'}
        <h3 title="Relations (relate/unrelate) from or to this record.">Relations (${r.edges.length})</h3>
        ${r.edges.length ? `<ul class="fields">${r.edges.map((e) => `<li>${e.from === rec.id ? 'this' : `<a class="link" data-open="${esc(e.from)}">${esc(short(e.from))}</a>`} —<b>${esc(e.type)}</b>→ ${e.to === rec.id ? 'this' : `<a class="link" data-open="${esc(e.to)}">${esc(short(e.to))}</a>`}${e.data ? ` <span class="muted">“${esc(e.data)}”</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted">none</p>'}
        ${history(r.history)}
        ${r.complete ? '' : '<p class="warn">Not complete: some of this may be missing here.</p>'}`
    }
  } catch (err) {
    box.innerHTML = `<p class="error">${esc(err.message)}</p>`
  }
  wireLinks(box)
  const dlg = $('#record')
  if (!dlg.open) dlg.showModal()
}

// --- refresh: on the app's events (records, status, logs, peers) ---

let busy = false
let again = false
async function refresh () {
  if (busy) { again = true; return }
  busy = true
  try {
    await drawInstance()
    await drawSpaces()
    if (state.space) await drawSpace()
  } catch (err) {
    setHtml($('#view'), `<p class="error">Could not read: ${esc(err.message)}</p>`)
  } finally {
    busy = false
    if (again) { again = false; refresh() }
  }
}

function live () {
  const events = new EventSource('api/events')
  events.onopen = () => { $('#live').textContent = 'live' }
  events.onerror = () => { $('#live').textContent = 'reconnecting… (has the app stopped?)' }
  events.onmessage = () => { if (!$('#record').open) refresh() }
}

refresh()
live()

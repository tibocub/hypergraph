// The inspector: a read-only window into a running hypergraph (spec 011,
// `hypergraph/next`), served as a web page from inside the app.
//
//   const { serveInspector } = require('hypergraph/tools/inspector')
//   const { url, close } = await serveInspector(hg, { port: 4400 })
//
// Built only on the public API and space.inspect(). Read-only: the server
// answers GET and nothing else, and every read it makes uses timeout 0, so it
// neither waits for nor fetches anything (a record whose content was dropped
// here is left out, and the answer says complete: false). Node only for now
// (it uses Node's http); the core itself runs on Node and Bare.

const http = require('http')
const fs = require('fs')
const path = require('path')

const FILES = {
  '/': ['page.html', 'text/html; charset=utf-8'],
  '/page.js': ['page.js', 'text/javascript; charset=utf-8'],
  '/page.css': ['page.css', 'text/css; charset=utf-8']
}

const PAGE_SIZE = 25
const MAX_PAGE = 200

async function serveInspector (hg, { port = 0, host = '127.0.0.1' } = {}) {
  const watched = new WeakSet()
  const clients = new Set()

  // Live updates: a space's 'change' and 'status', and new connections, nudge
  // every open page to read again (it also reads every few seconds, for what
  // has no event: logs growing, blocks arriving).
  const nudge = (what) => {
    for (const res of clients) res.write(`data: ${JSON.stringify(what)}\n\n`)
  }
  const watch = (space) => {
    if (watched.has(space)) return
    watched.add(space)
    space.on('change', ({ types } = {}) => nudge({ space: space.key, change: types || [] }))
    space.on('status', () => nudge({ space: space.key, status: true }))
  }
  const onConnection = () => nudge({ connection: true })
  hg.on('connection', onConnection)

  const spaceOf = (key) => {
    if (key === 'personal') return hg.personal
    const space = hg.space(key)
    watch(space)
    return space
  }

  const routes = {
    '/api/instance': () => instance(hg),
    '/api/spaces': () => spaces(hg, watch),
    '/api/space': (q) => space(hg, spaceOf(q.get('key'))),
    '/api/records': (q) => records(spaceOf(q.get('key')), q.get('type'), q.get('after'), Number(q.get('limit')) || PAGE_SIZE),
    '/api/record': (q) => record(spaceOf(q.get('key')), q.get('id'))
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://inspector')
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'The inspector is read-only: GET only' }, { Allow: 'GET, HEAD' })

    if (FILES[url.pathname]) {
      const [file, type] = FILES[url.pathname]
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
      return res.end(fs.readFileSync(path.join(__dirname, file)))
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
      res.write(': connected\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    const route = routes[url.pathname]
    if (!route) return send(res, 404, { error: 'Not found' })
    try {
      send(res, 200, await route(url.searchParams))
    } catch (err) {
      send(res, err.code === 'NOT_FOUND' ? 404 : 500, { error: err.message, code: err.code || null })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const address = server.address()

  let closing = null
  function close () {
    if (closing) return closing
    hg.off('connection', onConnection)
    for (const res of clients) res.end()
    clients.clear()
    closing = new Promise((resolve) => server.close(() => resolve()))
    if (server.closeAllConnections) server.closeAllConnections()
    return closing
  }

  return { url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${address.port}/`, port: address.port, close }
}

function send (res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

// --- views ---

// This instance: who it is, its devices, its storage.
async function instance (hg) {
  return {
    identity: hg.identity.publicKey,
    device: hg.device.publicKey,
    devices: await hg.devices(),
    storage: await hg.storage(),
    spaces: hg.spaces().length
  }
}

// Every space held here, the personal space first.
async function spaces (hg, watch) {
  const out = [await summary(hg.personal, { key: 'personal', name: 'Personal space', parent: null })]
  for (const s of hg.spaces()) {
    const space = hg.space(s.key)
    watch(space)
    out.push(await summary(space, s))
  }
  return out
}

async function summary (space, { key, name, parent }) {
  const snap = await space.inspect()
  return {
    key,
    name,
    parent,
    personal: snap.personal,
    complete: snap.complete,
    peers: snap.peers,
    policy: snap.storage.policy,
    held: snap.storage.held,
    members: new Set(snap.logs.filter((l) => l.identity && !l.refused && !l.waiting).map((l) => l.identity)).size,
    records: Object.values(snap.records).reduce((a, b) => a + b, 0),
    warnings: snap.warnings
  }
}

// One space: the inspect() snapshot, its roles, and its members as far as
// this member can tell (identities of the logs and decision writers it knows).
async function space (hg, space) {
  const snap = await space.inspect()
  const status = space.status()
  const roles = space.personal ? [] : await space.roles()

  const people = new Map()
  const person = (identity) => {
    if (!people.has(identity)) people.set(identity, { identity, you: identity === hg.identity.publicKey, role: null, devices: new Map(), settler: false, decides: false })
    return people.get(identity)
  }
  person(hg.identity.publicKey)
  for (const log of snap.logs) {
    if (!log.identity) continue
    const p = person(log.identity)
    if (log.device) p.devices.set(log.device, { device: log.device, log: log.key, cut: log.cut, refused: log.refused, waiting: log.waiting })
  }
  for (const w of snap.decisions.writers) {
    const p = person(w.identity)
    p.decides = true
    if (w.settler) p.settler = true
  }
  const names = new Map((await hg.devices()).map((d) => [d.publicKey, d.name]))
  const members = []
  for (const p of people.values()) {
    if (!space.personal) p.role = await space.getRole(p.identity)
    members.push({
      ...p,
      devices: [...p.devices.values()].map((d) => ({ ...d, name: names.get(d.device) || null }))
    })
  }
  const rank = new Map(roles.map((r, i) => [r.name, i]))
  members.sort((a, b) => (rank.get(a.role) ?? 99) - (rank.get(b.role) ?? 99) || (b.you - a.you))

  return { ...snap, status, roles, members, types: Object.keys(snap.records).sort(typeOrder) }
}

// The app's types first, hypergraph's own (hg/...) after.
function typeOrder (a, b) {
  return (a.startsWith('hg/') - b.startsWith('hg/')) || a.localeCompare(b)
}

// A page of records of one type, newest first, as query().latest() gives
// them: shown records only (hidden, deleted and replaced ones are left out).
async function records (space, type, after, limit) {
  if (!type) throw Object.assign(new Error('Which type? ?type=post'), { code: 'NOT_FOUND' })
  limit = Math.max(1, Math.min(MAX_PAGE, limit))
  let from = null
  if (after) {
    from = (await space.get(after, { timeout: 0 })).record
    if (!from) throw Object.assign(new Error('No record ' + after + ' here'), { code: 'NOT_FOUND' })
  }
  const { items, complete } = await space.query(type).latest(limit + 1, { after: from, timeout: 0 })
  const more = items.length > limit
  return { type, items: items.slice(0, limit), complete, next: more ? items[limit - 1].id : null }
}

// One record (get() also finds hidden ones) and what points at it.
async function record (space, id) {
  const { record, complete } = await space.get(id, { timeout: 0 })
  if (!record) return { record: null, complete, linked: [], edges: null }
  const linked = await space.linked(record, null, { timeout: 0 })
  const edges = await space.edges(record, { timeout: 0 })
  // There is no "tags of a record" read: the tag records pointing at it, the
  // newest per tag name wins (tag, untag, tag again...).
  const tagRows = await space.query('hg/tag').on(record).latest(MAX_PAGE, { timeout: 0 })
  const latest = new Map()
  for (const t of tagRows.items) if (!latest.has(t.tag)) latest.set(t.tag, t)
  return {
    record,
    complete: complete && linked.complete && edges.complete && tagRows.complete,
    linked: linked.items,
    edges: edges.items,
    tags: [...latest.values()].filter((t) => !t.off).map((t) => t.tag).sort()
  }
}

module.exports = { serveInspector }

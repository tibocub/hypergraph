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

  // Live updates: a space's 'change', 'status', 'logs' (a log arrived or
  // grew) and 'peers' (one connected or left), and new connections, nudge
  // every open page to read again. No polling.
  const nudge = (what) => {
    for (const res of clients) res.write(`data: ${JSON.stringify(what)}\n\n`)
  }
  const watch = (space) => {
    if (watched.has(space)) return
    watched.add(space)
    space.on('change', ({ types } = {}) => nudge({ space: space.key, change: types || [] }))
    space.on('status', () => nudge({ space: space.key, status: true }))
    space.on('logs', () => nudge({ space: space.key, logs: true }))
    space.on('peers', () => nudge({ space: space.key, peers: true }))
  }
  const onConnection = () => nudge({ connection: true })
  hg.on('connection', onConnection)

  const spaceOf = (key) => {
    const space = key === 'personal' ? hg.personal : hg.space(key)
    watch(space)
    return space
  }
  watch(hg.personal)

  const routes = {
    '/api/instance': () => instance(hg),
    '/api/spaces': () => spaces(hg, watch),
    '/api/space': (q) => space(hg, spaceOf(q.get('key'))),
    '/api/records': (q) => records(spaceOf(q.get('key')), q.get('type'), q.get('after'), Number(q.get('limit')) || PAGE_SIZE),
    '/api/rows': (q) => rows(spaceOf(q.get('key')), q.get('type'), q.get('after'), Number(q.get('limit')) || PAGE_SIZE),
    '/api/decisions': (q) => decisionList(spaceOf(q.get('key')), q.get('after'), Number(q.get('limit')) || 50),
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
    spaces: hg.spaces().length,
    types: hg.types()
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
    private: !!snap.private, // story 8: read only with its keys (never shown)
    complete: snap.complete,
    peers: snap.peers,
    policy: snap.storage.policy,
    held: snap.storage.held,
    members: new Set(snap.logs.filter((l) => l.identity && !l.refused && !l.waiting).map((l) => l.identity)).size,
    records: Object.values(snap.records).reduce((a, b) => a + b, 0),
    warnings: snap.warnings
  }
}

// One space: the inspect() snapshot, its roles, its members (space.members():
// roles, banned and removed people) with their logs' state and decision
// rights, the latest decisions, and the connected peers.
async function space (hg, space) {
  const snap = await space.inspect()
  const status = space.status()
  const roles = space.personal ? [] : await space.roles()
  const logs = new Map(snap.logs.map((l) => [l.key, l]))
  const names = new Map((await hg.devices()).map((d) => [d.publicKey, d.name]))
  const members = (await space.members()).map((m) => {
    const writers = snap.decisions.writers.filter((w) => w.identity === m.identity)
    // Logs not kept (refused, waiting) aren't held: they come from the snapshot.
    const devices = m.devices.map((d) => ({ ...d, cut: logs.get(d.log)?.cut ?? null, refused: false, waiting: false }))
    for (const l of snap.logs) {
      if (l.identity === m.identity && (l.refused || l.waiting) && l.device && !devices.some((d) => d.log === l.key)) devices.push({ device: l.device, log: l.key, cut: l.cut, refused: l.refused, waiting: l.waiting })
    }
    return { ...m, devices: devices.map((d) => ({ ...d, name: names.get(d.device) || null })), decides: writers.length > 0, settler: writers.some((w) => w.settler) }
  })
  const recent = await space.decisions({ limit: 50 })
  return { ...snap, status, roles, members, peerList: space.peers(), recent: recent.items, types: Object.keys(snap.records).sort(typeOrder) }
}

// A page of decisions, newest first (space.decisions()).
async function decisionList (space, after, limit) {
  const { items, complete } = await space.decisions({ limit: Math.max(1, Math.min(MAX_PAGE, limit)), after: after ? Number(after) : null })
  return { items, complete, next: items.length ? items.at(-1).seq : null }
}

// Every row of a type as held here, those no list shows included (hidden,
// superseded, dropped): inspect({ records }).
async function rows (space, type, after, limit) {
  if (!type) throw Object.assign(new Error('Which type? ?type=post'), { code: 'NOT_FOUND' })
  const { rows } = await space.inspect({ records: { type, limit: Math.max(1, Math.min(MAX_PAGE, limit)), after: after || null } })
  return { type, ...rows }
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

// One record (get() also finds hidden ones), what points at it, its tags,
// and its history (inspect({ record }): every version and delete, also for a
// record deleted or taken down).
async function record (space, id) {
  const { record, complete } = await space.get(id, { timeout: 0 })
  const { record: history } = await space.inspect({ record: id })
  if (!record) return { record: null, complete, linked: [], edges: [], tags: [], history }
  const linked = await space.linked(record, null, { timeout: 0 })
  const edges = await space.edges(record, { timeout: 0 })
  const tags = await space.tags(record, { timeout: 0 })
  return {
    record,
    complete: complete && linked.complete && edges.complete && tags.complete,
    linked: linked.items,
    edges: edges.items,
    tags: tags.items,
    history
  }
}

module.exports = { serveInspector }

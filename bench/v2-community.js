// v2 prototype community benchmark (spec 007, T020, SC-005): does a member's
// cost depend on the channels it has open, not on how many channels and
// members the community has?
//
//   node bench/v2-community.js [--channels C] [--members M] [--segments S] [--active A] [--per-author P] [--open K]
//
// Host: a community with C channels it keeps. The K channels the member will
// open each get S one-hour segments of history, A authors active per segment
// drawn from M members (P messages each); every other channel gets a little
// activity (3 authors, one message each). Member, in its own process: startup
// (control log caught up), K channels opened (latest page + follow): memory,
// open logs; then 10 s idle: CPU time and bytes received.
// Two processes, below-normal priority (CLAUDE.md on machine load).

const path = require('path')
const fs = require('fs')
const os = require('os')
const net = require('net')
const crypto = require('crypto')
const hcrypto = require('hypercore-crypto')
const { spawn } = require('child_process')
const Corestore = require('corestore')
const b4a = require('b4a')
const { Community } = require('../src/v2')
const { AuthorLog } = require('../src/v2/author-log')
const { signEntry } = require('../src/v2/roster')
const { segmentOf, segmentStart } = require('../src/v2/segments')

const argValue = (name, def) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? def : Number(process.argv[i + 1])
}
const now = () => process.hrtime.bigint()
const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6
const sleep = (t) => new Promise(resolve => setTimeout(resolve, t))
const rss = () => { if (global.gc) { global.gc(); global.gc() } return process.memoryUsage().rss }
const say = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const seedOf = (i) => crypto.createHash('sha256').update(`v2-community-member-${i}`).digest()
const identities = new Map()
const identityOf = (i) => {
  let id = identities.get(i)
  if (!id) identities.set(i, (id = { keyPair: hcrypto.keyPair(seedOf(i)), seed: seedOf(i) }))
  return id
}
const SEGMENT_MS = 3600000

// ── host: build the community, then serve it ────────────────────────────────
async function host (dir, channels, members, segments, active, perAuthor, open) {
  const t0 = now()
  const store = new Corestore(dir)
  const owner = identityOf('owner')
  const community = new Community(store, { identity: owner })
  await community.ready()
  const current = segmentOf(Date.now(), SEGMENT_MS)
  const firstSeg = current - segments + 1
  const ids = []
  for (let c = 0; c < channels; c++) {
    const id = b4a.toString(hcrypto.randomBytes(16), 'hex')
    await community.appendAs(owner.keyPair, { type: 'channel', id, name: `c${c}`, segmentMs: SEGMENT_MS, timestamp: segmentStart(firstSeg, SEGMENT_MS) })
    await community.keep(id)
    ids.push(id)
  }

  let logs = new Map()
  const logOf = async (a, channel) => {
    const k = `${a}:${channel}`
    let log = logs.get(k)
    if (!log) {
      if (logs.size >= 2000) { for (const l of logs.values()) await l.close(); logs = new Map() }
      log = new AuthorLog(store, { keyPair: AuthorLog.keyPairFor(identityOf(a), community.key, channel) })
      await log.ready()
      logs.set(k, log)
    }
    return log
  }
  const write = async (channel, s, authors, count) => {
    const start = segmentStart(s, SEGMENT_MS)
    const span = s === current ? Math.max(1, Date.now() - start - 1000) : SEGMENT_MS - 1
    let last = null
    for (let k = 0; k < authors.length; k++) {
      const a = authors[k]
      const log = await logOf(a, channel)
      const messages = []
      for (let i = 0; i < count; i++) messages.push({ t: start + Math.floor(((i * authors.length + k) / (count * authors.length)) * span), text: `message ${i} from member ${a} in segment ${s}` })
      const first = await log.appendMany(messages)
      const id = identityOf(a)
      await community.writeRosterEntryUnchecked(channel, s, { author: id.keyPair.publicKey, log: log.key, start: first, sig: signEntry(community.key, channel, s, log.key, first, id.keyPair) })
      last = { log: b4a.toString(log.key, 'hex'), seq: first + count - 1 }
    }
    return last
  }

  const distinct = new Set()
  const last = {}
  for (let c = 0; c < open; c++) {
    for (let s = firstSeg; s <= current; s++) {
      const authors = []
      for (let k = 0; k < active; k++) {
        // Spread over the member pool: with a big pool, each segment brings
        // new authors; with a small one, the same members come back.
        const a = Number((BigInt(c * segments * active + (s - firstSeg) * active + k) * 7919n) % BigInt(members))
        authors.push(a)
        distinct.add(a)
      }
      last[ids[c]] = await write(ids[c], s, authors, perAuthor)
    }
  }
  for (let c = open; c < channels; c++) {
    const authors = [0, 1, 2].map(k => (c * 3 + k) % members)
    await write(ids[c], current, authors, 1)
  }
  for (const l of logs.values()) await l.close()
  const buildMs = ms(t0)
  const key = b4a.toString(community.key, 'hex')
  const controlLength = (await community.stats()).controlLength
  await community.close()
  await store.close()

  // Serve from a fresh reopen, as a restarted host would: right after the
  // build, Corestore still held thousands of just-closed author logs and
  // offered each one to the member on connect (~87 bytes each: 296 KB vs
  // 470 KB at startup between 1,000 and 50,000 members, from that alone).
  const served = new Corestore(dir)
  const reopened = new Community(served, { identity: owner, key })
  await reopened.ready()
  const server = net.createServer((socket) => {
    const s = reopened.replicate(false)
    s.pipe(socket).pipe(s)
    s.on('error', () => {})
    socket.on('error', () => {})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  say({ type: 'ready', port: server.address().port, key, open: ids.slice(0, open), last, buildMs: Math.round(buildMs), distinctAuthors: distinct.size, controlLength, servedCores: served.cores.size })
}

// ── member: startup, open K channels, idle ──────────────────────────────────
async function memberRun (dir, port, key, open, last, channels) {
  const startRss = rss()
  const startHeap = process.memoryUsage().heapUsed
  const startExternal = process.memoryUsage().external
  let bytes = 0
  const t0 = now()
  const store = new Corestore(dir)
  const community = new Community(store, { identity: { keyPair: hcrypto.keyPair() }, key })
  await community.ready()
  const found = store.findingPeers()
  const socket = net.connect(port, '127.0.0.1')
  socket.on('data', (d) => { bytes += d.length })
  socket.once('connect', () => setTimeout(found, 500))
  const s = community.replicate(true)
  s.pipe(socket).pipe(s)
  s.on('error', () => {})
  socket.on('error', () => {})
  while (community.channels().length < channels || open.some(id => community.keepers(id).length === 0)) {
    await community.update()
    await sleep(10)
  }
  const startup = { ms: Math.round(ms(t0)), bytes, controlLength: (await community.stats()).controlLength, rss: rss() - startRss, heap: process.memoryUsage().heapUsed - startHeap, external: process.memoryUsage().external - startExternal }

  const t1 = now()
  const b1 = bytes
  for (const id of open) {
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      const page = await community.latest(id, { limit: 50 })
      if (page[0] && page[0].log === last[id].log && page[0].seq === last[id].seq) break
      await sleep(20)
    }
  }
  const stops = open.map(id => community.follow(id, () => {}, process.env.POLL ? { pollMs: Number(process.env.POLL) } : {}))
  await sleep(1000)
  const st = await community.stats()
  const opened = { ms: Math.round(ms(t1)), bytes: bytes - b1, rss: rss() - startRss, openLogs: st.openLogs, rosters: st.rosterKeepers }

  const cpu0 = process.cpuUsage()
  const b2 = bytes
  await sleep(10000)
  const cpu = process.cpuUsage(cpu0)
  const idle = { cpuMs: Math.round((cpu.user + cpu.system) / 1000), bytes: bytes - b2, rss: rss() - startRss }

  for (const stop of stops) stop()
  socket.destroy()
  await community.close()
  await store.close()
  say({ type: 'result', result: { startup, opened, idle } })
  process.exit(0)
}

// ── orchestration ────────────────────────────────────────────────────────────
function proc (args) {
  const p = spawn(process.execPath, ['--expose-gc', '--max-old-space-size=4096', __filename, ...args], { stdio: ['pipe', 'pipe', 'inherit'] })
  try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
  const queue = []
  const waiters = []
  let buf = ''
  p.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      const w = waiters.findIndex(x => x.type === msg.type)
      if (w !== -1) waiters.splice(w, 1)[0].resolve(msg)
      else queue.push(msg)
    }
  })
  return {
    next: (type) => {
      const i = queue.findIndex(m => m.type === type)
      if (i !== -1) return Promise.resolve(queue.splice(i, 1)[0])
      return new Promise(resolve => waiters.push({ type, resolve }))
    },
    kill: () => p.kill(),
    exited: new Promise(resolve => p.on('exit', resolve))
  }
}

async function main () {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'host') return host(rest[0], ...rest.slice(1).map(Number))
  if (cmd === 'member') return memberRun(rest[0], Number(rest[1]), rest[2], JSON.parse(rest[3]), JSON.parse(rest[4]), Number(rest[5]))

  const channels = argValue('--channels', 10)
  const members = argValue('--members', 1000)
  const segments = argValue('--segments', 100)
  const active = argValue('--active', 50)
  const perAuthor = argValue('--per-author', 2)
  const open = Math.min(argValue('--open', 5), channels)
  const root = fs.mkdtempSync(path.join(process.env.BENCH_DIR || os.tmpdir(), `hg-v2community-${channels}-${members}-`))
  const result = { channels, members, segments, active, perAuthor, open }
  let ok = false
  try {
    const h = proc(['host', path.join(root, 'host'), channels, members, segments, active, perAuthor, open].map(String))
    const ready = await h.next('ready')
    result.host = { buildMs: ready.buildMs, distinctAuthors: ready.distinctAuthors, controlLength: ready.controlLength, servedCores: ready.servedCores }
    const m = proc(['member', path.join(root, 'member'), String(ready.port), ready.key, JSON.stringify(ready.open), JSON.stringify(ready.last), String(channels)])
    result.member = (await m.next('result')).result
    h.kill()
    await Promise.all([h.exited, m.exited])
    const out = path.join(__dirname, 'results')
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, `v2-community-${channels}-${members}.json`), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
    ok = true
  } finally {
    if (process.env.KEEP || !ok) console.error('kept', root)
    else fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 })
  }
}

main().catch((err) => { console.error(err); process.exit(1) })

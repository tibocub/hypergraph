// v2 prototype chat benchmark (spec 007, T016): does a channel cost the same
// at 10k and 10M messages?
//
//   node bench/v2-chat.js <N> [--active A] [--pool P] [--per-segment S] [--segment-ms MS] [--live L]
//                             [--writers W] [--procs K] [--seconds D] [--rate R]
//
// History is generated in bulk (research R9): S messages per segment, from A
// authors active in it (drawn from a pool of P), written straight into the
// authors' logs, roster entries signed by each author. Then:
//   seed     — reopens the host store and serves the community
//   newcomer — a fresh peer: latest page (time, bytes, memory, open logs),
//              one segment back, restart offline, live arrival from the host.
//   writers  — K processes posting as W authors in all (W/K each, through
//              postAs) for D seconds, R messages/s per author (0: as fast as
//              they can); the newcomer follows: throughput and arrival.
// Few processes, below-normal priority (CLAUDE.md on machine load).

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
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] }
const text = (a, i) => `message ${i} from author ${a}: the quick brown fox jumps over the lazy dog`
const seedOf = (i) => crypto.createHash('sha256').update(`v2-chat-author-${i}`).digest()
const identityOf = (i) => ({ keyPair: hcrypto.keyPair(seedOf(i)), seed: seedOf(i) })

function dirSize (dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size
  }
  return total
}

// ── history: the host holds the control log, the roster and every log ────────
async function history (dir, n, active, pool, perSegment, segmentMs) {
  const store = new Corestore(dir)
  const owner = identityOf('owner')
  const community = new Community(store, { identity: owner })
  await community.ready()
  const segments = Math.ceil(n / perSegment)
  const current = segmentOf(Date.now(), segmentMs)
  const firstSeg = current - segments + 1
  const channel = b4a.toString(hcrypto.randomBytes(16), 'hex')
  await community.appendAs(owner.keyPair, { type: 'channel', id: channel, name: 'general', segmentMs, timestamp: segmentStart(firstSeg, segmentMs) })
  await community.keep(channel)

  const logs = new Map()
  const logOf = async (a) => {
    let log = logs.get(a)
    if (!log) {
      log = new AuthorLog(store, { keyPair: AuthorLog.keyPairFor(identityOf(a), community.key, channel) })
      await log.ready()
      logs.set(a, log)
    }
    return log
  }

  const t0 = now()
  let written = 0
  let lastMessage = null
  for (let s = firstSeg; s <= current && written < n; s++) {
    const count = Math.min(perSegment, n - written)
    const authors = []
    for (let k = 0; k < active; k++) authors.push(((s - firstSeg) * 7 + k * 13) % pool)
    const per = Math.ceil(count / authors.length)
    const start = segmentStart(s, segmentMs)
    // The last segment ends now, so the newest messages are recent.
    const span = s === current ? Math.max(1, Date.now() - start - 1000) : segmentMs - 1
    for (let k = 0; k < authors.length && written < n; k++) {
      const a = authors[k]
      const m = Math.min(per, n - written)
      if (m <= 0) break
      const log = await logOf(a)
      const messages = []
      for (let i = 0; i < m; i++) messages.push({ t: start + Math.floor(((i * authors.length + k) / (m * authors.length)) * span), text: text(a, written + i) })
      const first = await log.appendMany(messages)
      const id = identityOf(a)
      await community.writeRosterEntryUnchecked(channel, s, {
        author: id.keyPair.publicKey,
        log: log.key,
        start: first,
        sig: signEntry(community.key, channel, s, log.key, first, id.keyPair)
      })
      written += m
      if (s === current) lastMessage = { author: b4a.toString(id.keyPair.publicKey, 'hex'), log: b4a.toString(log.key, 'hex'), seq: first + m - 1 }
    }
  }
  const writeMs = ms(t0)
  for (const log of logs.values()) await log.close()
  const key = b4a.toString(community.key, 'hex')
  await community.close()
  await store.close()
  return { n: written, segments, active, pool, perSegment, segmentMs, writeMs: Math.round(writeMs), hostDisk: dirSize(dir), key, channel, lastMessage }
}

// ── seed: serve the host store; post live messages on request ────────────────
async function seed (dir, key, channel) {
  const t = now()
  const store = new Corestore(dir)
  const community = new Community(store, { identity: identityOf('owner'), key })
  await community.ready()
  const reopenMs = ms(t)
  const server = net.createServer((socket) => {
    const s = community.replicate(false)
    s.pipe(socket).pipe(s)
    s.on('error', () => {})
    socket.on('error', () => {})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  process.stdout.write(JSON.stringify({ type: 'ready', port: server.address().port, reopenMs: Math.round(reopenMs) }) + '\n')
  let buf = ''
  process.stdin.on('data', async (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      const cmd = JSON.parse(line)
      if (cmd.type === 'post') await community.post(channel, `live ${cmd.k} ${Date.now()}`)
    }
  })
}

// ── writers: K processes posting as W authors in all ───────────────────────
async function writer (dir, seedPort, key, channel, from, count) {
  const say = (m) => process.stdout.write(JSON.stringify(m) + '\n')
  const store = new Corestore(dir)
  const community = new Community(store, { identity: { keyPair: hcrypto.keyPair() }, key })
  await community.ready()
  const toSeed = net.connect(seedPort, '127.0.0.1')
  const s0 = community.replicate(true)
  s0.pipe(toSeed).pipe(s0)
  s0.on('error', () => {})
  toSeed.on('error', () => {})
  // The newcomer connects here to fetch these authors' logs.
  const server = net.createServer((socket) => {
    const s = community.replicate(false)
    s.pipe(socket).pipe(s)
    s.on('error', () => {})
    socket.on('error', () => {})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  while (!community.channel(channel) || community.keepers(channel).length === 0) { await community.update(); await sleep(20) }
  const authors = []
  for (let i = from; i < from + count; i++) authors.push({ i, identity: identityOf(`writer-${i}`) })
  say({ type: 'ready', port: server.address().port })

  let buf = ''
  process.stdin.on('data', async (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      const cmd = JSON.parse(line)
      if (cmd.type !== 'go') continue
      const deadline = Date.now() + cmd.seconds * 1000
      const gap = cmd.rate > 0 ? 1000 / cmd.rate : 0
      let posted = 0
      const t0 = now()
      // One loop per author: each appends to its own log, nothing shared.
      await Promise.all(authors.map(async (a, k) => {
        if (gap) await sleep((k / authors.length) * gap) // spread the starts
        let seq = 0
        while (Date.now() < deadline) {
          const started = Date.now()
          await community.postAs(a.identity, channel, `tp ${a.i} ${seq++} ${Date.now()}`)
          posted++
          if (gap) await sleep(Math.max(0, gap - (Date.now() - started)))
          else if (seq % 64 === 0) await new Promise(setImmediate) // let replication run
        }
      }))
      say({ type: 'posted', posted, ms: Math.round(ms(t0)) })
    }
  })
}

// ── newcomer ─────────────────────────────────────────────────────────────────
async function newcomer (dir, port, key, channel, lastMessage, live, writerPorts, tp) {
  const say = (m) => process.stdout.write(JSON.stringify(m) + '\n')
  const next = stdinReader()
  const startRss = rss()
  let store = new Corestore(dir)
  let community = new Community(store, { identity: { keyPair: hcrypto.keyPair() }, key })
  await community.ready()
  let bytes = 0
  const found = store.findingPeers()
  let socket = net.connect(port, '127.0.0.1')
  socket.on('data', (d) => { bytes += d.length })
  socket.once('connect', () => setTimeout(found, 500))
  let s = community.replicate(true)
  s.pipe(socket).pipe(s)
  s.on('error', () => {})
  socket.on('error', () => {})

  const t0 = now()
  while (community.channels().length === 0) { await community.update(); await sleep(20) }
  let page = []
  while (true) {
    page = await community.latest(channel, { limit: 50 })
    if (page[0] && page[0].log === lastMessage.log && page[0].seq === lastMessage.seq) break
    if (ms(t0) > 10 * 60 * 1000) break
    await sleep(20)
  }
  const latest = { ms: Math.round(ms(t0)), bytes, got: page.length, rss: rss() - startRss, openLogs: (await community.stats()).openLogs }

  const t1 = now()
  const b0 = bytes
  const older = await community.before(channel, { t: page[page.length - 1].t - 3600 * 1000, limit: 50 })
  const scrollback = { ms: Math.round(ms(t1)), bytes: bytes - b0, got: older.length }

  // Live: the host posts; how long until this peer's follow sees it?
  const arrivals = []
  if (live) {
    const seen = new Map()
    const stop = community.follow(channel, (m) => {
      const match = /^live (\d+) (\d+)$/.exec(m.text || '')
      if (match) seen.set(Number(match[1]), Date.now() - Number(match[2]))
    })
    await sleep(1500) // let follow find the host as an author once it posts
    for (let k = 0; k < live; k++) {
      say({ type: 'post', k })
      const deadline = Date.now() + 15000
      while (!seen.has(k) && Date.now() < deadline) await sleep(5)
      arrivals.push(seen.has(k) ? seen.get(k) : Infinity)
      await sleep(100)
    }
    stop()
  }

  // Throughput: W authors post at once from other processes.
  let throughput = null
  if (writerPorts.length) {
    const sockets = writerPorts.map((p) => {
      const so = net.connect(p, '127.0.0.1')
      so.on('data', (d) => { bytes += d.length })
      const st = community.replicate(true)
      st.pipe(so).pipe(st)
      st.on('error', () => {})
      so.on('error', () => {})
      return so
    })
    const seen = new Set()
    const lat = []
    let lastArrival = 0
    const stop = community.follow(channel, (m) => {
      const match = /^tp (\d+) (\d+) (\d+)$/.exec(m.text || '')
      if (!match) return
      const id = `${match[1]}:${match[2]}`
      if (seen.has(id)) return
      seen.add(id)
      lastArrival = Date.now()
      lat.push({ sent: Number(match[3]), ms: lastArrival - Number(match[3]) })
    })
    await sleep(1500)
    const b0 = bytes
    const t3 = Date.now()
    say({ type: 'tp-go', seconds: tp.seconds, rate: tp.rate })
    const { posted, postMs } = await next('tp-total')
    // Whatever is still in flight: until everything arrived, or 15 s of nothing new.
    while (seen.size < posted && Date.now() - Math.max(lastArrival, t3 + postMs) < 15000) await sleep(50)
    stop()
    for (const so of sockets) so.destroy()
    throughput = {
      writers: tp.writers,
      procs: writerPorts.length,
      seconds: tp.seconds,
      rate: tp.rate,
      posted,
      postedPerSec: Math.round(posted / (postMs / 1000)),
      delivered: seen.size,
      deliveredPerSec: Math.round(seen.size / ((Math.max(lastArrival, t3 + 1) - t3) / 1000)),
      p50: Math.round(pct(lat.map(x => x.ms), 0.5)),
      p95: Math.round(pct(lat.map(x => x.ms), 0.95)),
      // After the first 3 s: authors already found through the roster.
      steadyP50: Math.round(pct(lat.filter(x => x.sent >= t3 + 3000).map(x => x.ms), 0.5)),
      steadyP95: Math.round(pct(lat.filter(x => x.sent >= t3 + 3000).map(x => x.ms), 0.95)),
      bytes: bytes - b0
    }
  }

  socket.destroy()
  await community.close()
  await store.close()
  const disk = dirSize(dir)

  // Restart offline: is what was shown still there?
  const t2 = now()
  store = new Corestore(dir)
  community = new Community(store, { identity: { keyPair: hcrypto.keyPair() }, key })
  await community.ready()
  let again = []
  try {
    again = await Promise.race([community.latest(channel, { limit: 50, timeout: 1000 }), sleep(10000).then(() => null)]) || []
  } catch {}
  const offline = again && again.length ? { ms: Math.round(ms(t2)), got: again.length } : { stuck: true }
  await community.close()
  await store.close()

  const got = arrivals.filter(x => x !== Infinity)
  say({ type: 'result', result: { latest, scrollback, disk, offline, live: live ? { sent: live, lost: live - got.length, p50: Math.round(pct(got, 0.5)), p95: Math.round(pct(got, 0.95)) } : null, throughput } })
  process.exit(0)
}

// Messages from the orchestrator, one JSON per line: next(type) waits for one.
function stdinReader () {
  const queue = []
  const waiters = []
  let buf = ''
  process.stdin.on('data', (d) => {
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
  return (type) => {
    const i = queue.findIndex(m => m.type === type)
    if (i !== -1) return Promise.resolve(queue.splice(i, 1)[0])
    return new Promise(resolve => waiters.push({ type, resolve }))
  }
}

// ── orchestration ────────────────────────────────────────────────────────────
function proc (args) {
  const p = spawn(process.execPath, ['--expose-gc', '--max-old-space-size=4096', __filename, ...args], { stdio: ['pipe', 'pipe', 'inherit'] })
  try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
  const queue = []
  const waiters = []
  const listeners = []
  let buf = ''
  p.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      for (const l of listeners) l(msg)
      const w = waiters.findIndex(x => x.type === msg.type)
      if (w !== -1) waiters.splice(w, 1)[0].resolve(msg)
      else queue.push(msg)
    }
  })
  return {
    send: (m) => p.stdin.write(JSON.stringify(m) + '\n'),
    on: (fn) => listeners.push(fn),
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
  if (cmd === 'history') {
    const [dir, n, active, pool, perSegment, segmentMs] = rest
    process.stdout.write(JSON.stringify({ type: 'history', result: await history(dir, Number(n), Number(active), Number(pool), Number(perSegment), Number(segmentMs)) }) + '\n')
    process.exit(0)
  }
  if (cmd === 'seed') return seed(rest[0], rest[1], rest[2])
  if (cmd === 'newcomer') return newcomer(rest[0], Number(rest[1]), rest[2], rest[3], JSON.parse(rest[4]), Number(rest[5]), JSON.parse(rest[6]), JSON.parse(rest[7]))
  if (cmd === 'writer') return writer(rest[0], Number(rest[1]), rest[2], rest[3], Number(rest[4]), Number(rest[5]))

  const n = Number(cmd)
  if (!n) throw new Error('usage: node bench/v2-chat.js <N> [--active A] [--pool P] [--per-segment S] [--segment-ms MS] [--live L]')
  const active = argValue('--active', 50)
  const pool = argValue('--pool', 1000)
  const perSegment = argValue('--per-segment', 10000)
  const segmentMs = argValue('--segment-ms', 3600000)
  const live = argValue('--live', 20)
  const tp = { writers: argValue('--writers', 0), procs: argValue('--procs', 2), seconds: argValue('--seconds', 10), rate: argValue('--rate', 0) }
  const root = fs.mkdtempSync(path.join(process.env.BENCH_DIR || os.tmpdir(), `hg-v2chat-${n}-`))
  const result = { n }
  let ok = false
  try {
    const h = proc(['history', path.join(root, 'host'), String(n), String(active), String(pool), String(perSegment), String(segmentMs)])
    result.history = (await h.next('history')).result
    await h.exited
    const { key, channel, lastMessage } = result.history
    const sd = proc(['seed', path.join(root, 'host'), key, channel])
    const ready = await sd.next('ready')
    result.seedReopenMs = ready.reopenMs
    const writers = []
    if (tp.writers) {
      const procs = Math.max(1, Math.min(tp.procs, tp.writers))
      for (let k = 0; k < procs; k++) {
        const from = Math.floor((k * tp.writers) / procs)
        const to = Math.floor(((k + 1) * tp.writers) / procs)
        writers.push(proc(['writer', path.join(root, `writer-${k}`), String(ready.port), key, channel, String(from), String(to - from)]))
      }
    }
    const writerPorts = []
    for (const w of writers) writerPorts.push((await w.next('ready')).port)
    const nc = proc(['newcomer', path.join(root, 'new'), String(ready.port), key, channel, JSON.stringify(lastMessage), String(live), JSON.stringify(writerPorts), JSON.stringify(tp)])
    nc.on((m) => {
      if (m.type === 'post') sd.send(m)
      if (m.type === 'tp-go') {
        for (const w of writers) w.send({ type: 'go', seconds: m.seconds, rate: m.rate })
        Promise.all(writers.map(w => w.next('posted'))).then((all) => {
          nc.send({ type: 'tp-total', posted: all.reduce((a, x) => a + x.posted, 0), postMs: Math.max(...all.map(x => x.ms)) })
        })
      }
    })
    result.newcomer = (await nc.next('result')).result
    sd.kill()
    for (const w of writers) w.kill()
    await Promise.all([nc.exited, sd.exited, ...writers.map(w => w.exited)])
    delete result.history.key
    delete result.history.lastMessage
    const out = path.join(__dirname, 'results')
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, `v2-chat-${n}${tp.writers ? `-w${tp.writers}` : ''}.json`), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
    ok = true
  } finally {
    if (process.env.KEEP || !ok) console.error('kept', root)
    else fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 })
  }
}

main().catch((err) => { console.error(err); process.exit(1) })

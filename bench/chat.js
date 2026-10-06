// Chat benchmark: does the cost of using a channel grow with its history?
//
//   node bench/chat.js <N> [--writers W] [--model edge|content] [--live M]
//
// One channel (a context) holds N short messages from W writers. The question
// is the one a chat app asks: does a newcomer see the latest messages as fast
// in a channel with 1M messages as in one with 10k, and does a live message
// arrive as fast?
//
// A message is modeled two ways:
//   edge    (default) put a 'msg' entity, relate msg --msg--> channel with the
//           text as relation data (spec 004). The context alone is enough.
//   content put a 'msg' entity, putContent(text), relate msg --msg--> channel.
//           Reading a message needs its author's log: what apps write today.
//
// Three processes, so each peer's memory is its own:
//   history  — W writers fill the channel in interleaved rounds (owner is the
//              only indexer, writers are members), then a live phase: one
//              writer posts M messages, another member measures arrival.
//   seed     — reopens the owner's store (which holds every writer's data)
//              and serves it on a localhost socket.
//   newcomer — a fresh peer: time and bytes until the latest page shows,
//              the oldest page, an update(), a cold reopen.

const path = require('path')
const fs = require('fs')
const os = require('os')
const net = require('net')
const { spawn } = require('child_process')
const Corestore = require('corestore')
const { Hypergraph } = require('../index.js')

const PAGE = 50
const ROUND = 500 // messages per writer per round

const argValue = (name, def) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? def : process.argv[i + 1]
}

// ── measurement helpers ──────────────────────────────────────────────────────

function memSampler () {
  const peak = { rss: 0, heap: 0 }
  const sample = () => {
    const m = process.memoryUsage()
    if (m.rss > peak.rss) peak.rss = m.rss
    if (m.heapUsed > peak.heap) peak.heap = m.heapUsed
  }
  sample()
  const timer = setInterval(sample, 50)
  return { stop () { sample(); clearInterval(timer); return peak } }
}

function dirSize (dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size
  }
  return total
}

const now = () => process.hrtime.bigint()
const ms = (start) => Number(process.hrtime.bigint() - start) / 1e6
const sleep = (t) => new Promise(resolve => setTimeout(resolve, t))
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] }
const text = (w, i) => `message ${i} from writer ${w}: the quick brown fox jumps over the lazy dog`

async function collect (it) {
  const out = []
  for await (const x of it) out.push(x)
  return out
}

// The newest PAGE messages, as a chat client would show them.
async function latestPage (graph, ctx, channel, model) {
  const edges = await collect(graph.edges(channel, { direction: 'in', type: 'msg', context: ctx, reverse: true, limit: PAGE }))
  if (model === 'edge') return edges.map(e => ({ id: e.from, text: e.data }))
  const out = []
  for (const e of edges) {
    const c = await graph.getContent(e.from)
    out.push({ id: e.from, text: c ? c.body : null })
  }
  return out
}

function link (a, b) {
  const s1 = a.replicate(true)
  const s2 = b.replicate(false)
  s1.pipe(s2).pipe(s1)
  s1.on('error', () => {})
  s2.on('error', () => {})
}

// ── history ──────────────────────────────────────────────────────────────────

const log = (...a) => { if (process.env.CHATLOG) console.error('[chat]', ...a) }

async function history (n, w, model, live, root) {
  const mem = memSampler()
  const peers = []
  for (let i = 0; i < w; i++) {
    const store = new Corestore(path.join(root, `w${i}`))
    const graph = new Hypergraph(store)
    await graph.ready()
    peers.push({ i, store, graph, pub: graph.identity.deviceKeyPair.publicKey.toString('hex') })
  }
  const owner = peers[0]
  for (const p of peers.slice(1)) link(owner.graph, p.graph) // a star: every member talks to the owner

  const ctx = await owner.graph.createContext()
  owner.ctx = await owner.graph.openContext(ctx)
  const channel = (await owner.graph.put({ type: 'channel' })).id
  for (const p of peers.slice(1)) {
    p.ctx = await p.graph.openContext(ctx)
    await owner.ctx.addWriter(p.ctx.localKey, { keyPair: owner.graph.identity.deviceKeyPair, member: p.pub })
  }
  log('writers added')
  for (const p of peers.slice(1)) {
    while (!p.ctx.writable) { await p.graph.update(); await sleep(50) }
    log('writable', p.i)
    if (model === 'content') await owner.graph.openUserCore(p.graph.key) // the owner keeps everyone's messages
  }

  // Fill the channel in rounds: every writer posts ROUND messages per round,
  // concurrently, so the history interleaves writers as a real channel does.
  const perWriter = Math.ceil(n / w)
  const t0 = now()
  let written = 0
  let last = null
  for (let start = 0; start < perWriter; start += ROUND) {
    await Promise.all(peers.map(async (p) => {
      const b = p.graph.batch()
      const end = Math.min(perWriter, start + ROUND)
      for (let i = start; i < end && written < n; i++, written++) {
        const msg = b.put({ type: 'msg' })
        if (model === 'content') b.putContent(msg, text(p.i, i))
        b.relate({ from: msg, to: channel, type: 'msg', context: ctx, data: model === 'edge' ? text(p.i, i) : undefined })
      }
      await b.flush()
    }))
  }
  const writeMs = ms(t0)
  log('written', written, Math.round(writeMs))

  // The owner (the only indexer) has applied and confirmed everything.
  const t1 = now()
  while (true) {
    await owner.graph.update()
    const count = await owner.graph.countEdgesIn(channel, 'msg', { context: ctx })
    const vc = owner.ctx.view.core
    log('settle', count, vc.signedLength, vc.length)
    if (count >= written && vc.signedLength === vc.length) break
    await sleep(100)
  }
  const settleMs = ms(t1)

  // Live: writer 1 posts, writer 2 (another member, through the owner) waits
  // for it. Arrival = it is the newest message in writer 2's channel.
  const sender = peers[1]
  const receiver = peers[Math.min(2, peers.length - 1)]
  if (model === 'content') await receiver.graph.openUserCore(sender.graph.key)
  const latencies = []
  for (let k = 0; k < live; k++) {
    const t = now()
    const msg = await sender.graph.put({ type: 'msg' })
    if (model === 'content') await sender.graph.putContent(msg.id, `live ${k}`)
    await sender.graph.relate({ from: msg.id, to: channel, type: 'msg', context: ctx, data: model === 'edge' ? `live ${k}` : undefined })
    const sentMs = ms(t)
    while (true) {
      if (model === 'content') await receiver.graph.update()
      const page = await collect(receiver.graph.edges(channel, { direction: 'in', type: 'msg', context: ctx, reverse: true, limit: 1 }))
      if (page[0] && page[0].from === msg.id) break
      if (ms(t) > 30000) { latencies.push(Infinity); break }
      await sleep(5)
    }
    latencies.push({ send: sentMs, arrive: ms(t) })
    log('live', k, Math.round(ms(t)))
    await sleep(50)
  }

  // The newest message once the live phase is over, as the owner has it.
  while (true) {
    await owner.graph.update()
    last = (await latestPage(owner.graph, ctx, channel, model))[0]
    if (await owner.graph.countEdgesIn(channel, 'msg', { context: ctx }) >= written + live) break
    await sleep(50)
  }

  const peak = mem.stop()
  const sizes = {
    ownerContextView: owner.ctx.view.core.byteLength,
    ownerContextViewBlocks: owner.ctx.view.core.length,
    ownerUserCore: owner.graph.core.byteLength,
    writerUserCore: sender.graph.core.byteLength
  }
  const keys = {
    ctx,
    channel,
    lastMessage: last.id,
    owner: {
      publicKey: owner.graph.identity.deviceKeyPair.publicKey.toString('hex'),
      secretKey: owner.graph.identity.deviceKeyPair.secretKey.toString('hex')
    },
    writers: peers.map(p => p.graph.key.toString('hex'))
  }
  for (const p of peers) { await p.graph.close(); await p.store.close() }
  const arrive = latencies.filter(l => l !== Infinity).map(l => l.arrive)
  return {
    n: written,
    writers: w,
    writeMs: Math.round(writeMs),
    messagesPerSec: Math.round(written / (writeMs / 1000)),
    ownerSettleMs: Math.round(settleMs),
    live: live
      ? {
          sent: live,
          lost: latencies.filter(l => l === Infinity).length,
          arriveP50: Math.round(pct(arrive, 0.5)),
          arriveP95: Math.round(pct(arrive, 0.95)),
          sendP50: Math.round(pct(latencies.filter(l => l !== Infinity).map(l => l.send), 0.5))
        }
      : null,
    sizes,
    ownerDisk: dirSize(path.join(root, 'w0')),
    writerDisk: dirSize(path.join(root, 'w1')),
    peakRss: peak.rss,
    keys
  }
}

// ── seed ─────────────────────────────────────────────────────────────────────

async function seed (dir, keys) {
  const t0 = now()
  const store = new Corestore(dir)
  const deviceKeyPair = { publicKey: Buffer.from(keys.owner.publicKey, 'hex'), secretKey: Buffer.from(keys.owner.secretKey, 'hex') }
  const graph = new Hypergraph(store, { deviceKeyPair })
  await graph.ready()
  await graph.openContext(keys.ctx)
  for (const w of keys.writers) if (w !== graph.key.toString('hex')) await graph.openUserCore(w)
  const reopenMs = ms(t0)
  const server = net.createServer((socket) => {
    const s = graph.replicate(false)
    s.pipe(socket).pipe(s)
    s.on('error', () => {})
    socket.on('error', () => {})
  })
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write(JSON.stringify({ port: server.address().port, reopenMs: Math.round(reopenMs) }) + '\n')
  })
}

// ── newcomer ─────────────────────────────────────────────────────────────────

async function newcomer (dir, port, keys, model) {
  const mem = memSampler()
  let store = new Corestore(dir)
  let graph = new Hypergraph(store)
  await graph.ready()

  let bytesIn = 0
  const socket = net.connect(port, '127.0.0.1')
  socket.on('data', (d) => { bytesIn += d.length })
  const s = graph.replicate(true)
  s.pipe(socket).pipe(s)
  s.on('error', () => {})
  socket.on('error', () => {})

  const t0 = now()
  log('newcomer: opening context')
  await graph.openContext(keys.ctx)
  log('newcomer: context open')
  // The content model needs each author's log to read message text.
  if (model === 'content') for (const w of keys.writers) await graph.openUserCore(w)

  let latest = null
  while (true) {
    if (model === 'content') await graph.update()
    const page = await latestPage(graph, keys.ctx, keys.channel, model).catch((err) => { log('page error', err.message); return [] })
    log('newcomer: page', page.length, page[0] && page[0].id === keys.lastMessage, bytesIn)
    if (page.length === PAGE && page[0].id === keys.lastMessage && page.every(m => typeof m.text === 'string')) {
      latest = { ms: Math.round(ms(t0)), bytes: bytesIn, rss: process.memoryUsage().rss }
      break
    }
    if (ms(t0) > 30 * 60 * 1000) { latest = { timedOut: true }; break }
    await sleep(20)
  }

  log('newcomer: latest', latest)
  // Scrolling all the way back: the oldest page.
  const t1 = now()
  const bytesBefore = bytesIn
  const oldest = await collect(graph.edges(keys.channel, { direction: 'in', type: 'msg', context: keys.ctx, limit: PAGE }))
  const oldestPage = { ms: Math.round(ms(t1)), bytes: bytesIn - bytesBefore, got: oldest.length }

  log('newcomer: oldest', oldestPage)
  // One update(), as an app calls it after joining.
  const t2 = now()
  await graph.update()
  const updateMs = Math.round(ms(t2))
  log('newcomer: update', updateMs)

  const peak = mem.stop()
  const disk = dirSize(dir)
  socket.destroy()
  await graph.close()
  await store.close()

  log('newcomer: closed')

  // Cold reopen: how soon is the latest page back on screen? First offline
  // (what this peer held), bounded; then with the seed reachable again.
  const reopenOnce = async (online) => {
    const t = now()
    const st = new Corestore(dir)
    const g = new Hypergraph(st)
    await g.ready()
    let sock = null
    if (online) {
      sock = net.connect(port, '127.0.0.1')
      const r = g.replicate(true)
      r.pipe(sock).pipe(r)
      r.on('error', () => {})
      sock.on('error', () => {})
    }
    await g.openContext(keys.ctx)
    if (model === 'content') for (const w of keys.writers) await g.openUserCore(w)
    const timer = new Promise(resolve => setTimeout(() => resolve(null), 10000))
    const page = await Promise.race([latestPage(g, keys.ctx, keys.channel, model).catch(() => null), timer])
    const out = page && page.length ? { ms: Math.round(ms(t)), page: page.length } : { stuck: 'no page within 10 s' }
    if (sock) sock.destroy()
    await g.close()
    await st.close()
    return out
  }
  const reopen = { offline: await reopenOnce(false), online: await reopenOnce(true) }
  log('newcomer: reopen', reopen)

  return { latest, oldestPage, updateMs, peakRss: peak.rss, disk, bytesTotal: bytesIn, reopen }
}

// ── orchestration ────────────────────────────────────────────────────────────

function child (args, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--max-old-space-size=8192', __filename, ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
    let buf = ''
    p.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim()) onLine(JSON.parse(line), p)
      }
    })
    p.on('exit', (code) => code === 0 || code === null ? resolve(p) : reject(new Error(`${args[0]} exited ${code}`)))
  })
}

async function main () {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'history-child') {
    const [n, w, model, live, root] = rest
    process.stdout.write(JSON.stringify(await history(Number(n), Number(w), model, Number(live), root)) + '\n')
    return
  }
  if (cmd === 'seed-child') {
    const [dir, keysFile] = rest
    await seed(dir, JSON.parse(fs.readFileSync(keysFile, 'utf-8')))
    return
  }
  if (cmd === 'newcomer-child') {
    const [dir, port, keysFile, model] = rest
    process.stdout.write(JSON.stringify(await newcomer(dir, Number(port), JSON.parse(fs.readFileSync(keysFile, 'utf-8')), model)) + '\n')
    return
  }

  const n = Number(cmd)
  if (!n) throw new Error('usage: node bench/chat.js <N> [--writers W] [--model edge|content] [--live M]')
  const w = Number(argValue('--writers', 10))
  const model = argValue('--model', 'edge')
  const live = Number(argValue('--live', 30))
  const root = fs.mkdtempSync(path.join(process.env.BENCH_DIR || os.tmpdir(), `hg-chat-${n}-`))
  const keysFile = path.join(root, 'keys.json')
  const out = path.join(__dirname, 'results')
  fs.mkdirSync(out, { recursive: true })
  const resultFile = path.join(out, `chat-${n}-w${w}-${model}.json`)
  const result = { n, writers: w, model, history: null, seedReopenMs: null, newcomer: null }
  const save = () => fs.writeFileSync(resultFile, JSON.stringify(result, null, 2))

  let seeder = null
  let ok = false
  try {
    await child(['history-child', String(n), String(w), model, String(live), root], (r) => { result.history = r })
    fs.writeFileSync(keysFile, JSON.stringify(result.history.keys))
    delete result.history.keys
    save()

    let seedInfo
    let seedExit
    await new Promise((resolve) => {
      seedExit = child(['seed-child', path.join(root, 'w0'), keysFile], (r, p) => { seedInfo = r; seeder = p; resolve() }).catch(() => {})
    })
    result.seedReopenMs = seedInfo.reopenMs
    save()

    try {
      await child(['newcomer-child', path.join(root, 'new'), String(seedInfo.port), keysFile, model], (r) => { result.newcomer = r })
    } catch (err) {
      result.newcomer = { crashed: err.message }
    }
    seeder.kill()
    seeder = null
    await seedExit
    save()
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    ok = !result.newcomer.crashed
  } finally {
    if (seeder) seeder.kill()
    if (process.env.KEEP || !ok) console.error('kept', root)
    else fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 })
  }
}

main().catch((err) => { console.error(err); process.exit(1) })

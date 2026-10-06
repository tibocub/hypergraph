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
//   history  — the owner (the only indexer) plus W-1 writer processes (one
//              process per writer, as on separate machines) fill the channel
//              concurrently, then a live phase: one writer posts M messages,
//              another member's process reports when each arrives.
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
const log = (...a) => { if (process.env.CHATLOG) console.error('[chat]', ...a) }
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

// ── history ──────────────────────────────────────────────────────────────────
//
// The owner (the only indexer) runs here and serves replication on a local
// port; every other writer is its own process, as on separate machines: each
// applies everyone's messages on its own core instead of all of them sharing
// one (10 in-process writers made the history ~10x slower and the measured
// write rate meaningless). Writers talk to this process over stdin/stdout
// (JSON lines).

function spawnWriter (args) {
  // Capped heap and below-normal priority: a runaway writer fails on its own
  // instead of taking the machine down with it.
  const p = spawn(process.execPath, ['--max-old-space-size=2048', __filename, 'writer-child', ...args], { stdio: ['pipe', 'pipe', 'inherit'] })
  try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
  const listeners = []
  const unread = [] // messages nobody waited for yet, kept for next()
  let buf = ''
  p.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      let taken = false
      for (const l of [...listeners]) taken = l(msg) || taken
      if (!taken) unread.push(msg)
    }
  })
  return {
    proc: p,
    send (msg) { p.stdin.write(JSON.stringify(msg) + '\n') },
    next (type) {
      const i = unread.findIndex(m => m.type === type)
      if (i !== -1) return Promise.resolve(unread.splice(i, 1)[0])
      return new Promise((resolve) => {
        const l = (msg) => {
          if (msg.type !== type) return false
          listeners.splice(listeners.indexOf(l), 1)
          resolve(msg)
          return true
        }
        listeners.push(l)
      })
    },
    on (fn) { listeners.push(fn) },
    exited: new Promise((resolve) => p.on('exit', resolve))
  }
}

async function postMessages (graph, ctx, channel, model, writer, count) {
  for (let start = 0; start < count; start += ROUND) {
    const b = graph.batch()
    for (let i = start; i < Math.min(count, start + ROUND); i++) {
      const msg = b.put({ type: 'msg' })
      if (model === 'content') b.putContent(msg, text(writer, i))
      b.relate({ from: msg, to: channel, type: 'msg', context: ctx, data: model === 'edge' ? text(writer, i) : undefined })
    }
    await b.flush()
  }
}

async function history (n, w, model, live, root) {
  const mem = memSampler()
  const ownerStore = new Corestore(path.join(root, 'w0'))
  const owner = new Hypergraph(ownerStore)
  await owner.ready()
  const ownerKp = owner.identity.deviceKeyPair
  const ctx = await owner.createContext()
  const ownerCtx = await owner.openContext(ctx)
  const channel = (await owner.put({ type: 'channel' })).id

  const server = net.createServer((socket) => {
    const s = owner.replicate(false)
    s.pipe(socket).pipe(s)
    s.on('error', () => {})
    socket.on('error', () => {})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const perWriter = Math.ceil(n / w)
  const counts = Array.from({ length: w }, (_, i) => Math.max(0, Math.min(perWriter, n - i * perWriter)))
  const writers = []
  for (let i = 1; i < w; i++) {
    const wr = spawnWriter([path.join(root, `w${i}`), String(port), ctx, channel, model, String(i), String(counts[i])])
    log('waiting for writer', i)
    const hello = await wr.next('hello')
    log('hello from writer', i)
    await ownerCtx.addWriter(Buffer.from(hello.localKey, 'hex'), { keyPair: ownerKp, member: hello.member })
    if (model === 'content') await owner.openUserCore(hello.key) // the owner keeps everyone's messages
    wr.key = hello.key
    writers.push(wr)
  }
  await Promise.all(writers.map(wr => wr.next('ready')))
  log('writers ready', writers.length)

  // Stop cleanly, writers included, if the machine runs short of memory
  // (reported as an aborted run, exit code 3).
  const guard = setInterval(() => {
    if (os.freemem() > 1e9) return
    for (const wr of writers) wr.proc.kill()
    process.stdout.write(JSON.stringify({ aborted: `free memory ${Math.round(os.freemem() / 1e6)} MB` }) + '\n', () => process.exit(3))
  }, 500)

  // Everyone posts their share at once, in batches of ROUND.
  const t0 = now()
  for (const wr of writers) wr.send({ type: 'go' })
  const writerDone = writers.map(wr => wr.next('done'))
  await postMessages(owner, ctx, channel, model, 0, counts[0])
  const perWriterMs = (await Promise.all(writerDone)).map(d => d.ms)
  const writeMs = ms(t0)
  log('written', n, Math.round(writeMs))

  // The owner has applied and confirmed everything.
  const t1 = now()
  while (true) {
    await owner.update()
    const count = await owner.countEdgesIn(channel, 'msg', { context: ctx })
    const vc = ownerCtx.view.core
    if (count >= n && vc.signedLength === vc.length) break
    await sleep(100)
  }
  const settleMs = ms(t1)

  // Live: writer 1 posts, another member (writer 2, a separate process
  // receiving through the owner) reports when each message shows as the
  // newest. The message carries its send time; both are on this machine.
  const sender = writers[0]
  const receiver = writers[1] || null
  const latencies = []
  if (live && sender && receiver) {
    receiver.send({ type: 'watch', model, senderKey: sender.key })
    await receiver.next('watching')
    const seen = new Map()
    receiver.on((msg) => { if (msg.type !== 'arrived') return false; seen.set(msg.k, msg.ms); return true })
    for (let k = 0; k < live; k++) {
      sender.send({ type: 'send', k })
      const deadline = Date.now() + 30000
      while (!seen.has(k) && Date.now() < deadline) await sleep(5)
      latencies.push(seen.has(k) ? seen.get(k) : Infinity)
      await sleep(50)
    }
    receiver.send({ type: 'unwatch' })
  }

  // The newest message once everything is in, as the owner has it.
  let last
  while (true) {
    await owner.update()
    last = (await latestPage(owner, ctx, channel, model))[0]
    if (await owner.countEdgesIn(channel, 'msg', { context: ctx }) >= n + latencies.length) break
    await sleep(50)
  }

  const peak = mem.stop()
  const sizes = {
    ownerContextView: ownerCtx.view.core.byteLength,
    ownerContextViewBlocks: ownerCtx.view.core.length,
    ownerUserCore: owner.core.byteLength
  }
  const keys = {
    ctx,
    channel,
    lastMessage: last.id,
    owner: { publicKey: ownerKp.publicKey.toString('hex'), secretKey: ownerKp.secretKey.toString('hex') },
    writers: [owner.key.toString('hex'), ...writers.map(wr => wr.key)]
  }
  clearInterval(guard)
  for (const wr of writers) wr.send({ type: 'exit' })
  await Promise.all(writers.map(wr => wr.exited))
  server.close()
  await owner.close()
  await ownerStore.close()
  const arrived = latencies.filter(l => l !== Infinity)
  return {
    n,
    writers: w,
    processes: w,
    writeMs: Math.round(writeMs),
    messagesPerSec: Math.round(n / (writeMs / 1000)),
    perWriterMs: { min: Math.min(...perWriterMs), max: Math.max(...perWriterMs) },
    ownerSettleMs: Math.round(settleMs),
    live: latencies.length
      ? { sent: latencies.length, lost: latencies.length - arrived.length, arriveP50: Math.round(pct(arrived, 0.5)), arriveP95: Math.round(pct(arrived, 0.95)) }
      : null,
    sizes,
    ownerDisk: dirSize(path.join(root, 'w0')),
    writerDisk: w > 1 ? dirSize(path.join(root, 'w1')) : null,
    peakRss: peak.rss,
    keys
  }
}

// One writer, in its own process (see history()).
async function writerProcess (dir, port, ctx, channel, model, index, count) {
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
  const store = new Corestore(dir)
  const graph = new Hypergraph(store)
  await graph.ready()
  const socket = net.connect(port, '127.0.0.1')
  const s = graph.replicate(true)
  s.pipe(socket).pipe(s)
  s.on('error', () => {})
  socket.on('error', () => {})
  const context = await graph.openContext(ctx)
  send({ type: 'hello', localKey: context.localKey.toString('hex'), member: graph.identity.deviceKeyPair.publicKey.toString('hex'), key: graph.key.toString('hex') })
  while (!context.writable) { await graph.update(); await sleep(20) }
  send({ type: 'ready' })

  let watching = false
  const commands = []
  let wake = null
  let buf = ''
  process.stdin.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.trim()) commands.push(JSON.parse(line))
    }
    if (wake) { wake(); wake = null }
  })
  const nextCommand = async () => {
    while (!commands.length) await new Promise(resolve => { wake = resolve })
    return commands.shift()
  }

  while (true) {
    const cmd = await nextCommand()
    if (cmd.type === 'go') {
      const t = now()
      await postMessages(graph, ctx, channel, model, index, count)
      send({ type: 'done', ms: Math.round(ms(t)) })
    } else if (cmd.type === 'send') {
      const msg = await graph.put({ type: 'msg' })
      const body = `live ${cmd.k} ${Date.now()}`
      if (model === 'content') await graph.putContent(msg.id, body)
      await graph.relate({ from: msg.id, to: channel, type: 'msg', context: ctx, data: model === 'edge' ? body : undefined })
    } else if (cmd.type === 'watch') {
      if (cmd.model === 'content') await graph.openUserCore(cmd.senderKey)
      watching = true
      send({ type: 'watching' })
      ;(async () => {
        let lastK = -1
        while (watching) {
          if (cmd.model === 'content') await graph.update()
          const page = await latestPage(graph, ctx, channel, cmd.model).catch(() => [])
          const m = page[0] && typeof page[0].text === 'string' && /^live (\d+) (\d+)$/.exec(page[0].text)
          if (m && Number(m[1]) > lastK) {
            lastK = Number(m[1])
            send({ type: 'arrived', k: lastK, ms: Date.now() - Number(m[2]) })
          }
          await sleep(5)
        }
      })()
    } else if (cmd.type === 'unwatch') {
      watching = false
    } else if (cmd.type === 'exit') {
      watching = false
      socket.destroy()
      await graph.close()
      await store.close()
      process.exit(0)
    }
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
  // Diagnostics: stop here, keeping the store exactly as the first session left it.
  if (process.env.CHAT_STOP_AFTER_CLOSE) return { latest, oldestPage, updateMs, peakRss: peak.rss, disk, bytesTotal: bytesIn, reopen: null }

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
    try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
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
    // 3 = stopped by the memory guard after reporting; anything else non-zero is a crash.
    p.on('exit', (code) => code === 0 || code === null || code === 3 ? resolve(p) : reject(new Error(`${args[0]} exited ${code}`)))
  })
}

async function main () {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'history-child') {
    const [n, w, model, live, root] = rest
    process.stdout.write(JSON.stringify(await history(Number(n), Number(w), model, Number(live), root)) + '\n')
    return
  }
  if (cmd === 'writer-child') {
    const [dir, port, ctx, channel, model, index, count] = rest
    await writerProcess(dir, Number(port), ctx, channel, model, Number(index), Number(count))
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
    if (result.history.aborted) {
      save()
      process.stdout.write(JSON.stringify(result, null, 2) + '\n')
      return
    }
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

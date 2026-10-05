// Scale benchmark: how does one context behave with N file entities?
//
//   node bench/scale.js <N> [--api] [--sizes]
//
// Models a SwarmFS file entry the way it would actually be stored today:
//
//   entity/create  'file'                         (author's user core)
//   content/append 'link' → swarmwire://<root>    (author's user core)
//   relation/create file --in--> dir              (the context)
//
// Files are spread over directories of 1,000. The relation points file → dir,
// not dir → file, because apply rejects a relation whose `from` the signer
// doesn't own — a member adding a file to someone else's directory can only
// express it from their own entity.
//
// Three processes, so each peer's memory is its own:
//   write  — creates the store, measures author-side cost
//   seed   — reopens it and serves it over a localhost socket
//   fetch  — a fresh peer that replicates the whole index and lists directories
//
// By default the writer uses graph.batch(), 1,000 files per batch. --api goes
// through put() / putContentRef() / relate() one file at a time, to measure
// that path.

const path = require('path')
const fs = require('fs')
const os = require('os')
const net = require('net')
const crypto = require('crypto')
const { spawn } = require('child_process')
const Corestore = require('corestore')
const hypercoreCrypto = require('hypercore-crypto')
const { Hypergraph } = require('../index.js')

const PER_DIR = 1000
const BATCH = 1000

// ── measurement helpers ──────────────────────────────────────────────────────

function retained () {
  global.gc(); global.gc()
  const m = process.memoryUsage()
  return { rss: m.rss, heap: m.heapUsed, external: m.external }
}

function memSampler () {
  const peak = { rss: 0, heap: 0 }
  const start = Date.now()
  let lastLog = 0
  const sample = () => {
    const m = process.memoryUsage()
    // RSS_LIMIT_MB: stop the joining peer cleanly rather than let it swap the machine
    // to a crawl. Reported as an aborted result, not a crash.
    if (process.env.RSS_LIMIT_MB && process.argv[2] === 'fetch-child' && m.rss > Number(process.env.RSS_LIMIT_MB) * 1e6) {
      process.stdout.write(JSON.stringify({
        aborted: `rss ${Math.round(m.rss / 1e6)} MB > RSS_LIMIT_MB`,
        afterMs: Date.now() - start,
        heap: m.heapUsed,
        progress: global.__benchProbe ? global.__benchProbe() : null
      }) + '\n', () => process.exit(3))
      clearInterval(timer)
      return
    }
    // MEMLOG=1: a memory timeline on stderr, one line a second.
    if (process.env.MEMLOG && Date.now() - lastLog >= 1000) {
      lastLog = Date.now()
      const mb = (x) => Math.round(x / 1e6)
      if (process.env.HEAPSNAP && !global.__snapped && m.heapUsed > Number(process.env.HEAPSNAP) * 1e6) {
        global.__snapped = require('v8').writeHeapSnapshot()
        console.error('mem heap snapshot', global.__snapped)
      }
      const probe = global.__benchProbe ? ' ' + JSON.stringify(global.__benchProbe()) : ''
      console.error(`mem ${process.argv[2]} t=${Math.round((lastLog - start) / 1000)}s rss=${mb(m.rss)} heap=${mb(m.heapUsed)} external=${mb(m.external)} arrayBuffers=${mb(m.arrayBuffers)}${probe}`)
    }
    if (m.rss > peak.rss) peak.rss = m.rss
    if (m.heapUsed > peak.heap) peak.heap = m.heapUsed
  }
  let timer = null
  sample()
  timer = setInterval(sample, 50)
  return { peak, stop () { sample(); clearInterval(timer); return peak } }
}

function dirSize (dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(p)
    else total += fs.statSync(p).size
  }
  return total
}

// Per-index-prefix breakdown of a Hyperbee: count, key bytes, value bytes.
// Keys are grouped by their prefix up to the first ':' (two segments for the
// multi-part prefixes), or by their first byte for binary keys.
async function beeBreakdown (bee) {
  const out = {}
  const twoPart = /^(cnt|meta|i|m|w):/
  for await (const { key, value } of bee.createReadStream({ keyEncoding: 'binary', valueEncoding: 'binary' })) {
    const text = key.toString('utf-8')
    const printable = /^[ -~]+$/.test(text)
    const prefix = printable
      ? text.split(':').slice(0, twoPart.test(text) ? 2 : 1).join(':')
      : '0x' + key[0].toString(16).padStart(2, '0')
    const o = out[prefix] || (out[prefix] = { count: 0, keyBytes: 0, valueBytes: 0 })
    o.count++
    o.keyBytes += key.byteLength
    o.valueBytes += value ? value.byteLength : 0
  }
  return out
}

const coreSize = (c) => c ? { length: c.length, byteLength: c.byteLength } : null

async function sizesOf (graph, context) {
  return {
    userCore: coreSize(graph.core),
    graphView: coreSize(graph.viewCore),
    contextView: coreSize(context.view.core),
    contextOplog: coreSize(context.base.local),
    graphViewIndexes: await beeBreakdown(graph.view.bee),
    contextViewIndexes: await beeBreakdown(context.view)
  }
}

const ms = (start) => Number(process.hrtime.bigint() - start) / 1e6
const now = () => process.hrtime.bigint()
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }

function fakeRoot (i) {
  return crypto.createHash('sha256').update('file-' + i).digest('hex')
}

function refFor (i) {
  const root = fakeRoot(i)
  return {
    src: [`swarmwire://${root}?s=${1000 + i}&n=${encodeURIComponent(`file-${i}.bin`)}`],
    size: 1000 + i,
    type: 'application/octet-stream',
    mutable: false,
    digest: `blake3:${root}`
  }
}

async function listDir (graph, ctx, dirId) {
  const t0 = now()
  const ids = []
  for await (const edge of graph.edges(dirId, { direction: 'in', type: 'in', context: ctx })) ids.push(edge.from)
  const edgesMs = ms(t0)
  const t1 = now()
  let named = 0
  for (const id of ids) {
    const c = await graph.getContent(id)
    if (c && c.reference && c.reference.valid) named++
  }
  return { count: ids.length, named, edgesMs, contentMs: ms(t1), totalMs: ms(t0) }
}

async function listingStats (graph, ctx, dirIds) {
  const picks = []
  for (let i = 0; i < 6; i++) picks.push(dirIds[Math.floor(Math.random() * dirIds.length)])
  const first = await listDir(graph, ctx, picks[0])
  const rest = []
  for (const d of picks.slice(1)) rest.push(await listDir(graph, ctx, d))
  return {
    entries: first.count,
    named: first.named,
    firstMs: Math.round(first.totalMs),
    medianMs: Math.round(median(rest.map(r => r.totalMs))),
    medianEdgesMs: Math.round(median(rest.map(r => r.edgesMs))),
    medianContentMs: Math.round(median(rest.map(r => r.contentMs)))
  }
}

// ── write ────────────────────────────────────────────────────────────────────

async function write (n, dir, api, withSizes) {
  const mem = memSampler()
  const deviceKeyPair = hypercoreCrypto.keyPair()
  const store = new Corestore(dir)
  const graph = new Hypergraph(store, { deviceKeyPair })
  await graph.ready()
  const ctx = await graph.createContext()
  const context = await graph.openContext(ctx)
  const author = graph.key.toString('hex')

  const dirCount = Math.ceil(n / PER_DIR)
  const dirIds = []
  for (let d = 0; d < dirCount; d++) dirIds.push((await graph.put({ type: 'dir' })).id)

  const baselineDiskBytes = dirSize(dir)
  const t0 = now()
  if (api) {
    for (let i = 0; i < n; i++) {
      const f = await graph.put({ type: 'file' })
      await graph.putContentRef(f.id, refFor(i))
      await graph.relate({ from: f.id, to: dirIds[Math.floor(i / PER_DIR)], type: 'in', context: ctx })
    }
  } else {
    // graph.batch(): one user-core append and one context append per
    // BATCH files.
    for (let start = 0; start < n; start += BATCH) {
      const end = Math.min(n, start + BATCH)
      const batch = graph.batch()
      for (let i = start; i < end; i++) {
        const file = batch.put({ type: 'file' })
        batch.putContentRef(file, refFor(i))
        batch.relate({ from: file, to: dirIds[Math.floor(i / PER_DIR)], type: 'in', context: ctx })
      }
      await batch.flush()
    }
  }
  const writeMs = ms(t0)

  const listing = await listingStats(graph, ctx, dirIds)
  const peak = mem.stop()
  const held = retained()
  const sizes = withSizes ? await sizesOf(graph, context) : undefined

  await graph.close()
  await store.close()

  return {
    n,
    sizes,
    retained: held,
    mode: api ? 'api' : 'batch',
    writeMs: Math.round(writeMs),
    filesPerSec: Math.round(n / (writeMs / 1000)),
    diskBytes: dirSize(dir),
    baselineDiskBytes,
    userCoreLength: n * 2 + dirCount,
    contextLength: n,
    listing,
    peakRss: peak.rss,
    peakHeap: peak.heap,
    keys: {
      ctx,
      author,
      device: { publicKey: deviceKeyPair.publicKey.toString('hex'), secretKey: deviceKeyPair.secretKey.toString('hex') },
      dirIds
    }
  }
}

// ── seed ─────────────────────────────────────────────────────────────────────

async function seed (dir, keys) {
  const deviceKeyPair = {
    publicKey: Buffer.from(keys.device.publicKey, 'hex'),
    secretKey: Buffer.from(keys.device.secretKey, 'hex')
  }
  const t0 = now()
  const store = new Corestore(dir)
  const graph = new Hypergraph(store, { deviceKeyPair })
  await graph.ready()
  await graph.openContext(keys.ctx)
  const reopenMs = ms(t0)

  const server = net.createServer((socket) => {
    const s = store.replicate(false)
    s.pipe(socket).pipe(s)
    s.on('error', () => {})
    socket.on('error', () => {})
  })
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write(JSON.stringify({ port: server.address().port, reopenMs: Math.round(reopenMs) }) + '\n')
  })
}

// ── fetch ────────────────────────────────────────────────────────────────────

async function fetchIndex (dir, port, keys, n) {
  const mem = memSampler()
  const store = new Corestore(dir)
  const graph = new Hypergraph(store)
  await graph.ready()
  const baselineDiskBytes = dirSize(dir)

  const socket = net.connect(port, '127.0.0.1')
  const s = store.replicate(true)
  s.pipe(socket).pipe(s)
  s.on('error', () => {})
  socket.on('error', () => {})

  const t0 = now()
  // FETCH_ONLY=ctx|log: replicate just one half of the index (diagnostics).
  const only = process.env.FETCH_ONLY
  const context = await graph.openContext(keys.ctx)
  const authorCore = only === 'ctx' ? { core: { length: 0, contiguousLength: 0 } } : await graph.openUserCore(keys.author)
  if (only === 'log') await context.close()
  global.__benchProbe = () => ({
    ctxApplied: context.base.length,
    ctxView: context.view.core.length,
    log: authorCore.core.length,
    logHeld: authorCore.core.contiguousLength
  })

  // How many times Autobase called apply: one per writer batch. Bench-only
  // peek at a private handler, to show how the writer's grouping carries over.
  let applyCalls = 0
  const handlers = context.base._handlers
  const apply = handlers.apply
  handlers.apply = (...args) => { applyCalls++; return apply(...args) }

  const lastDir = keys.dirIds[keys.dirIds.length - 1]
  const lastDirSize = n - (keys.dirIds.length - 1) * PER_DIR
  const lastFile = `file/${keys.author}/${keys.dirIds.length + 2 * (n - 1)}`

  let firstListable = null
  // Polled on its own timer: update() can be busy indexing users' logs for a
  // long time, while the context becomes listable as soon as it is fetched or
  // fast-forwarded (Autobase advances by itself as data arrives).
  const listableWatch = setInterval(async () => {
    if (firstListable !== null) return
    try {
      if (await graph.countEdgesIn(keys.dirIds[0], 'in', { context: keys.ctx }) === Math.min(PER_DIR, n)) firstListable = ms(t0)
    } catch {}
  }, 100)
  let rounds = 0
  while (true) {
    rounds++
    await graph.update()
    const ready = only === 'ctx'
      ? await graph.countEdgesIn(lastDir, 'in', { context: keys.ctx }) === lastDirSize
      : only === 'log'
        ? await graph.getContent(lastFile)
        : await graph.countEdgesIn(lastDir, 'in', { context: keys.ctx }) === lastDirSize && await graph.getContent(lastFile)
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const replicateMs = ms(t0)
  clearInterval(listableWatch)
  if (firstListable === null) firstListable = replicateMs
  if (process.env.MEMLOG) console.error(`mem fetch-child phase: joined after ${Math.round(replicateMs / 1000)}s`)

  const listing = await listingStats(graph, keys.ctx, keys.dirIds)
  if (process.env.MEMLOG) console.error('mem fetch-child phase: listing done')
  const contextStatus = await context.status()
  const peak = mem.stop()
  const held = retained()

  socket.destroy()
  await graph.close()
  await store.close()

  return {
    retained: held,
    applyCalls,
    fastForwards: contextStatus.fastForwards,
    confirmed: `${contextStatus.confirmedLength}/${contextStatus.length}`,
    replicateMs: Math.round(replicateMs),
    firstDirListableMs: Math.round(firstListable),
    rounds,
    diskBytes: dirSize(dir),
    baselineDiskBytes,
    listing,
    peakRss: peak.rss,
    peakHeap: peak.heap
  }
}

// ── orchestration ────────────────────────────────────────────────────────────

function child (args, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--max-old-space-size=8192', '--expose-gc', __filename, ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
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
    // 3 = stopped by RSS_LIMIT_MB after reporting; anything else non-zero is a crash.
    p.on('exit', (code) => code === 0 || code === null || code === 3 ? resolve(p) : reject(new Error(`${args[0]} exited ${code}`)))
  })
}

async function main () {
  const [cmd, ...rest] = process.argv.slice(2)

  // HG_INDEX_BATCH / HG_PREFETCH_WINDOW: override src/tuning.js (for sweeps).
  const tuning = require('../src/tuning.js')
  if (process.env.HG_INDEX_BATCH) tuning.INDEX_BATCH = Number(process.env.HG_INDEX_BATCH)
  if (process.env.HG_PREFETCH_WINDOW) tuning.PREFETCH_WINDOW = Number(process.env.HG_PREFETCH_WINDOW)

  if (cmd === 'write-child') {
    const [n, dir, api, sizes] = rest
    const r = await write(Number(n), dir, api === 'api', sizes === 'sizes')
    process.stdout.write(JSON.stringify(r) + '\n')
    return
  }
  if (cmd === 'seed-child') {
    const [dir, keysFile] = rest
    await seed(dir, JSON.parse(fs.readFileSync(keysFile, 'utf-8')))
    return
  }
  if (cmd === 'fetch-child') {
    const [dir, port, keysFile, n] = rest
    const r = await fetchIndex(dir, Number(port), JSON.parse(fs.readFileSync(keysFile, 'utf-8')), Number(n))
    process.stdout.write(JSON.stringify(r) + '\n')
    return
  }

  const n = Number(cmd)
  if (!n) throw new Error('usage: node bench/scale.js <N> [--api] [--sizes]')
  const api = rest.includes('--api')
  const withSizes = rest.includes('--sizes')
  const root = fs.mkdtempSync(path.join(process.env.BENCH_DIR || os.tmpdir(), `hg-scale-${n}-`)) // BENCH_DIR: where the stores go (1M needs ~15 GB)
  const aDir = path.join(root, 'a')
  const bDir = path.join(root, 'b')
  const keysFile = path.join(root, 'keys.json')

  const out = path.join(__dirname, 'results')
  fs.mkdirSync(out, { recursive: true })
  const resultFile = path.join(out, `scale-${n}${api ? '-api' : ''}.json`)
  const result = { n, write: null, seedReopenMs: null, fetch: null }
  // Saved after every phase, so a crash later on (a 1M join, say) does not
  // lose what was already measured.
  const save = () => fs.writeFileSync(resultFile, JSON.stringify(result, null, 2))

  let seeder = null
  let ok = false
  try {
    let written
    await child(['write-child', String(n), aDir, api ? 'api' : 'batch', withSizes ? 'sizes' : ''], (r) => { written = r })
    fs.writeFileSync(keysFile, JSON.stringify(written.keys))
    delete written.keys
    result.write = written
    save()

    let seedInfo
    let seedExit
    await new Promise((resolve) => {
      seedExit = child(['seed-child', aDir, keysFile], (r, p) => { seedInfo = r; seeder = p; resolve() }).catch(() => {})
    })
    result.seedReopenMs = seedInfo.reopenMs
    save()

    try {
      await child(['fetch-child', bDir, String(seedInfo.port), keysFile, String(n)], (r) => { result.fetch = r })
    } catch (err) {
      result.fetch = { crashed: err.message }
    }
    seeder.kill()
    seeder = null
    await seedExit
    save()

    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    ok = !result.fetch.crashed && !result.fetch.aborted
  } finally {
    if (seeder) seeder.kill()
    // Stores are kept whenever something went wrong: they are the evidence.
    if (process.env.KEEP || !ok) console.error('kept', root)
    else fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 })
  }
}

main().catch((err) => { console.error(err); process.exit(1) })

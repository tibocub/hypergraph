// Scale benchmark: how does one context behave with N file entities?
//
//   node bench/scale.js <N> [--api]
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
// By default the writer appends events in batches (same bytes the API writes,
// signed the same way) so 1M is reachable. --api goes through put() /
// putContentRef() / relate() one file at a time, to measure that path.

const path = require('path')
const fs = require('fs')
const os = require('os')
const net = require('net')
const crypto = require('crypto')
const { spawn } = require('child_process')
const Corestore = require('corestore')
const hypercoreCrypto = require('hypercore-crypto')
const { Hypergraph } = require('../index.js')
const { encodeEvent } = require('../src/encodings/event.js')
const { stableRelationHash } = require('../src/utils.js')
const { formatReference } = require('../src/content-ref.js')

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
  const sample = () => {
    const m = process.memoryUsage()
    if (m.rss > peak.rss) peak.rss = m.rss
    if (m.heapUsed > peak.heap) peak.heap = m.heapUsed
  }
  sample()
  const timer = setInterval(sample, 50)
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

async function write (n, dir, api) {
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
  const split = { buildSign: 0, coreAppend: 0, ctxAppend: 0, ctxApply: 0, viewIndex: 0 }
  const t0 = now()
  if (api) {
    for (let i = 0; i < n; i++) {
      const f = await graph.put({ type: 'file' })
      await graph.putContentRef(f.id, refFor(i))
      await graph.relate({ from: f.id, to: dirIds[Math.floor(i / PER_DIR)], type: 'in', context: ctx })
    }
  } else {
    for (let start = 0; start < n; start += BATCH) {
      const end = Math.min(n, start + BATCH)
      let tt = now()
      let seq = graph.core.length
      const coreEvents = []
      const relations = []
      for (let i = start; i < end; i++) {
        const ts = Date.now()
        const fileId = `file/${author}/${seq}`
        coreEvents.push({ type: 'entity/create', id: '', entityType: 'file', author, timestamp: ts })
        coreEvents.push({ type: 'content/append', entityId: fileId, contentType: 'link', body: formatReference(refFor(i)), timestamp: ts })
        seq += 2
        const rel = { type: 'relation/create', from: fileId, to: dirIds[Math.floor(i / PER_DIR)], relationType: 'in', author, timestamp: ts, signature: null }
        rel.signature = hypercoreCrypto.sign(stableRelationHash(rel, ctx), deviceKeyPair.secretKey).toString('hex')
        relations.push(rel)
      }
      split.buildSign += ms(tt); tt = now()
      await graph.core.append(coreEvents.map(encodeEvent))
      split.coreAppend += ms(tt); tt = now()
      for (const r of relations) await context.base.append(r, { optimistic: true })
      split.ctxAppend += ms(tt); tt = now()
      await context.base.update()
      split.ctxApply += ms(tt); tt = now()
      await graph.update()
      split.viewIndex += ms(tt)
    }
  }
  const writeMs = ms(t0)

  const listing = await listingStats(graph, ctx, dirIds)
  const peak = mem.stop()
  const held = retained()

  await graph.close()
  await store.close()

  return {
    n,
    retained: held,
    mode: api ? 'api' : 'batch',
    writeMs: Math.round(writeMs),
    filesPerSec: Math.round(n / (writeMs / 1000)),
    diskBytes: dirSize(dir),
    baselineDiskBytes,
    splitMs: Object.fromEntries(Object.entries(split).map(([k, v]) => [k, Math.round(v)])),
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
  await graph.openContext(keys.ctx)
  await graph.openUserCore(keys.author)

  const lastDir = keys.dirIds[keys.dirIds.length - 1]
  const lastDirSize = n - (keys.dirIds.length - 1) * PER_DIR
  const lastFile = `file/${keys.author}/${keys.dirIds.length + 2 * (n - 1)}`

  let firstListable = null
  let rounds = 0
  while (true) {
    rounds++
    await graph.update()
    if (firstListable === null && await graph.countEdgesIn(keys.dirIds[0], 'in', { context: keys.ctx }) === Math.min(PER_DIR, n)) {
      firstListable = ms(t0)
    }
    const ready = await graph.countEdgesIn(lastDir, 'in', { context: keys.ctx }) === lastDirSize &&
      await graph.getContent(lastFile)
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const replicateMs = ms(t0)

  const listing = await listingStats(graph, keys.ctx, keys.dirIds)
  const peak = mem.stop()
  const held = retained()

  socket.destroy()
  await graph.close()
  await store.close()

  return {
    retained: held,
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
    p.on('exit', (code) => code === 0 || code === null ? resolve(p) : reject(new Error(`${args[0]} exited ${code}`)))
  })
}

async function main () {
  const [cmd, ...rest] = process.argv.slice(2)

  if (cmd === 'write-child') {
    const [n, dir, api] = rest
    const r = await write(Number(n), dir, api === 'api')
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
  if (!n) throw new Error('usage: node bench/scale.js <N> [--api]')
  const api = rest.includes('--api')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hg-scale-${n}-`))
  const aDir = path.join(root, 'a')
  const bDir = path.join(root, 'b')
  const keysFile = path.join(root, 'keys.json')

  try {
    let written
    await child(['write-child', String(n), aDir, api ? 'api' : 'batch'], (r) => { written = r })
    fs.writeFileSync(keysFile, JSON.stringify(written.keys))
    delete written.keys

    let seeder
    let seedInfo
    let seedExit
    await new Promise((resolve) => {
      seedExit = child(['seed-child', aDir, keysFile], (r, p) => { seedInfo = r; seeder = p; resolve() }).catch(() => {})
    })

    let fetched
    await child(['fetch-child', bDir, String(seedInfo.port), keysFile, String(n)], (r) => { fetched = r })
    seeder.kill()
    await seedExit

    const result = { n, write: written, seedReopenMs: seedInfo.reopenMs, fetch: fetched }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    const out = path.join(__dirname, 'results')
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, `scale-${n}${api ? '-api' : ''}.json`), JSON.stringify(result, null, 2))
  } finally {
    if (process.env.KEEP) console.error('kept', root)
    else fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 })
  }
}

main().catch((err) => { console.error(err); process.exit(1) })

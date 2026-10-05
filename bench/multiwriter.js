// Multi-writer context: K peers, all writers (hence all indexers, as
// hypergraph adds them today), each bulk-writing N/K files concurrently.
//
//   node bench/multiwriter.js <K> <N>
//
// Reports time to convergence and, per peer, how much of the context view is
// signed (indexed) vs merely applied — the part a fast-forwarding newcomer
// could jump to.
//
// HG_ACK_INTERVAL only has an effect with an experiment toggle in
// src/context-base.js (ackInterval is hard-coded to 0 there); the numbers in
// specs/research/scaling-study.md were taken that way.

const os = require('os')
const fs = require('fs')
const path = require('path')
const Corestore = require('corestore')
const { Hypergraph } = require('../index.js')

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function main () {
  const K = Number(process.argv[2] || 3)
  const N = Number(process.argv[3] || 6000)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-mw-'))
  const peers = []
  for (let i = 0; i < K; i++) {
    const store = new Corestore(path.join(root, String(i)))
    const graph = new Hypergraph(store)
    await graph.ready()
    peers.push({ store, graph })
  }
  const streams = []
  for (let i = 0; i < K; i++) {
    for (let j = i + 1; j < K; j++) {
      const s1 = peers[i].store.replicate(true, { live: true })
      const s2 = peers[j].store.replicate(false, { live: true })
      s1.pipe(s2).pipe(s1)
      streams.push(s1, s2)
    }
  }

  const ctx = await peers[0].graph.createContext()
  for (const p of peers) p.context = await p.graph.openContext(ctx)
  for (const p of peers.slice(1)) await peers[0].context.addWriter(p.context.localKey)
  for (const p of peers) {
    while (!p.context.writable) { await p.graph.update(); await sleep(50) }
    for (const q of peers) if (q !== p) await p.graph.openUserCore(q.graph.key)
  }

  const t0 = Date.now()
  await Promise.all(peers.map(async (p) => {
    const dir = await p.graph.put({ type: 'dir' })
    p.dir = dir.id
    for (let start = 0; start < N / K; start += 1000) {
      const b = p.graph.batch()
      for (let i = start; i < Math.min(N / K, start + 1000); i++) b.relate({ from: b.put({ type: 'file' }), to: dir.id, type: 'in', context: ctx })
      await b.flush()
    }
  }))
  const writeMs = Date.now() - t0

  const total = async (p) => {
    let n = 0
    for (const q of peers) n += await p.graph.countEdgesIn(q.dir, 'in', { context: ctx })
    return n
  }
  let converged = null
  for (let i = 0; i < 1200; i++) {
    await Promise.all(peers.map(p => p.graph.update()))
    const counts = await Promise.all(peers.map(total))
    if (counts.every(c => c === N)) { converged = Date.now() - t0; break }
    await sleep(100)
  }
  for (let i = 0; i < 10; i++) { await sleep(1000); await Promise.all(peers.map(p => p.graph.update())) }

  const report = {
    K,
    N,
    ackInterval: process.env.HG_ACK_INTERVAL || 0,
    writeMs,
    convergedMs: converged,
    peers: peers.map((p, i) => ({
      peer: i,
      edges: null,
      viewLength: p.context.view.core.length,
      viewSigned: p.context.view.core.signedLength,
      baseIndexed: p.context.base.indexedLength,
      baseLength: p.context.base.length
    }))
  }
  for (let i = 0; i < K; i++) report.peers[i].edges = await total(peers[i])
  console.log(JSON.stringify(report, null, 2))

  for (const s of streams) s.destroy()
  for (const p of peers) { await p.graph.close(); await p.store.close() }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 })
}

main().catch((err) => { console.error(err); process.exit(1) })

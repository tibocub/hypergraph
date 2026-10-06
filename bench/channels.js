// Many channels: what does it cost a member to have C channels (contexts) open?
//
//   node bench/channels.js <C> [--messages M] [--authors A]
//
// A community with C channels of M messages each (text on the relation, as in
// bench/chat.js), and A authors whose logs the member has opened. Measured on
// the member that holds everything, then after a cold restart:
//   - time to open all channels, memory per open channel
//   - graph.update() with nothing new: does an idle update cost grow with C?
//   - live arrival in one channel while C are open
//   - disk

const path = require('path')
const fs = require('fs')
const os = require('os')
const Corestore = require('corestore')
const { Hypergraph } = require('../index.js')

const argValue = (name, def) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? def : process.argv[i + 1]
}
const now = () => process.hrtime.bigint()
const ms = (start) => Number(process.hrtime.bigint() - start) / 1e6
const sleep = (t) => new Promise(resolve => setTimeout(resolve, t))
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] }
const mb = (x) => Math.round(x / 1e6)

function dirSize (dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size
  }
  return total
}

async function idleUpdates (graph, k = 20) {
  const times = []
  for (let i = 0; i < k; i++) {
    const t = now()
    await graph.update()
    times.push(ms(t))
  }
  return { p50: Math.round(pct(times, 0.5) * 10) / 10, p95: Math.round(pct(times, 0.95) * 10) / 10 }
}

async function main () {
  const C = Number(process.argv[2] || 10)
  const M = Number(argValue('--messages', 200))
  const A = Number(argValue('--authors', 5))
  const root = fs.mkdtempSync(path.join(process.env.BENCH_DIR || os.tmpdir(), `hg-channels-${C}-`))
  const result = { channels: C, messagesPerChannel: M, authors: A }

  try {
    // The member: owner of every channel, holding everything.
    let store = new Corestore(path.join(root, 'member'))
    let graph = new Hypergraph(store)
    await graph.ready()
    const deviceKeyPair = graph.identity.deviceKeyPair

    // Other authors' logs the member follows (each with a little content).
    const authorKeys = []
    for (let a = 0; a < A; a++) {
      const s = new Corestore(path.join(root, `author${a}`))
      const g = new Hypergraph(s)
      await g.ready()
      const b = g.batch()
      for (let i = 0; i < 100; i++) b.put({ type: 'note' })
      await b.flush()
      const s1 = store.replicate(true); const s2 = s.replicate(false); s1.pipe(s2).pipe(s1)
      const uc = await graph.openUserCore(g.key)
      while (uc.core.contiguousLength < 100) await sleep(20)
      authorKeys.push(g.key.toString('hex'))
      s1.destroy(); s2.destroy()
      await g.close(); await s.close()
    }

    const t0 = now()
    const channels = []
    for (let c = 0; c < C; c++) {
      const ctx = await graph.createContext()
      await graph.openContext(ctx)
      const channel = (await graph.put({ type: 'channel' })).id
      const b = graph.batch()
      for (let i = 0; i < M; i++) b.relate({ from: b.put({ type: 'msg' }), to: channel, type: 'msg', context: ctx, data: `message ${i} in channel ${c}` })
      await b.flush()
      channels.push({ ctx, channel })
    }
    result.createMs = Math.round(ms(t0))
    await graph.update()
    global.gc && global.gc()
    result.rssWithAllOpen = process.memoryUsage().rss
    result.idleUpdateWarm = await idleUpdates(graph)

    // Live arrival in the last channel, from another device of a member
    // (a second graph replicating with this one).
    const otherStore = new Corestore(path.join(root, 'other'))
    const other = new Hypergraph(otherStore)
    await other.ready()
    const r1 = graph.replicate(true); const r2 = other.replicate(false); r1.pipe(r2).pipe(r1)
    const target = channels[channels.length - 1]
    const otherCtx = await other.openContext(target.ctx)
    const ownerCtx = await graph.openContext(target.ctx)
    await ownerCtx.addWriter(otherCtx.localKey, { keyPair: deviceKeyPair, member: other.identity.deviceKeyPair.publicKey.toString('hex') })
    while (!otherCtx.writable) { await other.update(); await sleep(20) }
    const lat = []
    for (let k = 0; k < 20; k++) {
      const t = now()
      const msg = await other.put({ type: 'msg' })
      await other.relate({ from: msg.id, to: target.channel, type: 'msg', context: target.ctx, data: `live ${k}` })
      while (true) {
        await graph.update() // the member's app loop: one update() covers every channel
        const page = []
        for await (const e of graph.edges(target.channel, { direction: 'in', type: 'msg', context: target.ctx, reverse: true, limit: 1 })) page.push(e)
        if (page[0] && page[0].from === msg.id) break
        if (ms(t) > 30000) break
      }
      lat.push(ms(t))
    }
    result.liveArrival = { p50: Math.round(pct(lat, 0.5)), p95: Math.round(pct(lat, 0.95)) }
    r1.destroy(); r2.destroy()
    await other.close(); await otherStore.close()
    await graph.close(); await store.close()

    // Cold restart: open every channel again.
    const t1 = now()
    store = new Corestore(path.join(root, 'member'))
    graph = new Hypergraph(store, { deviceKeyPair })
    await graph.ready()
    for (const k of authorKeys) await graph.openUserCore(k)
    for (const c of channels) await graph.openContext(c.ctx)
    result.reopenAllMs = Math.round(ms(t1))
    const t2 = now()
    for await (const e of graph.edges(channels[0].channel, { direction: 'in', type: 'msg', context: channels[0].ctx, reverse: true, limit: 50 })) { if (!e) break }
    result.firstPageAfterReopenMs = Math.round(ms(t2))
    global.gc && global.gc()
    result.rssAfterReopen = process.memoryUsage().rss
    result.idleUpdateCold = await idleUpdates(graph)
    await graph.close(); await store.close()
    result.memberDisk = dirSize(path.join(root, 'member'))

    const out = path.join(__dirname, 'results')
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, `channels-${C}x${M}.json`), JSON.stringify(result, null, 2))
    console.log(JSON.stringify({ ...result, rssWithAllOpenMB: mb(result.rssWithAllOpen), rssAfterReopenMB: mb(result.rssAfterReopen), memberDiskMB: mb(result.memberDisk) }, null, 2))
  } finally {
    if (process.env.KEEP) console.error('kept', root)
    else fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 })
  }
}

main().catch((err) => { console.error(err); process.exit(1) })

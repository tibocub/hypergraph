// Many members: what does the size of a context's member list cost?
//
//   node --expose-gc bench/members.js <M> [--messages N]
//
// One channel with M members (writers, added with generated keys: they never
// write, which isolates the cost of the list itself) and N messages from the
// owner. Measures the owner's idle update(), memory, and a newcomer joining
// over an in-process stream: time and bytes to the latest page.

const path = require('path')
const fs = require('fs')
const os = require('os')
const Corestore = require('corestore')
const crypto = require('hypercore-crypto')
const { Hypergraph } = require('../index.js')

const argValue = (name, def) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? def : process.argv[i + 1]
}
const now = () => process.hrtime.bigint()
const ms = (start) => Number(process.hrtime.bigint() - start) / 1e6
const sleep = (t) => new Promise(resolve => setTimeout(resolve, t))
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] }

async function main () {
  const M = Number(process.argv[2] || 100)
  const N = Number(argValue('--messages', 200))
  const root = fs.mkdtempSync(path.join(process.env.BENCH_DIR || os.tmpdir(), `hg-members-${M}-`))
  const result = { members: M, messages: N }
  try {
    const store = new Corestore(path.join(root, 'owner'))
    const graph = new Hypergraph(store)
    await graph.ready()
    const kp = graph.identity.deviceKeyPair
    const ctx = await graph.createContext()
    const context = await graph.openContext(ctx)

    const t0 = now()
    for (let i = 0; i < M; i++) {
      const member = crypto.keyPair()
      const writer = crypto.keyPair()
      await context.addWriter(writer.publicKey, { keyPair: kp, member: member.publicKey.toString('hex') })
    }
    await graph.update()
    result.addMembersMs = Math.round(ms(t0))
    result.writerKeys = context.writerKeys().length

    const channel = (await graph.put({ type: 'channel' })).id
    const b = graph.batch()
    for (let i = 0; i < N; i++) b.relate({ from: b.put({ type: 'msg' }), to: channel, type: 'msg', context: ctx, data: `message ${i}` })
    await b.flush()
    await graph.update()

    const idle = []
    for (let i = 0; i < 20; i++) { const t = now(); await graph.update(); idle.push(ms(t)) }
    result.idleUpdate = { p50: Math.round(pct(idle, 0.5) * 10) / 10, p95: Math.round(pct(idle, 0.95) * 10) / 10 }
    global.gc && global.gc()
    result.ownerRss = Math.round(process.memoryUsage().rss / 1e6)
    while (context.view.core.signedLength < context.view.core.length) { await graph.update(); await sleep(50) }

    // A newcomer.
    const nStore = new Corestore(path.join(root, 'new'))
    const newcomer = new Hypergraph(nStore)
    await newcomer.ready()
    let bytes = 0
    const s1 = graph.replicate(true)
    const s2 = newcomer.replicate(false)
    s1.on('data', (d) => { bytes += d.length })
    s1.pipe(s2).pipe(s1)
    const t1 = now()
    await newcomer.openContext(ctx)
    while (true) {
      const page = []
      for await (const e of newcomer.edges(channel, { direction: 'in', type: 'msg', context: ctx, reverse: true, limit: 50 })) page.push(e)
      if (page.length === Math.min(50, N)) break
      if (ms(t1) > 600000) { result.newcomerTimedOut = true; break }
      await sleep(20)
    }
    result.newcomerLatestMs = Math.round(ms(t1))
    result.newcomerBytes = bytes
    const idleNew = []
    for (let i = 0; i < 10; i++) { const t = now(); await newcomer.update(); idleNew.push(ms(t)) }
    result.newcomerIdleUpdate = { p50: Math.round(pct(idleNew, 0.5) * 10) / 10 }
    s1.destroy(); s2.destroy()
    await newcomer.close(); await nStore.close()
    await graph.close(); await store.close()

    const out = path.join(__dirname, 'results')
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, `members-${M}.json`), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result))
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 })
  }
}

main().catch((err) => { console.error(err); process.exit(1) })

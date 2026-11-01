// What each held log costs in memory (lib/directory.js keeps every accepted
// log's Hypercore session open for the space's life, with a live download
// range and listeners: lib/replication.js hold()). Here: N cores of 2 blocks
// in one Corestore, then all N opened at once as sessions with a download
// range and two listeners, as a full member holds them. No peers attached
// (a peer adds per-core replication state: not measured).
//   node --expose-gc bench/scale-audit/open-logs.js 1000,5000,20000
const Corestore = require('corestore')
const { tmpDir, rm, mb, mem } = require('./_tmp.js')

const sizes = (process.argv[2] || '1000,5000,20000').split(',').map(Number)

async function run (n) {
  const dir = tmpDir('logs')
  let store = new Corestore(dir)
  const keys = []
  for (let i = 0; i < n; i++) {
    const core = store.get({ name: 'log-' + i })
    await core.append([Buffer.alloc(270), Buffer.alloc(110)]) // header + one post
    keys.push(core.key)
    await core.close()
  }
  await store.close()
  store = new Corestore(dir)
  await store.ready()
  const before = mem()
  const t = Date.now()
  const cores = []
  for (const key of keys) {
    const core = store.get({ key })
    await core.ready()
    core.on('append', () => {})
    core.on('download', () => {})
    const range = core.download({ start: 2, end: -1 })
    cores.push({ core, range })
  }
  const openMs = Date.now() - t
  const after = mem()
  console.log(`${n} logs open: ${openMs} ms (${(openMs / n).toFixed(2)} ms each); +${mb(after.heap - before.heap)} heap, +${mb(after.rss - before.rss)} RSS, +${mb(after.ext - before.ext)} buffers → ${((after.rss - before.rss) / n / 1024).toFixed(1)} KB RSS / ${((after.heap - before.heap) / n / 1024).toFixed(1)} KB heap per log`)
  for (const { core, range } of cores) { range.destroy(); await core.close() }
  await store.close()
  rm(dir)
}

;(async () => { for (const n of sizes) await run(n) })()

// What an engine pays at start for each space it holds (lib/index.js _open:
// every space opened one after another, its decision log, logs and topic),
// and its memory while they are all open. No network (bootstrap: []), one
// post per space: the floor, not a busy site.
//   node --expose-gc bench/scale-audit/many-spaces.js 20,100
const { Hypergraph } = require('../../lib/index.js')
const { tmpDir, rm, mb, mem } = require('./_tmp.js')

const sizes = (process.argv[2] || '20,100').split(',').map(Number)
const types = { post: { fields: { title: 'string' } } }

async function run (n) {
  const dir = tmpDir('spaces')
  let hg = await Hypergraph.open(dir, { types, bootstrap: [] })
  for (let i = 0; i < n; i++) {
    const s = await hg.createSpace({ name: 'site ' + i })
    await s.put('post', { title: 'hello' })
  }
  await hg.close()
  const empty = tmpDir('spaces0')
  const base0 = mem()
  const h0 = await Hypergraph.open(empty, { types, bootstrap: [] })
  const base = mem()
  await h0.close()
  rm(empty)
  const b = mem()
  const t = Date.now()
  hg = await Hypergraph.open(dir, { types, bootstrap: [] })
  const ms = Date.now() - t
  const a = mem()
  console.log(`${n} spaces: open ${ms} ms (${(ms / n).toFixed(0)} ms per space); +${mb(a.rss - b.rss)} RSS, +${mb(a.heap - b.heap)} heap → ~${((a.rss - b.rss) / n / 1048576).toFixed(2)} MB RSS per space (an empty instance: +${mb(base.rss - base0.rss)})`)
  await hg.close()
  rm(dir)
}

;(async () => { for (const n of sizes) await run(n) })()

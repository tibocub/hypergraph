// What `count` / `sum` / `linked` cost as one post gathers reactions
// (lib/space.js count → #pointingAt → linkedRows: every row pointing at the
// post is read and judged), per read. One instance, one author, `like` (not one per member, so one
// author can write many). A live read re-runs this whole read (lib/space.js
// _live), so the per-read time here is also the cost of each update.
//   node bench/scale-audit/count.js 1000,10000
const { Hypergraph } = require('../../lib/index.js')
const { tmpDir, rm } = require('./_tmp.js')

const sizes = (process.argv[2] || '1000,10000').split(',').map(Number)
const types = {
  post: { fields: { title: 'string' } },
  like: { fields: { value: 'int', on: 'link' }, links: { on: ['post'] } }
}

async function time (fn, n = 5) {
  const out = []
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint()
    await fn()
    out.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  return out.sort((a, b) => a - b)[Math.floor(n / 2)]
}

async function run (n) {
  const dir = tmpDir('count')
  const hg = await Hypergraph.open(dir, { types, bootstrap: [] })
  const s = await hg.createSpace({ name: 'x' })
  const post = await s.put('post', { title: 'hot' })
  const t = Date.now()
  for (let i = 0; i < n; i++) await s.put('like', { value: 1, on: post })
  const writeMs = Date.now() - t
  const count = await time(() => s.count('like', { on: post }))
  const sum = await time(() => s.sum('like', 'value', { on: post }))
  console.log(`${n} likes on one post: count ${count.toFixed(1)} ms, sum ${sum.toFixed(1)} ms (median of 5); writing them ${(n / writeMs * 1000).toFixed(0)}/s`)
  await hg.close()
  rm(dir)
}

;(async () => { for (const n of sizes) await run(n) })()

// Measures what one app index entry costs on disk (core follow-ups, item 5):
// N records of a type with K indexed fields vs the same records with none.
//   node bench/next/ix-cost.js [N]
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Hypergraph } = require('../../lib/index.js')
const testing = require('../../lib/testing.js')

const N = Number(process.argv[2]) || 2000
const du = (d) => fs.readdirSync(d).reduce((n, f) => { const p = path.join(d, f); const s = fs.statSync(p); return n + (s.isDirectory() ? du(p) : s.size) }, 0)

async function run (k) {
  const fields = { a: 'string', b: 'string', c: 'string', text: 'text' }
  const index = [['a', 'stamp'], ['b', 'stamp'], ['c', 'stamp']].slice(0, k)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ixcost-'))
  const hg = await Hypergraph.open(dir, { types: { item: { fields, index } }, bootstrap: [] })
  const s = await hg.createSpace({ name: 'x' })
  for (let i = 0; i < N; i++) await s.put('item', { a: 'alpha' + (i % 50), b: 'beta' + (i % 7), c: 'gamma-' + i, text: 'x'.repeat(100) })
  await testing.compact(hg)
  await hg.close()
  const bytes = du(dir)
  fs.rmSync(dir, { recursive: true, force: true })
  return bytes
}

;(async () => {
  const base = await run(0)
  for (const k of [1, 3]) {
    const b = await run(k)
    console.log(`${k} index(es): +${((b - base) / N).toFixed(1)} B per record, ${((b - base) / N / k).toFixed(1)} B per entry`)
  }
})()

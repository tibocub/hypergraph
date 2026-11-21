// Lists files under <out-dir> (folders summed) and the ones holding the marker.
//   node research/privacy/electron-traces/check.js <out-dir>
const fs = require('fs')
const path = require('path')

const out = process.argv[2]
const MARKER = Buffer.from('MARKER029' + 'XYZZY')
const groups = {}
const hits = []
for (const f of fs.readdirSync(out, { recursive: true })) {
  const p = path.join(out, f)
  let st
  try { st = fs.statSync(p) } catch { continue }
  if (!st.isFile()) continue
  const parts = f.split(path.sep)
  const g = parts.slice(0, Math.min(parts.length, 3)).join('/')
  groups[g] = (groups[g] || 0) + st.size
  try { if (fs.readFileSync(p).includes(MARKER)) hits.push(f) } catch { hits.push(f + ' (locked)') }
}
console.log('files (first three path parts, bytes):')
for (const [g, n] of Object.entries(groups).sort()) console.log('  ' + g.padEnd(60) + n)
console.log('holding the marker:', hits.length ? '' : 'none')
for (const h of hits) console.log('  ' + h)

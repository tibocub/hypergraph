// Q1: a cold visitor's first visit of the test site (20 pages, 10 images of 200 KB), two peers
// in one process on a local DHT. Each run: a fresh DHT, owner, visitor; variants interleaved.
//
//   node bench/site-storage/first-visit.mjs [runs=5] [variants=space,inline,drive]
//
// joined: the visitor is let in / found the owner and has the site's first metadata
// entry: site.json, index.html, style.css and app.js are on this device
// all: every file of the site is on this device

import path from 'path'
import { testnet, tmpDir, rm, siteFiles, writeSite, stats, fmt } from './common.mjs'
import { owner, visitor } from './variants.mjs'

const runs = Number(process.argv[2] || 5)
const variants = (process.argv[3] || 'space,inline,drive').split(',')

const files = siteFiles()
const results = Object.fromEntries(variants.map((v) => [v, { open: [], joined: [], entry: [], all: [] }]))
console.log(`site: ${files.length} files, ${(files.reduce((s, f) => s + f.data.byteLength, 0) / 1024).toFixed(0)} KB`)

for (let r = 0; r < runs; r++) {
  for (const v of variants) {
    const net = await testnet()
    const base = tmpDir('visit-' + v)
    const siteDir = writeSite(path.join(base, 'site'), files)
    let o, vis
    try {
      o = await owner(v, { bootstrap: net.bootstrap, dir: path.join(base, 'owner'), siteDir, files })
      vis = await visitor(v, { bootstrap: net.bootstrap, dir: path.join(base, 'visitor') })
      const t = await vis.visit(o.address, path.join(base, 'out'))
      const res = results[v]
      res.open.push(vis.open)
      for (const k of ['joined', 'entry', 'all']) res[k].push(t[k])
      console.log(`run ${r + 1} ${v.padEnd(6)} open ${Math.round(vis.open)} ms, joined ${Math.round(t.joined)}, entry ${Math.round(t.entry)}, all ${Math.round(t.all)} ms (${t.files} files)`)
    } finally {
      await vis?.close()
      await o?.close()
      await net.destroy()
      await rm(base)
    }
  }
}

console.log('\nmedian (min–max), from the start of the visit (engine already open and online):')
for (const v of variants) {
  const res = results[v]
  console.log(`${v.padEnd(6)} engine open ${fmt(stats(res.open))} | joined ${fmt(stats(res.joined))} | entry ${fmt(stats(res.entry))} | all ${fmt(stats(res.all))}`)
}

// Why a space is slower (site-storage.md Q1): one small file at a time, and one 2 MB file,
// through SwarmFS/swarmwire and through Hyperdrive, after the visitor already joined.
//
//   node bench/site-storage/probe-fetch.mjs [runs=3]

import path from 'path'
import { testnet, tmpDir, rm, writeSite, bytes, stats, fmt, now, deps } from './common.mjs'
import { owner, visitor } from './variants.mjs'

const Hyperdrive = deps('hyperdrive')
const runs = Number(process.argv[2] || 3)
const files = [{ name: 'site.json', data: Buffer.from('{}') }]
for (let i = 0; i < 20; i++) files.push({ name: `small-${i}.html`, data: bytes(4096, i + 1) })
files.push({ name: 'big.bin', data: bytes(2 * 1024 * 1024, 77) })
files.push({ name: 'index.html', data: Buffer.from('x') }, { name: 'style.css', data: Buffer.from('x') }, { name: 'app.js', data: Buffer.from('x') })

const out = { space: { small: [], wire: [], big: [] }, drive: { small: [], big: [] } }
for (let r = 0; r < runs; r++) {
  for (const v of ['space', 'drive']) {
    const net = await testnet()
    const base = tmpDir('probe-' + v)
    const siteDir = writeSite(path.join(base, 'site'), files)
    let o, vis
    try {
      o = await owner(v, { bootstrap: net.bootstrap, dir: path.join(base, 'owner'), siteDir, files })
      vis = await visitor(v, { bootstrap: net.bootstrap, dir: path.join(base, 'visitor') })
      if (v === 'space') {
        const drive = await vis.sfs.join(o.address)
        let items
        for (;;) {
          const top = (await drive.list(drive.top)).items.find((i) => i.kind === 'folder')
          const l = top && await drive.list(top.id)
          if (l && l.complete && l.items.length === files.length) { items = l.items; break }
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        for (const i of items.filter((i) => i.name.startsWith('small-'))) {
          const t = now()
          await drive.fetch(i.id, path.join(base, 'out-' + i.name))
          out.space.small.push(now() - t)
        }
        // the same files again through swarmwire alone (no SwarmFS bookkeeping around it)
        for (const i of items.filter((i) => i.name.startsWith('small-'))) {
          const t = now()
          await vis.sfs._download(i.hash, i.size, path.join(base, 'wire-' + i.name), drive.key)
          out.space.wire.push(now() - t)
        }
        const big = items.find((i) => i.name === 'big.bin')
        const t = now()
        await drive.fetch(big.id, path.join(base, 'out-big'))
        out.space.big.push(now() - t)
      } else {
        const drive = new Hyperdrive(vis.store, Buffer.from(o.address, 'hex'))
        await drive.ready()
        const done = drive.findingPeers()
        vis.swarm.join(drive.discoveryKey, { server: false, client: true })
        vis.swarm.flush().then(done, done)
        await drive.core.update({ wait: true })
        for (const f of files.filter((f) => f.name.startsWith('small-'))) {
          const t = now()
          const got = await drive.get('/' + f.name)
          if (!got || got.byteLength !== f.data.byteLength) throw new Error('not fetched: ' + f.name)
          out.drive.small.push(now() - t)
        }
        const t = now()
        if ((await drive.get('/big.bin'))?.byteLength !== 2 * 1024 * 1024) throw new Error('big.bin not fetched')
        out.drive.big.push(now() - t)
        await drive.close()
      }
    } finally {
      await vis?.close()
      await o?.close()
      await net.destroy()
      await rm(base)
    }
  }
}
for (const v of ['space', 'drive']) console.log(`${v}: one 4 KB file ${fmt(stats(out[v].small))} | 2 MB file ${fmt(stats(out[v].big))}`)
console.log(`space, swarmwire alone: one 4 KB file ${fmt(stats(out.space.wire))}`)

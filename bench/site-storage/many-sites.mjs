// Q2: what each open site costs a visitor: disk, memory, open handles, connections, for 1 site
// and for 50 sites, space vs inline vs Hyperdrive. Two processes: the owners (this one) and the
// visitor (a child, so its memory and handles are its own). 50 sites = 10 owners x 5 sites
// (10 peers for the visitor), not 50 owner processes (the machine's limit).
//
//   node --expose-gc bench/site-storage/many-sites.mjs [sites=1,50] [variants=space,inline,drive]
//
// The visitor opens every site and fetches all of it, then keeps them all open; measured after
// a gc and a 3 s settle. Handles: the Windows handle count of the visitor process (files,
// sockets, events, threads...), minus the count with the engine open and no site.

import path from 'path'
import { fork, execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { testnet, tmpDir, rm, siteFiles, writeSite, duSync, sleep } from './common.mjs'
import { owner, visitor } from './variants.mjs'

const self = fileURLToPath(import.meta.url)

if (process.argv[2] === 'child') child(process.argv[3], JSON.parse(process.argv[4]))
else await main()

async function main () {
  const counts = (process.argv[2] || '1,50').split(',').map(Number)
  const variants = (process.argv[3] || 'space,inline,drive').split(',')
  const files = siteFiles()
  const rows = []
  for (const n of counts) {
    for (const v of variants) {
      const net = await testnet()
      const base = tmpDir('many-' + v)
      const siteDir = writeSite(path.join(base, 'site'), files)
      const owners = []
      let kid
      try {
        const engines = n >= 10 ? 10 : 1
        const per = Math.ceil(n / engines)
        // every site its own bytes (SwarmFS would fetch identical files once)
        for (let e = 0; e < engines; e++) owners.push(await owner(v, { bootstrap: net.bootstrap, dir: path.join(base, 'owner-' + e), siteDir, files, sites: per, filesOf: (s) => siteFiles({ seed: 1 + e * per + s }) }))
        const addresses = owners.flatMap((o) => o.addresses).slice(0, n)
        const dir = path.join(base, 'visitor')
        kid = fork(self, ['child', v, JSON.stringify({ bootstrap: net.bootstrap, dir, out: path.join(base, 'out') })], { execArgv: ['--expose-gc'] })
        const ask = (msg) => new Promise((resolve, reject) => {
          const died = (code) => reject(new Error(`visitor exited (${code})`))
          kid.once('exit', died)
          kid.once('message', (m) => { kid.off('exit', died); resolve(m) })
          kid.send(msg)
        })
        const before = { ...(await ask({ do: 'measure' })), handles: handleCount(kid.pid) }
        const visited = await ask({ do: 'visit', addresses })
        const after = { ...(await ask({ do: 'measure' })), handles: handleCount(kid.pid) }
        const engine = duSync(dir)
        const out = duSync(path.join(base, 'out'))
        const row = {
          variant: v,
          sites: n,
          visitMs: Math.round(visited.ms),
          firstSite: Object.fromEntries(['joined', 'entry', 'all'].map((k) => [k, Math.round(visited.first[k])])),
          lastSite: Object.fromEntries(['joined', 'entry', 'all'].map((k) => [k, Math.round(visited.last[k])])),
          rssMB: +(after.rss / 1e6).toFixed(1),
          rssPerSiteMB: +((after.rss - before.rss) / 1e6 / n).toFixed(2),
          heapPerSiteMB: +((after.heap - before.heap) / 1e6 / n).toFixed(2),
          handles: after.handles,
          handlesPerSite: +((after.handles - before.handles) / n).toFixed(1),
          tcp: after.uv.tcp || 0,
          udp: after.uv.udp || 0,
          connections: after.connections,
          engineDiskMB: +(engine.bytes / 1e6).toFixed(2),
          engineFiles: engine.files,
          pagesDiskMB: +(out.bytes / 1e6).toFixed(2),
          diskPerSiteMB: +((engine.bytes + out.bytes - before.disk) / 1e6 / n).toFixed(2),
          baseline: { rssMB: +(before.rss / 1e6).toFixed(1), handles: before.handles, diskMB: +(before.disk / 1e6).toFixed(2) }
        }
        rows.push(row)
        console.log(JSON.stringify(row))
        await ask({ do: 'close' })
      } finally {
        if (kid && kid.exitCode === null) await new Promise((resolve) => { kid.once('exit', resolve); kid.connected ? kid.disconnect() : kid.kill() })
        for (const o of owners) await o.close()
        await net.destroy()
        await rm(base)
      }
    }
  }
  console.log('\nvariant sites | visit all | RSS (per site) | handles (per site) | tcp udp conns | engine disk (files) | pages on disk | disk per site')
  for (const r of rows) {
    console.log(`${r.variant.padEnd(6)} ${String(r.sites).padStart(3)} | ${(r.visitMs / 1000).toFixed(1)} s | ${r.rssMB} MB (+${r.rssPerSiteMB}) | ${r.handles} (+${r.handlesPerSite}) | ${r.tcp} ${r.udp} ${r.connections} | ${r.engineDiskMB} MB (${r.engineFiles}) | ${r.pagesDiskMB} MB | ${r.diskPerSiteMB} MB`)
  }
}

// The Windows handle count of a process (files, sockets, events, threads...); null elsewhere.
function handleCount (pid) {
  if (process.platform !== 'win32') return null
  try {
    return Number(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).HandleCount`], { encoding: 'utf8' }).trim())
  } catch { return null }
}

async function child (variant, { bootstrap, dir, out }) {
  const vis = await visitor(variant, { bootstrap, dir })
  const measure = async () => {
    globalThis.gc?.()
    await sleep(3000)
    globalThis.gc?.()
    const mem = process.memoryUsage()
    const uv = {}
    for (const h of process.report.getReport().libuv) uv[h.type] = (uv[h.type] || 0) + 1
    return { rss: mem.rss, heap: mem.heapUsed + mem.external, uv, connections: vis.connections(), disk: duSync(dir).bytes }
  }
  process.on('message', async (msg) => {
    if (msg.do === 'measure') process.send(await measure())
    else if (msg.do === 'visit') {
      const t = performance.now()
      const each = []
      for (let i = 0; i < msg.addresses.length; i++) each.push(await vis.visit(msg.addresses[i], path.join(out, 'site-' + i)))
      process.send({ ms: performance.now() - t, first: each[0], last: each.at(-1) })
    } else if (msg.do === 'close') {
      await vis.close()
      process.send({})
      process.disconnect()
    }
  })
}


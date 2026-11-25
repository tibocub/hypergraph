// Measures over the live I2P network, with two routers on this machine.
//
// node research/i2p/bench.js start  --router i2pd --exe <path> [--dir <data>] [--idle 600]
//     first/later start: process -> SAM up -> tunnels ready; then idle memory/CPU
// node research/i2p/bench.js stream --router i2pd --exe <path> [--probes 5] [--records 20] [--bulk 40]
//     two engines replicate a space over SAM streams (028's scenario), plus time to first byte
// node research/i2p/bench.js dht    --router i2pd --exe <path> [--nodes 8] [--style DATAGRAM|RAW] [--lookups 5]
//     dht-rpc over SAM datagrams through the udx shim: bootstrap and lookup times
//
// Data folders go under --dir (default: the system temp folder); routers are
// stopped at the end. Nothing here touches lib/.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { startRouter } = require('./router.js')
const sam = require('./sam.js')

const args = process.argv.slice(2)
const flag = (name, dflt) => { const i = args.indexOf(`--${name}`); return i === -1 ? dflt : args[i + 1] }
const mode = args[0]
const kind = flag('router', 'i2pd')
const exe = flag('exe')
const root = flag('dir', path.join(process.env.HG_TEST_TMP || os.tmpdir(), 'i2p-bench'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const out = (o) => console.log(JSON.stringify(o))

// Windows: working set and total CPU seconds of a pid.
function procStats (pid) {
  const ps = `$p = Get-Process -Id ${pid}; "$($p.WorkingSet64) $($p.CPU)"`
  const [ws, cpu] = execFileSync('powershell', ['-NoProfile', '-Command', ps]).toString().trim().split(' ')
  return { rssMB: Math.round(Number(ws) / 1e6), cpuS: Number(cpu) }
}

function dirMB (d) {
  let n = 0
  const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); e.isDirectory() ? walk(f) : (n += fs.statSync(f).size) } }
  if (fs.existsSync(d)) walk(d)
  return Math.round(n / 1e5) / 10
}

const PORTS = { a: { sam: 17656, udp: 17655, http: 17070 }, b: { sam: 27656, udp: 27655, http: 27070 } }

async function router (name) {
  const dir = path.join(root, `${kind}-${name}`)
  const r = await startRouter(kind, exe, dir, PORTS[name])
  return { ...r, dir }
}

const modes = {
  async start () {
    const r = await router('a')
    const s = await sam.session('STREAM', { sam: r.samOpts })
    out({ kind, samReadyMs: r.samReadyMs, tunnelsReadyMs: s.readyMs, dataMB: dirMB(r.dir), ...procStats(r.pid) })
    const idle = Number(flag('idle', 0))
    if (idle) {
      const before = procStats(r.pid)
      await sleep(idle * 1000)
      const after = procStats(r.pid)
      out({ kind, idleS: idle, rssMB: after.rssMB, cpuPct: Math.round(((after.cpuS - before.cpuS) / idle) * 1000) / 10 })
    }
    s.close()
    await r.stop()
  },

  async stream () {
    const { measure, engine } = require('../anonymity/bench.js')
    const { StreamSwarm } = require('../anonymity/stream-swarm.js')
    const [ra, rb] = await Promise.all([router('a'), router('b')])
    const [sa, sb] = await Promise.all([sam.session('STREAM', { sam: ra.samOpts }), sam.session('STREAM', { sam: rb.samOpts })])
    out({ kind, tunnelsReadyMs: [sa.readyMs, sb.readyMs] })

    // Time to first byte: STREAM CONNECT sent -> first byte from A. The first probe includes A's LeaseSet lookup.
    let probe = true
    let stopAccept = sam.streamAccept(sa, (sock) => { if (probe) sock.end(Buffer.from([1])); else sock.destroy() })
    const ttfb = []
    for (let i = 0; i < Number(flag('probes', 5)); i++) {
      const t = Date.now()
      try {
        const s = await sam.streamConnect(sb, sa.dest)
        await new Promise((resolve, reject) => { s.once('data', resolve); s.once('error', reject); s.once('close', reject) })
        ttfb.push(Date.now() - t)
        s.destroy()
      } catch (err) { ttfb.push(`error: ${err.message}`) }
    }
    out({ kind, ttfbMs: ttfb })
    probe = false
    stopAccept()

    const dir = fs.mkdtempSync(path.join(root, 'engines-'))
    const a = await engine(path.join(dir, 'a'), { bootstrap: [] })
    const b = await engine(path.join(dir, 'b'), { bootstrap: [] })
    const swa = new StreamSwarm({ keyPair: a._network.keyPair })
    stopAccept = sam.streamAccept(sa, (sock) => swa.accept(sock).catch(() => {}))
    const swb = new StreamSwarm({ keyPair: b._network.keyPair, dial: (d) => sam.streamConnect(sb, d), peers: [sa.dest] })
    a._network._swarm = swa
    b._network._swarm = swb
    await a.connectToSwarm()
    await b.connectToSwarm()
    try {
      const m = await measure(a, b, { records: Number(flag('records', 20)), bulk: Number(flag('bulk', 40)) })
      out({ kind, ...m, postsPerS: Math.round((m.bulk.records / (m.bulk.ms / 1000)) * 10) / 10, MBps: Math.round(m.bulk.kbPerS / 10.24) / 100 })
    } finally {
      stopAccept()
      await Promise.all([a.close(), b.close()])
      sa.close(); sb.close()
      await Promise.all([ra.stop(), rb.stop()])
      fs.rmSync(dir, { recursive: true, force: true })
    }
  },

  async dht () {
    const DHT = require('dht-rpc')
    const { I2PUDX } = require('./udx-shim.js')
    const style = flag('style', 'DATAGRAM')
    const n = Number(flag('nodes', 8))
    const [ra, rb] = await Promise.all([router('a'), router('b')])
    const udxs = []
    const nodes = []
    const adaptiveTimeout = { min: 3000, max: 20000 } // I2P round trips are seconds, dht-rpc's default is 1 s
    let t = Date.now()
    const ready = await Promise.all(Array.from({ length: n }, (_, i) => I2PUDX.open({ style, sam: (i % 2 ? rb : ra).samOpts })))
    out({ kind, style, sessionsReadyMs: Date.now() - t })
    udxs.push(...ready)
    t = Date.now()
    const boot = new DHT({ udx: udxs[0], ephemeral: false, firewalled: false, bootstrap: [], adaptiveTimeout })
    await boot.ready()
    const bootAddr = `${udxs[0].host}:${boot.address().port}`
    nodes.push(boot)
    for (const u of udxs.slice(1)) {
      u.learn(udxs[0].hash) // the bootstrap's destination, as an invite or a shipped list would carry it
      nodes.push(new DHT({ udx: u, ephemeral: false, firewalled: false, bootstrap: [bootAddr], adaptiveTimeout }))
    }
    await Promise.all(nodes.slice(1).map((d) => d.ready()))
    out({ kind, style, bootstrapMs: Date.now() - t, tableSizes: nodes.map((d) => d.toArray().length) })
    const lookups = []
    for (let i = 0; i < Number(flag('lookups', 5)); i++) {
      const from = nodes[1 + (i % (n - 1))]
      const target = nodes[(i * 3 + 2) % n].id
      t = Date.now()
      let hit = false
      let replies = 0
      for await (const r of from.findNode(target)) { replies++; if (r.from.id && r.from.id.equals(target)) hit = true }
      lookups.push({ ms: Date.now() - t, replies, hit })
    }
    const stats = nodes.map((d) => d.stats.requests)
    out({ kind, style, lookups, timeouts: stats.reduce((s, x) => s + x.timeouts, 0), retries: stats.reduce((s, x) => s + x.retries, 0), datagrams: udxs.reduce((s, u) => s + u.stats.tx, 0) })
    await Promise.all(nodes.map((d) => d.destroy()))
    udxs.forEach((u) => u.close())
    await Promise.all([ra.stop(), rb.stop()])
  }
}

if (!modes[mode] || !exe) {
  console.error('usage: bench.js <start|stream|dht> --router <i2pd|emissary> --exe <path> [options]')
  process.exitCode = 1
} else {
  fs.mkdirSync(root, { recursive: true })
  modes[mode]().catch((err) => { console.error(err); process.exitCode = 1 })
}

// Two hypergraph engines, one public space, over one transport. Measures:
//   join     the newcomer redeems the public link -> holds the first post
//   latency  a post on A -> seen on B (one at a time)
//   bulk     many 16 KB posts on A -> all on B (records/s, KB/s)
//
// node research/anonymity/bench.js swarm            Hyperswarm on a local DHT (the baseline)
// node research/anonymity/bench.js relay            same, with relayThrough a local blind relay
// node research/anonymity/bench.js tcp              no DHT: B dials A's TCP port (checks the adapter)
// node research/anonymity/bench.js tor --tor <tor.exe>   no DHT: B dials A's onion address
//   --records 20  --bulk 40  --runs 1
//
// Engines reach into hg._network._swarm: there is no public option for a
// transport (research only, lib/ unchanged).

const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { Hypergraph } = require('../../lib/index.js')
const { StreamSwarm } = require('./stream-swarm.js')

const types = { post: { fields: { title: 'string', text: 'text' } } }
const TMP = process.env.HG_TEST_TMP || os.tmpdir()

async function engine (dir, opts = {}) {
  return Hypergraph.open(dir, { types, deviceName: path.basename(dir), ...opts })
}

function seen (space, id, timeout = 300000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { space.off('change', onchange); reject(new Error(`record not seen within ${timeout} ms`)) }, timeout)
    const onchange = ({ records }) => { if (records.some((r) => r.id === id)) done() }
    const done = () => { clearTimeout(timer); space.off('change', onchange); resolve() }
    space.on('change', onchange)
    space.get(id).then(({ record }) => { if (record) done() }, () => {})
  })
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }

// Plays the scenario on two engines already wired to a transport.
async function measure (a, b, { records = 20, bulk = 40 } = {}) {
  const sa = await a.createSpace({ name: 'bench' })
  await sa.makePublic()
  const hello = await sa.put('post', { title: 'hello', text: 'first' })

  let t = Date.now()
  const joined = await b.redeemInvite(sa.publicLink())
  const sb = typeof joined === 'string' ? b.space(joined) : joined
  const redeemMs = Date.now() - t
  await seen(sb, hello.id)
  const joinMs = Date.now() - t

  const lat = []
  for (let i = 0; i < records; i++) {
    t = Date.now()
    const r = await sa.put('post', { title: `n${i}`, text: 'x' })
    await seen(sb, r.id)
    lat.push(Date.now() - t)
  }

  const text = 'y'.repeat(16 * 1024)
  t = Date.now()
  const waiting = []
  for (let i = 0; i < bulk; i++) {
    const r = await sa.put('post', { title: `b${i}`, text })
    waiting.push(seen(sb, r.id))
  }
  await Promise.all(waiting)
  const bulkMs = Date.now() - t
  return {
    redeemMs,
    joinMs,
    latencyMs: { median: median(lat), min: Math.min(...lat), max: Math.max(...lat), n: lat.length },
    bulk: { records: bulk, ms: bulkMs, kbPerS: Math.round((bulk * 16) / (bulkMs / 1000)) }
  }
}

// Each transport returns { a, b, info, close }.
const transports = {
  async swarm (dir, { relay = false } = {}) {
    const createTestnet = require('hyperdht/testnet')
    const testnet = await createTestnet(3)
    const bootstrap = testnet.bootstrap
    const info = {}
    let relayNode = null
    let relayServer = null
    let swarmOpts = {}
    if (relay) {
      const HyperDHT = require('hyperdht')
      const BlindRelay = require('blind-relay')
      relayNode = new HyperDHT({ bootstrap })
      const relayKp = HyperDHT.keyPair()
      relayServer = new BlindRelay.Server({ createStream: (opts) => relayNode.createRawStream(opts) })
      const srv = relayNode.createServer((socket) => {
        const session = relayServer.accept(socket, { id: socket.remotePublicKey })
        session.on('error', () => {})
      })
      await srv.listen(relayKp)
      swarmOpts = { relayThrough: () => relayKp.publicKey } // always, not only when holepunching fails
      info.relayPort = relayNode.address().port
    }
    const Hyperswarm = require('hyperswarm')
    const a = await engine(path.join(dir, 'a'), { bootstrap })
    const b = await engine(path.join(dir, 'b'), { bootstrap })
    for (const hg of [a, b]) hg._network._swarm = new Hyperswarm({ bootstrap, keyPair: hg._network.keyPair, ...swarmOpts })
    await a.connectToSwarm()
    await b.connectToSwarm()
    return {
      a,
      b,
      info,
      report () {
        if (!relay) return {}
        const paths = [...a._network.swarm.connections].map((c) => (c.rawStream && c.rawStream.remotePort === info.relayPort ? 'via relay' : 'direct'))
        return { paths, relayStats: relayServer.stats }
      },
      async close () {
        await Promise.all([a.close(), b.close()])
        if (relayNode) await relayNode.destroy()
        await testnet.destroy()
      }
    }
  },

  relay (dir) { return transports.swarm(dir, { relay: true }) },

  async tcp (dir) {
    return streamPair(dir, async (port) => ({ address: port, dial: (p) => connectTcp(p) }))
  },

  async tor (dir, { tor }) {
    if (!tor) throw new Error('--tor <path to tor.exe> is needed')
    const { startTor, socksConnect } = require('./tor.js')
    const procs = []
    return streamPair(dir, async (port) => {
      const [ta, tb] = await Promise.all([
        startTor(tor, path.join(dir, 'tor-a'), { socksPort: 19150, servicePort: port }),
        startTor(tor, path.join(dir, 'tor-b'), { socksPort: 19160 })
      ])
      procs.push(ta, tb)
      const info = { bootstrapMs: [ta.bootstrapMs, tb.bootstrapMs], onionReachableMs: null }
      const t = Date.now()
      const dial = async (onion) => {
        for (;;) { // the descriptor takes a while to reach the HSDirs
          try {
            const s = await socksConnect(19160, onion, 7000)
            if (info.onionReachableMs === null) info.onionReachableMs = Date.now() - t
            return s
          } catch (err) {
            if (Date.now() - t > 300000) throw err
            await new Promise((resolve) => setTimeout(resolve, 2000))
          }
        }
      }
      // reach it once before the clock of the scenario starts
      ;(await dial(ta.onion)).destroy()
      return { address: ta.onion, dial, info }
    }, () => procs.forEach((p) => p.stop()))
  }
}

function connectTcp (port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => { s.removeListener('error', reject); resolve(s) })
    s.once('error', reject)
  })
}

// A listens on a local TCP port; `route(port)` says how B reaches it.
async function streamPair (dir, route, stop = () => {}) {
  const a = await engine(path.join(dir, 'a'), { bootstrap: [] })
  const b = await engine(path.join(dir, 'b'), { bootstrap: [] })
  const sa = new StreamSwarm({ keyPair: a._network.keyPair })
  const server = net.createServer((socket) => sa.accept(socket).catch(() => {}))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { address, dial, info = {} } = await route(server.address().port)
  const sb = new StreamSwarm({ keyPair: b._network.keyPair, dial, peers: [address] })
  a._network._swarm = sa
  b._network._swarm = sb
  await a.connectToSwarm()
  await b.connectToSwarm()
  return {
    a,
    b,
    info,
    report: () => ({}),
    async close () {
      await Promise.all([a.close(), b.close()])
      server.close()
      stop()
    }
  }
}

async function run (mode, opts = {}) {
  fs.mkdirSync(TMP, { recursive: true })
  const dir = fs.mkdtempSync(path.join(TMP, `anon-${mode}-`))
  const t = Date.now()
  const pair = await transports[mode](dir, opts)
  const setupMs = Date.now() - t
  try {
    const m = await measure(pair.a, pair.b, opts)
    return { mode, setupMs, ...pair.info, ...m, ...pair.report() }
  } finally {
    await pair.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

module.exports = { run }

if (require.main === module) {
  const args = process.argv.slice(2)
  const mode = args[0]
  const flag = (name, dflt) => { const i = args.indexOf(`--${name}`); return i === -1 ? dflt : args[i + 1] }
  if (!transports[mode]) {
    console.error('usage: bench.js <swarm|relay|tcp|tor> [--tor path] [--records 20] [--bulk 40] [--runs 1]')
    process.exitCode = 1
  } else {
    ;(async () => {
      const runs = Number(flag('runs', 1))
      for (let i = 0; i < runs; i++) {
        const r = await run(mode, { tor: flag('tor'), records: Number(flag('records', 20)), bulk: Number(flag('bulk', 40)) })
        console.log(JSON.stringify(r))
      }
    })().catch((err) => { console.error(err); process.exitCode = 1 })
  }
}

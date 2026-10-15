// Peers that dial each other at the same moment (research.md A15, A16, A17):
// on one host or LAN, HyperDHT 6.33+ can hand the dialer a connection the other
// side already destroyed (holepunchto/hyperdht#304); nothing opens on it, it
// closes after ~13 s, and a retry can hit the same race. (In one process it
// never showed, hence separate processes here.) Several processes open one
// space at once: no connection stays open past a few seconds without the space
// channel (hypergraph closes it and dials the peer again). How many peers that
// met end up apart is reported, not asserted
// (specs/research/upstream/hyperswarm.md).

const process = require('process')
const { spawn } = require('child_process')
const { tmpDir, testBootstrap, open } = require('../helpers.js')

const PEERS = 6
const SECONDS = 25
const STALE_MS = 8000 // hypergraph closes a connection nothing arrived on after 5 s

if (process.argv.includes('--peer')) peer(...process.argv.slice(process.argv.indexOf('--peer') + 1))
else {
  const test = require('brittle') // not in the peers' processes: their stdout is their result
  test('no connection stays without its space channel, across processes', { timeout: 120000 }, async (t) => {
    const bootstrap = await testBootstrap(t)
    const owner = await open(t, { bootstrap })
    const space = await owner.createSpace({ name: 'meeting point' })
    await owner.connectToSwarm()
    const results = await Promise.all(Array.from({ length: PEERS }, (_, i) => run(t, [JSON.stringify(bootstrap), space.key, tmpDir(t, 'p' + i)])))
    for (const r of results) t.is(r.stale, 0, `no connection open ${STALE_MS / 1000} s without the space channel (${r.connections} connections)`)
    const apart = results.reduce((n, r) => n + r.met.filter((d) => !r.linked.includes(d)).length, 0)
    const met = results.reduce((n, r) => n + r.met.length, 0)
    t.comment(`${apart} of ${met} peers met are apart at the end`)
  })
}

function run (t, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, '--peer', ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
    t.teardown(() => child.kill(), { order: 0 }) // peers stay until every one has answered, so none sees another leave
    let out = ''
    child.stdout.on('data', (d) => {
      out += d
      try { resolve(JSON.parse(out)) } catch {}
    })
    child.on('exit', () => reject(new Error('peer failed: ' + out)))
  })
}

// One process: opens the space by its key, watches its connections for
// SECONDS, then says how many stayed STALE_MS without the space channel,
// which peers it met and which it is linked with; stays until stopped.
async function peer (bootstrap, key, dir) {
  const z32 = require('z32')
  const { Hypergraph } = require('../../../lib/index.js')
  const testing = require('../../../lib/testing.js')
  const hg = await Hypergraph.open(dir, { bootstrap: JSON.parse(bootstrap) })
  const met = new Set()
  hg.on('connection', ({ publicKey }) => met.add(publicKey))
  const space = await testing.openSpace(hg, key)
  await hg.connectToSwarm()
  const seen = new Map() // connection -> when first seen
  const stale = new Set()
  for (const until = Date.now() + SECONDS * 1000; Date.now() < until;) {
    const linked = space.peers().map((p) => p.device)
    for (const conn of hg._network.connections) {
      if (!seen.has(conn)) seen.set(conn, Date.now())
      if (Date.now() - seen.get(conn) > STALE_MS && !linked.includes(z32.encode(conn.remotePublicKey))) stale.add(conn)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const linked = space.peers().map((p) => p.device)
  console.log(JSON.stringify({ stale: stale.size, connections: seen.size, met: [...met].sort(), linked: linked.sort() })) // console.log: process.stdout.write never reached the parent under Bare
}

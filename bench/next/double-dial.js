// Plain Hyperswarm, no hypergraph (specs/011-spaces-core/upstream-hyperswarm.md):
// peers in separate processes join one topic at the same moment, on a local
// DHT. On each connection both sides open one Protomux channel. Reports, per
// process, the connections it got and the ones on which the channel never
// opened within 5 s (the other side had dropped that connection).
//
// Each process also says with how many peers it has a channel open at the
// end. --fix closes a connection on which nothing arrived within 5 s
// (hypergraph's workaround, lib/network.js) and lets Hyperswarm reconnect.
//
//   node bench/next/double-dial.js [peers=8] [seconds=20] [--fix]

const { spawn } = require('child_process')
const Hyperswarm = require('hyperswarm')
const Protomux = require('protomux')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')

const OPEN_MS = 5000
const END_MS = 3000

const FIX = process.argv.includes('--fix')
const args = process.argv.filter((a) => a !== '--fix')

if (args[2] === '--peer') peer(JSON.parse(args[3]), b4a.from(args[4], 'hex'), Number(args[5]))
else main(Number(args[2]) || 8, Number(args[3]) || 20)

async function main (n, seconds) {
  const createTestnet = require('hyperdht/testnet')
  const testnet = await createTestnet(3)
  const topic = crypto.randomBytes(32)
  const results = await Promise.all(Array.from({ length: n }, () => new Promise((resolve) => {
    const child = spawn(process.execPath, [__filename, '--peer', JSON.stringify(testnet.bootstrap), b4a.toString(topic, 'hex'), String(seconds), ...(FIX ? ['--fix'] : [])], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('exit', () => resolve(JSON.parse(out)))
  })))
  let dead = 0
  for (const r of results) {
    dead += r.dead
    console.log(`peer ${r.id}: ${r.connections} connections, ${r.peers} distinct peers, ${r.dead} without a channel after ${OPEN_MS / 1000} s (closed later: ${r.deadClosedAfter.join(', ') || '-'} s); a channel open with ${r.linked} ${END_MS / 1000} s before the end`)
  }
  const lost = results.reduce((x, r) => x + r.peers - r.linked, 0)
  console.log(`${FIX ? '--fix: ' : ''}${dead} dead connections over ${n} peers; ${lost} peers met but without an open channel ${END_MS / 1000} s before the end`)
  await testnet.destroy()
}

async function peer (bootstrap, topic, seconds) {
  const swarm = new Hyperswarm({ bootstrap })
  const id = b4a.toString(swarm.keyPair.publicKey, 'hex').slice(0, 6)
  const stats = { id, connections: 0, peers: new Set(), dead: 0, deadClosedAfter: [] }
  const linked = new Set() // connections with the channel open (one closing after its replacement opened must not unlink the peer)
  swarm.on('connection', (conn) => {
    const at = Date.now()
    stats.connections++
    stats.peers.add(b4a.toString(conn.remotePublicKey, 'hex'))
    conn.on('error', () => {})
    let open = false
    let dead = false
    const remote = b4a.toString(conn.remotePublicKey, 'hex')
    const ch = Protomux.from(conn).createChannel({
      protocol: 'probe',
      onopen () {
        open = true
        linked.add(conn)
      },
      onclose () { linked.delete(conn) }
    })
    ch.open()
    if (FIX) {
      const fix = setTimeout(() => conn.destroy(), OPEN_MS + 100)
      conn.once('data', () => clearTimeout(fix))
      conn.on('close', () => clearTimeout(fix))
    }
    const timer = setTimeout(() => {
      if (open) return
      dead = true
      stats.dead++
    }, OPEN_MS)
    conn.on('close', () => {
      clearTimeout(timer)
      if (dead) stats.deadClosedAfter.push(Math.round((Date.now() - at) / 1000))
    })
  })
  swarm.join(topic)
  // counted END_MS before the end: the first process to exit closes its connections to the others
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000 - END_MS))
  const peers = new Set([...linked].map((c) => b4a.toString(c.remotePublicKey, 'hex'))).size
  await new Promise((resolve) => setTimeout(resolve, END_MS))
  process.stdout.write(JSON.stringify({ ...stats, peers: stats.peers.size, linked: peers }))
  await swarm.destroy({ force: true })
  process.exit(0)
}

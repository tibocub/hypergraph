// Plain Hyperswarm only (specs/research/upstream/hyperswarm.md): N processes
// join one topic at the same moment on a local testnet. Each reports every
// connection Hyperswarm emitted (by handshake hash, shared by both ends) and
// whether it is still open at the end. A connection one side emitted but the
// other never did is dead: the other side dropped it as a duplicate.
//
//   node specs/research/upstream/hyperswarm-double-dial.js [peers=8] [seconds=20] [--send]
//
// --send writes one byte on each new connection, as apps do (Corestore
// replication, Protomux). Without it the apps send nothing.

const { spawn } = require('child_process')
const Hyperswarm = require('hyperswarm')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')

const SEND = process.argv.includes('--send')
const args = process.argv.filter((a) => a !== '--send')

if (args[2] === '--peer') peer(JSON.parse(args[3]), b4a.from(args[4], 'hex'), Number(args[5]))
else main(Number(args[2]) || 8, Number(args[3]) || 20)

async function main (n, seconds) {
  const createTestnet = require('hyperdht/testnet')
  const testnet = await createTestnet(3)
  const topic = crypto.randomBytes(32)
  const peers = await Promise.all(Array.from({ length: n }, () => new Promise((resolve) => {
    const child = spawn(process.execPath, [__filename, '--peer', JSON.stringify(testnet.bootstrap), b4a.toString(topic, 'hex'), String(seconds), ...(SEND ? ['--send'] : [])], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('exit', () => resolve(JSON.parse(out)))
  })))
  const emitted = new Map() // handshake hash -> how many sides emitted it
  for (const p of peers) for (const c of p.conns) emitted.set(c.hash, (emitted.get(c.hash) || 0) + 1)
  let dead = 0
  const oneSided = []
  const pairs = new Set()
  const linked = new Set()
  for (const p of peers) {
    for (const c of p.conns) {
      const pair = [p.id, c.remote].sort().join('-')
      pairs.add(pair)
      if (emitted.get(c.hash) === 2 && c.openBeforeEnd) linked.add(pair)
      if (emitted.get(c.hash) === 1) {
        dead++
        oneSided.push(`${c.client ? 'client' : 'server'}, closed after ${c.closedAfter === null ? 'never' : c.closedAfter + ' s'}`)
      }
    }
  }
  console.log(`${SEND ? '--send: ' : ''}${n} peers, ${pairs.size} pairs met; ${dead} connections emitted on one side only; ${pairs.size - linked.size} pairs without a connection open on both sides at ${seconds - 3} s`)
  const count = oneSided.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map())
  for (const [k, v] of count) console.log(`  one-sided: ${v} x ${k}`)
  await testnet.destroy()
}

async function peer (bootstrap, topic, seconds) {
  const swarm = new Hyperswarm({ bootstrap })
  const id = b4a.toString(swarm.keyPair.publicKey, 'hex')
  const conns = []
  swarm.on('connection', (conn, info) => {
    const at = Date.now()
    const c = { remote: b4a.toString(conn.remotePublicKey, 'hex'), hash: b4a.toString(conn.handshakeHash, 'hex'), client: conn.isInitiator, open: true, closedAfter: null }
    conns.push(c)
    conn.on('error', () => {})
    conn.on('data', () => {})
    if (SEND) conn.write(b4a.from([0]))
    conn.on('close', () => {
      c.open = false
      c.closedAfter = Math.round((Date.now() - at) / 1000)
    })
  })
  swarm.join(topic)
  // looked at 3 s before the end: the first process to exit closes its connections to the others
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000 - 3000))
  for (const c of conns) c.openBeforeEnd = c.open
  await new Promise((resolve) => setTimeout(resolve, 3000))
  process.stdout.write(JSON.stringify({ id, conns }))
  await swarm.destroy({ force: true })
  process.exit(0)
}

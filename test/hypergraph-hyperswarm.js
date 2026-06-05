const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const { Hypergraph } = require('../index.js')
const os = require('os')
const path = require('path')
const fs = require('fs')

async function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function createPeer (name, { userCoreKey = null } = {}) {
  const dir = path.join(os.tmpdir(), `hypergraph-hsw-${name}-${process.pid}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })

  const store = new Corestore(dir)
  const graph = new Hypergraph(store, { userCoreKey })
  await graph.ready()

  const swarm = new Hyperswarm()
  let connectedResolve
  const connected = new Promise((resolve) => { connectedResolve = resolve })

  swarm.on('connection', (conn, info) => {
    const remoteKey = (conn.remotePublicKey || info?.publicKey)
    const peerId = remoteKey ? remoteKey.toString('hex').slice(0, 16) : 'unknown'
    console.log(`[${name}] connected to ${peerId}...`)

    if (connectedResolve) {
      connectedResolve(true)
      connectedResolve = null
    }

    // As per corestore + hyperswarm docs, pass the connection stream directly.
    store.replicate(conn)
  })

  return { name, dir, store, graph, swarm, connected }
}

async function cleanup (peers) {
  for (const p of peers) {
    try { await p.swarm.destroy() } catch {}
    try { await p.graph.close() } catch {}
    try { await p.store.close() } catch {}
    try { fs.rmSync(p.dir, { recursive: true, force: true }) } catch {}
  }
}

async function main () {
  console.log('=== Hypergraph Hyperswarm Test ===')

  const a = await createPeer('a')

  // Write some data on peer A
  const authorA = a.graph.key.toString('hex')
  await a.graph.put({ id: 'post/p2p', type: 'post', author: authorA })
  await a.graph.putContent('post/p2p', 'hello over hyperswarm', 'text')

  // Create peer B that opens A's user core by key (simulating key exchange)
  const b = await createPeer('b', { userCoreKey: a.graph.key })

  const topic = a.graph.discoveryKey

  // Follow hyperswarm README pattern:
  // - One peer announces (server) and flushes the announce
  // - One peer looks up (client) and flushes pending connections
  const discA = a.swarm.join(topic, { server: true, client: false })
  await discA.flushed()

  const discB = b.swarm.join(topic, { server: false, client: true })
  await b.swarm.flush()

  console.log('Joined topic:', topic.toString('hex').slice(0, 16) + '...')

  // Wait for at least one connection to form (avoid races)
  const connected = await Promise.race([
    Promise.any([a.connected, b.connected]),
    sleep(20000).then(() => false)
  ])

  if (!connected) {
    await discA.destroy()
    await discB.destroy()
    await cleanup([a, b])
    throw new Error('No hyperswarm connection established within timeout')
  }

  // Wait for replication to move data
  // (Simple polling; in a real test we'd listen to update events)
  for (let i = 0; i < 100; i++) {
    await b.graph.update()
    const post = await b.graph.get('post/p2p')
    const content = await b.graph.getContent('post/p2p')
    if (post && content) {
      console.log('Replicated OK:', post.id, '-', content.body)
      await discA.destroy()
      await discB.destroy()
      await cleanup([a, b])
      console.log('=== PASSED ===')
      return
    }
  }

  await discA.destroy()
  await discB.destroy()
  await cleanup([a, b])
  throw new Error('Replication did not complete within timeout')
}

main().catch(err => {
  console.error('FAILED:', err)
  process.exit(1)
})

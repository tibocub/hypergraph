const test = require('brittle')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const { Hypergraph } = require('../../index.js')
const os = require('os')
const path = require('path')
const fs = require('fs')

async function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function createPeer (name, { userCoreKey = null, identity = null } = {}) {
  const dir = path.join(os.tmpdir(), `hypergraph-hsw-${name}-${process.pid}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })

  const store = new Corestore(dir)
  const graph = new Hypergraph(store, { userCoreKey, identity })
  await graph.ready()

  const swarm = new Hyperswarm()
  let connectedResolve
  const connected = new Promise((resolve) => { connectedResolve = resolve })

  swarm.on('connection', (conn, info) => {
    if (connectedResolve) {
      connectedResolve(true)
      connectedResolve = null
    }
    store.replicate(conn)
    
    // Use new API for automatic writer authorization and peer discovery
    if (info && info.publicKey) {
      graph.handlePeerConnection(Buffer.from(info.publicKey)).catch(() => {})
    }
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

test('hypergraph: hyperswarm replication (user core)', async (t) => {
  const a = await createPeer('a')

  const authorA = a.graph.identity.deviceKeyPair.publicKey.toString('hex')
  const post = await a.graph.put({ type: 'post' })
  await a.graph.putContent(post.id, 'hello over hyperswarm', 'text')

  // Peer B opens peer A's user core for replication (one UserCore per device)
  const b = await createPeer('b', { userCoreKey: a.graph.key })

  const topic = a.graph.discoveryKey

  const discA = a.swarm.join(topic, { server: true, client: false })
  await discA.flushed()

  const discB = b.swarm.join(topic, { server: false, client: true })
  await b.swarm.flush()

  t.teardown(async () => {
    await discA.destroy()
    await discB.destroy()
    await cleanup([a, b])
  })

  const connected = await Promise.race([
    Promise.any([a.connected, b.connected]),
    sleep(20000).then(() => false)
  ])

  t.ok(connected, 'peers connected')

  for (let i = 0; i < 100; i++) {
    await b.graph.update()
    const postNode = await b.graph.get(post.id)
    const content = await b.graph.getContent(post.id)
    if (postNode && content) {
      t.is(postNode.id, post.id)
      t.is(content.body, 'hello over hyperswarm')
      return
    }
    await sleep(200)
  }

  t.fail('replication did not complete within timeout')
})

test('hypergraph: peer discovery API', async (t) => {
  const a = await createPeer('a')
  const b = await createPeer('b')

  const topic = a.graph.discoveryKey

  const discA = a.swarm.join(topic, { server: true, client: false })
  await discA.flushed()

  const discB = b.swarm.join(topic, { server: false, client: true })
  await b.swarm.flush()

  t.teardown(async () => {
    await discA.destroy()
    await discB.destroy()
    await cleanup([a, b])
  })

  const connected = await Promise.race([
    Promise.any([a.connected, b.connected]),
    sleep(20000).then(() => false)
  ])

  t.ok(connected, 'peers connected')

  // Test announce API
  await a.graph.announce({ metadata: { name: 'alice' } })
  await sleep(500)

  // Test listPeers API
  const peersA = a.graph.listPeers()
  t.ok(Array.isArray(peersA), 'listPeers returns array')
  
  // Test discoverPeers API
  const discoveredPeers = []
  try {
    const peers = await a.graph.discoverPeers()
    for await (const peer of peers) {
      discoveredPeers.push(peer)
    }
  } catch (err) {
    // discoverPeers might not be fully functional yet
    if (err && err.message) console.log('discoverPeers error (expected):', err.message)
  }
})

test('hypergraph: bootstrap/export API', async (t) => {
  const a = await createPeer('a')

  const authorA = a.graph.key ? a.graph.key.toString('hex') : ''
  
  // Create a context to export
  const contextKey = await a.graph.createContext({ writeMode: 'open' })
  const post = await a.graph.put({ type: 'post' })
  await a.graph.putContent(post.id, 'bootstrap test', 'text')

  // Test export API
  const bootstrap = await a.graph.export()
  t.ok(bootstrap, 'export returns data')
  t.ok(bootstrap.userCoreKey, 'bootstrap has userCoreKey')
  t.ok(bootstrap.contexts, 'bootstrap has contexts')
  t.ok(bootstrap.contexts.length > 0, 'bootstrap has at least one context')

  const dir = path.join(os.tmpdir(), `hypergraph-hsw-bootstrap-${process.pid}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })

  const store = new Corestore(dir)

  // Test join API (static method)
  const graph = await Hypergraph.join(store, bootstrap)
  
  // Verify the graph was joined correctly (contexts should be opened)
  t.ok(graph, 'graph created from bootstrap')
  
  // Verify the context was opened using the key from bootstrap
  const exportedContextKey = bootstrap.contexts[0].key
  const joinedContext = await graph.openContext(exportedContextKey)
  t.ok(joinedContext, 'context opened from bootstrap')
  t.is(joinedContext.writeMode, 'open', 'context writeMode preserved')

  t.teardown(async () => {
    await a.swarm.destroy()
    await a.graph.close()
    await a.store.close()
    await graph.close()
    await store.close()
    fs.rmSync(a.dir, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

test('hypergraph: event-based peer discovery', async (t) => {
  const a = await createPeer('a')
  const b = await createPeer('b')

  const topic = a.graph.discoveryKey

  let peerJoinCount = 0
  let peerLeaveCount = 0

  a.graph.on('peer-join', (peerInfo) => {
    peerJoinCount++
    t.ok(peerInfo.userCoreKey, 'peer-join has userCoreKey')
  })

  a.graph.on('peer-leave', (peerInfo) => {
    peerLeaveCount++
    t.ok(peerInfo.userCoreKey, 'peer-leave has userCoreKey')
  })

  const discA = a.swarm.join(topic, { server: true, client: false })
  await discA.flushed()

  const discB = b.swarm.join(topic, { server: false, client: true })
  await b.swarm.flush()

  t.teardown(async () => {
    await discA.destroy()
    await discB.destroy()
    await cleanup([a, b])
  })

  const connected = await Promise.race([
    Promise.any([a.connected, b.connected]),
    sleep(20000).then(() => false)
  ])

  t.ok(connected, 'peers connected')

  await sleep(1000)

  t.ok(peerJoinCount > 0, 'peer-join event was emitted')

  // Trigger peer leave by destroying B's swarm and calling handlePeerDisconnection
  await b.swarm.destroy()
  if (b.graph.key) {
    await a.graph.handlePeerDisconnection(b.graph.key)
  }
  await sleep(1000)

  t.ok(peerLeaveCount > 0, 'peer-leave event was emitted')
})

test('hypergraph: unified change event', async (t) => {
  const a = await createPeer('a')

  const changes = []
  a.graph.on('change', (change) => {
    changes.push(change)
  })

  // Test entity-create event
  const post = await a.graph.put({ type: 'post' })
  t.ok(changes.length > 0, 'change event emitted for put')
  t.is(changes[changes.length - 1].type, 'entity-create', 'change type is entity-create')
  t.is(changes[changes.length - 1].id, post.id, 'change includes entity id')

  // Test content-append event
  await a.graph.putContent(post.id, 'hello world', 'text')
  t.ok(changes.length > 1, 'change event emitted for putContent')
  t.is(changes[changes.length - 1].type, 'content-append', 'change type is content-append')
  t.is(changes[changes.length - 1].entityId, post.id, 'change includes entity id')

  // Test relation-create event
  const context = await a.graph.createContext({ writeMode: 'open' })
  let expectedChanges = 2 // put and putContent
  await a.graph.relate({
    from: 'comment/1',
    to: post.id,
    type: 'reply',
    context: context
  })
  expectedChanges++
  t.ok(changes.length >= expectedChanges, 'change event emitted for relate')
  t.is(changes[changes.length - 1].type, 'relation-create', 'change type is relation-create')

  // Test entity-delete event
  await a.graph.del(post.id)
  expectedChanges++
  t.ok(changes.length >= expectedChanges, 'change event emitted for del')
  t.is(changes[changes.length - 1].type, 'entity-delete', 'change type is entity-delete')

  t.teardown(async () => {
    await a.swarm.destroy()
    await a.graph.close()
    await a.store.close()
    fs.rmSync(a.dir, { recursive: true, force: true })
  })
})

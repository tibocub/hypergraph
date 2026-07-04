const test = require('brittle')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const { Hypergraph, HypergraphNetwork } = require('../../index.js')
const crypto = require('crypto')
const os = require('os')
const path = require('path')
const fs = require('fs')

async function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function createPeer (name, { userCoreKey = null, identity = null } = {}) {
  const dir = path.join(os.tmpdir(), `hypergraph-networking-${name}-${process.pid}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })

  const store = new Corestore(dir)
  const graph = new Hypergraph(store, { userCoreKey, identity })
  await graph.ready()

  return { store, graph, dir }
}

async function cleanupPeer (store, graph, dir) {
  await graph.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
}

test('HypergraphNetwork - basic connection', async t => {
  const peer1 = await createPeer('peer1')
  const peer2 = await createPeer('peer2')

  // Create a context on peer 1
  const contextKey1 = await peer1.graph.createContext({ writeMode: 'open' })
  const context1 = await peer1.graph.openContext(contextKey1, { writeMode: 'open' })
  await context1.ready()

  // Join the same context on peer 2
  const context2 = await peer2.graph.openContext(contextKey1, { writeMode: 'open' })
  await context2.ready()

  // Create Hyperswarm instances
  const swarm1 = new Hyperswarm()
  const swarm2 = new Hyperswarm()

  // Create networking helpers with new API (dual swarm architecture)
  const topic = crypto.randomBytes(32)
  const networking1 = new HypergraphNetwork(peer1.graph, peer1.store, swarm1, {
    topic,
    role: 'owner',
    contexts: { chat: contextKey1 }
  })

  const networking2 = new HypergraphNetwork(peer2.graph, peer2.store, swarm2, {
    topic,
    role: 'peer',
    contexts: { chat: contextKey1 }
  })

  // Connect both peers
  await networking1.connect()
  await networking2.connect()

  // Wait for connection
  await sleep(2000)

  t.ok(networking1.connected, 'Peer 1 should be connected')
  t.ok(networking2.connected, 'Peer 2 should be connected')

  // Cleanup
  await networking1.destroy()
  await networking2.destroy()
  await swarm1.destroy()
  await swarm2.destroy()
  await cleanupPeer(peer1.store, peer1.graph, peer1.dir)
  await cleanupPeer(peer2.store, peer2.graph, peer2.dir)
})

test('HypergraphNetwork - swarm parameter required', async t => {
  const peer = await createPeer('peer-swarm-param')

  // Create a context
  const contextKey = await peer.graph.createContext({ writeMode: 'open' })
  await peer.graph.openContext(contextKey, { writeMode: 'open' })

  // Create networking helper without providing swarm (should throw)
  const topic = crypto.randomBytes(32)
  try {
    const networking = new HypergraphNetwork(peer.graph, peer.store, null, {
      topic,
      role: 'owner',
      contexts: { chat: contextKey }
    })
    t.fail('Should throw error when swarm is not provided')
  } catch (err) {
    t.ok(err.message.includes('Hyperswarm instance is required'), 'Should throw appropriate error')
  }

  // Cleanup
  await cleanupPeer(peer.store, peer.graph, peer.dir)
})

test('HypergraphNetwork - multi-context support', async t => {
  const peer1 = await createPeer('peer1-multi')
  const peer2 = await createPeer('peer2-multi')

  // Create multiple contexts on peer 1
  const contextKey1 = await peer1.graph.createContext({ writeMode: 'open' })
  await peer1.graph.openContext(contextKey1, { writeMode: 'open' })

  const contextKey2 = await peer1.graph.createContext({ writeMode: 'open' })
  await peer1.graph.openContext(contextKey2, { writeMode: 'open' })

  // Join the same contexts on peer 2
  await peer2.graph.openContext(contextKey1, { writeMode: 'open' })
  await peer2.graph.openContext(contextKey2, { writeMode: 'open' })

  // Create Hyperswarm instances
  const swarm1 = new Hyperswarm()
  const swarm2 = new Hyperswarm()

  // Create networking helpers with multiple contexts
  const topic = crypto.randomBytes(32)
  const networking1 = new HypergraphNetwork(peer1.graph, peer1.store, swarm1, {
    topic,
    role: 'owner',
    contexts: { chat: contextKey1, moderation: contextKey2 }
  })

  const networking2 = new HypergraphNetwork(peer2.graph, peer2.store, swarm2, {
    topic,
    role: 'peer',
    contexts: { chat: contextKey1, moderation: contextKey2 }
  })

  // Connect both peers
  await networking1.connect()
  await networking2.connect()

  // Wait for connection
  await sleep(2000)

  t.ok(networking1.connected, 'Peer 1 should be connected')
  t.ok(networking2.connected, 'Peer 2 should be connected')

  // Cleanup
  await networking1.destroy()
  await networking2.destroy()
  await swarm1.destroy()
  await swarm2.destroy()
  await cleanupPeer(peer1.store, peer1.graph, peer1.dir)
  await cleanupPeer(peer2.store, peer2.graph, peer2.dir)
})

test('HypergraphNetwork - writer authorization handshake', async t => {
  const peer1 = await createPeer('peer1-handshake')
  const peer2 = await createPeer('peer2-handshake')

  // Create a context on peer 1
  const contextKey1 = await peer1.graph.createContext({ writeMode: 'open' })
  await peer1.graph.openContext(contextKey1, { writeMode: 'open' })

  // Join the same context on peer 2
  await peer2.graph.openContext(contextKey1, { writeMode: 'open' })

  // Create Hyperswarm instances
  const swarm1 = new Hyperswarm()
  const swarm2 = new Hyperswarm()

  // Create networking helpers with owner/peer roles
  const topic = crypto.randomBytes(32)
  const networking1 = new HypergraphNetwork(peer1.graph, peer1.store, swarm1, {
    topic,
    role: 'owner',
    contexts: { chat: contextKey1 }
  })

  const networking2 = new HypergraphNetwork(peer2.graph, peer2.store, swarm2, {
    topic,
    role: 'peer',
    contexts: { chat: contextKey1 }
  })

  // Track writer grant events
  let writerGranted = false
  networking2.on('writer-granted', () => {
    writerGranted = true
  })

  // Connect both peers
  await networking1.connect()
  await networking2.connect()

  // Wait for connection and handshake
  await sleep(3000)

  t.ok(networking1.connected, 'Peer 1 should be connected')
  t.ok(networking2.connected, 'Peer 2 should be connected')
  t.ok(writerGranted, 'Peer should receive writer grant')

  // Cleanup
  await networking1.destroy()
  await networking2.destroy()
  await swarm1.destroy()
  await swarm2.destroy()
  await cleanupPeer(peer1.store, peer1.graph, peer1.dir)
  await cleanupPeer(peer2.store, peer2.graph, peer2.dir)
})

test('HypergraphNetwork - peer discovery via Hyperswarm events', async t => {
  const peer1 = await createPeer('peer1-discovery')
  const peer2 = await createPeer('peer2-discovery')

  // Create a context on peer 1
  const contextKey1 = await peer1.graph.createContext({ writeMode: 'open' })
  await peer1.graph.openContext(contextKey1, { writeMode: 'open' })

  // Join the same context on peer 2
  await peer2.graph.openContext(contextKey1, { writeMode: 'open' })

  // Create Hyperswarm instances
  const swarm1 = new Hyperswarm()
  const swarm2 = new Hyperswarm()

  // Create networking helpers
  const topic = crypto.randomBytes(32)
  const networking1 = new HypergraphNetwork(peer1.graph, peer1.store, swarm1, {
    topic,
    role: 'owner',
    contexts: { chat: contextKey1 }
  })

  const networking2 = new HypergraphNetwork(peer2.graph, peer2.store, swarm2, {
    topic,
    role: 'peer',
    contexts: { chat: contextKey1 }
  })

  // Track peer discovery events
  let peerJoined = false
  networking1.on('peer-join', () => {
    peerJoined = true
  })

  // Connect both peers
  await networking1.connect()
  await networking2.connect()

  await sleep(2000)

  t.ok(networking1.connected, 'Peer 1 should be connected')
  t.ok(networking2.connected, 'Peer 2 should be connected')
  t.ok(peerJoined, 'Should detect peer join via Hyperswarm events')

  // Cleanup
  await networking1.destroy()
  await networking2.destroy()
  await swarm1.destroy()
  await swarm2.destroy()
  await cleanupPeer(peer1.store, peer1.graph, peer1.dir)
  await cleanupPeer(peer2.store, peer2.graph, peer2.dir)
})

test('HypergraphNetwork - bootstrap generation', async t => {
  const peer = await createPeer('peer-bootstrap')

  // Create contexts
  const contextKey1 = await peer.graph.createContext({ writeMode: 'open' })
  const contextKey2 = await peer.graph.createContext({ writeMode: 'open' })

  const topic = crypto.randomBytes(32)
  const bootstrap = HypergraphNetwork.generateBootstrap(peer.graph, {
    topic,
    topicPrefix: 'my-app-v1',
    contexts: { comments: contextKey1, moderation: contextKey2 },
    metadata: { appName: 'test-app' }
  })

  t.ok(bootstrap.version, 'Bootstrap should have version')
  t.ok(bootstrap.topic, 'Bootstrap should have topic')
  t.ok(bootstrap.controlTopic, 'Bootstrap should have controlTopic')
  t.ok(bootstrap.ownerCore, 'Bootstrap should have ownerCore')
  t.ok(bootstrap.contexts, 'Bootstrap should have contexts')
  t.ok(bootstrap.contexts.comments === contextKey1, 'Context key should match')
  t.ok(bootstrap.contexts.moderation === contextKey2, 'Context key should match')
  t.ok(bootstrap.metadata.appName === 'test-app', 'Metadata should be preserved')

  // Cleanup
  await cleanupPeer(peer.store, peer.graph, peer.dir)
})

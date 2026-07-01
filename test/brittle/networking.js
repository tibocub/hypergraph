const test = require('brittle')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const { Hypergraph, HypergraphNetworking } = require('../../index.js')
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

test.skip('HypergraphNetworking - basic connection', async t => {
  const peer1 = await createPeer('peer1')
  const peer2 = await createPeer('peer2')

  // Create a context on peer 1
  const contextKey1 = await peer1.graph.createContext({ writeMode: 'open' })
  const context1 = await peer1.graph.openContext(contextKey1, { writeMode: 'open' })
  await context1.ready()

  // Join the same context on peer 2
  const context2 = await peer2.graph.openContext(contextKey1, { writeMode: 'open' })
  await context2.ready()

  // Create networking helpers with new API (two-swarm architecture)
  const topic = crypto.randomBytes(32)
  const networking1 = new HypergraphNetworking(peer1.graph, peer1.store, {
    topic,
    role: 'owner',
    contexts: { chat: contextKey1 }
  })

  const networking2 = new HypergraphNetworking(peer2.graph, peer2.store, {
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
  await cleanupPeer(peer1.store, peer1.graph, peer1.dir)
  await cleanupPeer(peer2.store, peer2.graph, peer2.dir)
})

test.skip('HypergraphNetworking - auto-create swarm', async t => {
  const peer = await createPeer('peer-auto-swarm')

  // Create a context
  const contextKey = await peer.graph.createContext({ writeMode: 'open' })
  await peer.graph.openContext(contextKey, { writeMode: 'open' })

  // Create networking helper without providing swarm (should auto-create)
  const topic = crypto.randomBytes(32)
  const networking = new HypergraphNetworking(peer.graph, peer.store, {
    topic,
    role: 'owner',
    contexts: { chat: contextKey }
  })

  await networking.connect()

  t.ok(networking.connected, 'Should be connected')
  t.ok(networking.dataSwarm, 'Data swarm should be auto-created')
  t.ok(networking.controlSwarm, 'Control swarm should be auto-created')

  // Cleanup
  await networking.destroy()
  await cleanupPeer(peer.store, peer.graph, peer.dir)
})

test.skip('HypergraphNetworking - multi-context support', async t => {
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

  // Create networking helpers with multiple contexts (using new API)
  const topic = crypto.randomBytes(32)
  const networking1 = new HypergraphNetworking(peer1.graph, peer1.store, {
    topic,
    role: 'owner',
    contexts: { chat: contextKey1, moderation: contextKey2 }
  })

  const networking2 = new HypergraphNetworking(peer2.graph, peer2.store, {
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
  await cleanupPeer(peer1.store, peer1.graph, peer1.dir)
  await cleanupPeer(peer2.store, peer2.graph, peer2.dir)
})

test.skip('HypergraphNetworking - writer authorization handshake', async t => {
  const peer1 = await createPeer('peer1-handshake')
  const peer2 = await createPeer('peer2-handshake')

  // Create a context on peer 1
  const contextKey1 = await peer1.graph.createContext({ writeMode: 'open' })
  await peer1.graph.openContext(contextKey1, { writeMode: 'open' })

  // Join the same context on peer 2
  await peer2.graph.openContext(contextKey1, { writeMode: 'open' })

  // Create networking helpers with owner/peer roles
  const topic = crypto.randomBytes(32)
  const networking1 = new HypergraphNetworking(peer1.graph, peer1.store, {
    topic,
    role: 'owner',
    contexts: { chat: contextKey1 }
  })

  const networking2 = new HypergraphNetworking(peer2.graph, peer2.store, {
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
  await cleanupPeer(peer1.store, peer1.graph, peer1.dir)
  await cleanupPeer(peer2.store, peer2.graph, peer2.dir)
})

test.skip('HypergraphNetworking - peer discovery via context relations', async t => {
  const peer1 = await createPeer('peer1-discovery')
  const peer2 = await createPeer('peer2-discovery')

  // Create a context on peer 1
  const contextKey1 = await peer1.graph.createContext({ writeMode: 'open' })
  await peer1.graph.openContext(contextKey1, { writeMode: 'open' })

  // Join the same context on peer 2
  await peer2.graph.openContext(contextKey1, { writeMode: 'open' })

  // Create networking helpers
  const topic = crypto.randomBytes(32)
  const networking1 = new HypergraphNetworking(peer1.graph, peer1.store, {
    topic,
    role: 'owner',
    contexts: { chat: contextKey1 }
  })

  const networking2 = new HypergraphNetworking(peer2.graph, peer2.store, {
    topic,
    role: 'peer',
    contexts: { chat: contextKey1 }
  })

  // Track peer discovery events
  let peerDiscovered = false
  networking1.on('peer-discovered', () => {
    peerDiscovered = true
  })

  // Connect both peers
  await networking1.connect()
  await networking2.connect()

  // Announce usercores and discover peers
  await networking1.announceUserCore(contextKey1, 'chatroom')
  await networking2.announceUserCore(contextKey1, 'chatroom')

  await sleep(2000)

  // Discover peers
  const discovered1 = await networking1.discoverPeerCores(contextKey1, 'chatroom')
  const discovered2 = await networking2.discoverPeerCores(contextKey1, 'chatroom')

  t.ok(networking1.connected, 'Peer 1 should be connected')
  t.ok(networking2.connected, 'Peer 2 should be connected')
  t.ok(discovered1.length > 0 || discovered2.length > 0, 'Should discover peers')

  // Cleanup
  await networking1.destroy()
  await networking2.destroy()
  await cleanupPeer(peer1.store, peer1.graph, peer1.dir)
  await cleanupPeer(peer2.store, peer2.graph, peer2.dir)
})

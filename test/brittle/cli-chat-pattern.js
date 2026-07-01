const test = require('brittle')
const Corestore = require('corestore')
const { Hypergraph, HypergraphNetworking } = require('../../index.js')
const crypto = require('crypto')
const os = require('os')
const path = require('path')
const fs = require('fs')

async function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function createPeer (name) {
  const dir = path.join(os.tmpdir(), `hypergraph-cli-chat-${name}-${process.pid}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })

  const store = new Corestore(dir)
  const graph = new Hypergraph(store)
  await graph.ready()

  return { store, graph, dir }
}

async function cleanupPeer (store, graph, dir) {
  await graph.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
}

test.skip('CLI chat pattern: 3 peers with writer authorization', { timeout: 120000 }, async t => {
  const peer1 = await createPeer('peer1')
  const peer2 = await createPeer('peer2')
  const peer3 = await createPeer('peer3')

  try {
    // IMPORTANT: Create context on peer1, then open on peer2 and peer3
    // This is the key pattern that makes Autobase replication work
    const contextKey = await peer1.graph.createContext({ writeMode: 'open' })
    const context1 = await peer1.graph.openContext(contextKey, { writeMode: 'open' })
    await context1.ready()

    const context2 = await peer2.graph.openContext(contextKey, { writeMode: 'open' })
    await context2.ready()

    const context3 = await peer3.graph.openContext(contextKey, { writeMode: 'open' })
    await context3.ready()

    // Create networking helpers with auto-add writers
    const topic = crypto.createHash('sha256').update('cli-chat-test').digest()
    
    const networking1 = new HypergraphNetworking(peer1.graph, peer1.store, {
      topic,
      contexts: { chatroom: contextKey },
      autoAddWriters: true
    })

    const networking2 = new HypergraphNetworking(peer2.graph, peer2.store, {
      topic,
      contexts: { chatroom: contextKey },
      autoAddWriters: true
    })

    const networking3 = new HypergraphNetworking(peer3.graph, peer3.store, {
      topic,
      contexts: { chatroom: contextKey },
      autoAddWriters: true
    })

    // Track peer join events
    const peer1Joins = []
    const peer2Joins = []
    const peer3Joins = []

    networking1.on('peer-join', ({ peerKey }) => peer1Joins.push(peerKey))
    networking2.on('peer-join', ({ peerKey }) => peer2Joins.push(peerKey))
    networking3.on('peer-join', ({ peerKey }) => peer3Joins.push(peerKey))

    // Track writer grant events
    const peer1Grants = []
    const peer2Grants = []
    const peer3Grants = []

    networking1.on('writer-granted', (msg) => peer1Grants.push(msg))
    networking2.on('writer-granted', (msg) => peer2Grants.push(msg))
    networking3.on('writer-granted', (msg) => peer3Grants.push(msg))

    // Connect all peers
    await networking1.connect()
    await networking2.connect()
    await networking3.connect()

    // Wait for connections and writer authorization
    await sleep(10000)

    console.log('[TEST] peer1 joins:', peer1Joins.length)
    console.log('[TEST] peer2 joins:', peer2Joins.length)
    console.log('[TEST] peer3 joins:', peer3Joins.length)

    console.log('[TEST] peer1 grants:', peer1Grants.length)
    console.log('[TEST] peer2 grants:', peer2Grants.length)
    console.log('[TEST] peer3 grants:', peer3Grants.length)

    t.ok(networking1.connected, 'Peer 1 should be connected')
    t.ok(networking2.connected, 'Peer 2 should be connected')
    t.ok(networking3.connected, 'Peer 3 should be connected')

    t.ok(networking1.peerCount > 0, 'Peer 1 should have peer connections')
    t.ok(networking2.peerCount > 0, 'Peer 2 should have peer connections')
    t.ok(networking3.peerCount > 0, 'Peer 3 should have peer connections')

    // Verify writer authorization happened
    t.ok(peer1Grants.length > 0, 'Peer 1 should receive writer grants')
    t.ok(peer2Grants.length > 0, 'Peer 2 should receive writer grants')
    t.ok(peer3Grants.length > 0, 'Peer 3 should receive writer grants')

    // Announce usercores (like cli-chat does)
    await peer1.graph.relate({
      from: `usercore:${peer1.graph.key.toString('hex')}`,
      to: 'chatroom',
      type: 'announce',
      context: contextKey
    })

    await peer2.graph.relate({
      from: `usercore:${peer2.graph.key.toString('hex')}`,
      to: 'chatroom',
      type: 'announce',
      context: contextKey
    })

    await peer3.graph.relate({
      from: `usercore:${peer3.graph.key.toString('hex')}`,
      to: 'chatroom',
      type: 'announce',
      context: contextKey
    })

    // Wait for replication
    await sleep(10000)
    await peer1.graph.update()
    await peer2.graph.update()
    await peer3.graph.update()

    // Discover peer usercores using HypergraphNetworking helper
    const peer1Discovered = await networking1.discoverPeerCores(contextKey, 'chatroom')
    const peer2Discovered = await networking2.discoverPeerCores(contextKey, 'chatroom')
    const peer3Discovered = await networking3.discoverPeerCores(contextKey, 'chatroom')

    console.log('[TEST] peer1 discovered:', peer1Discovered.length, 'peers')
    console.log('[TEST] peer2 discovered:', peer2Discovered.length, 'peers')
    console.log('[TEST] peer3 discovered:', peer3Discovered.length, 'peers')

    t.ok(peer1Discovered.length >= 2, 'Peer 1 should discover at least 2 peers')
    t.ok(peer2Discovered.length >= 2, 'Peer 2 should discover at least 2 peers')
    t.ok(peer3Discovered.length >= 2, 'Peer 3 should discover at least 2 peers')

    // Test message propagation: peer1 sends, peer2 and peer3 receive
    const msg1 = await peer1.graph.put({
      type: 'message',
      username: 'peer1',
      timestamp: Date.now()
    })
    await peer1.graph.putContent(msg1.id, 'Hello from peer1', 'text')

    // Wait for replication
    await sleep(15000)
    await peer1.graph.update()
    await peer2.graph.update()
    await peer3.graph.update()

    // Check if peer2 can read peer1's message
    const peer1UserCore2 = await peer2.graph.openUserCore(peer1.graph.key.toString('hex'))
    let peer2Found = false
    for await (const node of peer1UserCore2.createReadStream()) {
      if (node.id === msg1.id) {
        peer2Found = true
        break
      }
    }
    t.ok(peer2Found, 'Peer 2 should receive peer1 message')

    // Check if peer3 can read peer1's message
    const peer1UserCore3 = await peer3.graph.openUserCore(peer1.graph.key.toString('hex'))
    let peer3Found = false
    for await (const node of peer1UserCore3.createReadStream()) {
      if (node.id === msg1.id) {
        peer3Found = true
        break
      }
    }
    t.ok(peer3Found, 'Peer 3 should receive peer1 message')

    // Test peer2 -> peer3 propagation
    const msg2 = await peer2.graph.put({
      type: 'message',
      username: 'peer2',
      timestamp: Date.now()
    })
    await peer2.graph.putContent(msg2.id, 'Hello from peer2', 'text')

    await sleep(10000)
    await peer3.graph.update()

    const peer2UserCore3 = await peer3.graph.openUserCore(peer2.graph.key.toString('hex'))
    let peer3FoundPeer2 = false
    for await (const node of peer2UserCore3.createReadStream()) {
      if (node.id === msg2.id) {
        peer3FoundPeer2 = true
        break
      }
    }
    t.ok(peer3FoundPeer2, 'Peer 3 should receive peer2 message')

    console.log('[TEST] All tests passed!')

    // Cleanup
    await networking1.destroy()
    await networking2.destroy()
    await networking3.destroy()
  } finally {
    await cleanupPeer(peer1.store, peer1.graph, peer1.dir)
    await cleanupPeer(peer2.store, peer2.graph, peer2.dir)
    await cleanupPeer(peer3.store, peer3.graph, peer3.dir)
  }
})

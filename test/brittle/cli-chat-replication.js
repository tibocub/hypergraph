const test = require('brittle')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const { Hypergraph, HypergraphNetworking } = require('../../index.js')
const b4a = require('b4a')
const os = require('os')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

test.skip('CLI chat replication - real-world hyperswarm scenario', async t => {
  // Create storage for two peers using temporary directories
  const storage1 = path.join(os.tmpdir(), `hypergraph-cli-chat-test-1-${process.pid}-${Date.now()}`)
  const storage2 = path.join(os.tmpdir(), `hypergraph-cli-chat-test-2-${process.pid}-${Date.now()}`)
  fs.mkdirSync(storage1, { recursive: true })
  fs.mkdirSync(storage2, { recursive: true })

  // Create second peer
  const store2 = new Corestore(storage2)
  const graph2 = new Hypergraph(store2)
  await graph2.ready()

  console.log(`[Peer 2] Peer ID: ${graph2.identity.deviceKeyPair.publicKey.toString('hex').slice(0, 16)}...`)

  // Create first peer
  const store1 = new Corestore(storage1)
  const graph1 = new Hypergraph(store1)
  await graph1.ready()

  console.log(`[Peer 1] Peer ID: ${graph1.identity.deviceKeyPair.publicKey.toString('hex').slice(0, 16)}...`)

  // Create chat context on peer 1
  const contextKey1 = await graph1.createContext({ writeMode: 'open' })
  await graph1.openContext(contextKey1, { writeMode: 'open' })
  console.log(`[Peer 1] Created context: ${contextKey1.slice(0, 16)}...`)

  // Join the same context on peer 2
  await graph2.openContext(contextKey1, { writeMode: 'open' })
  console.log(`[Peer 2] Joined context: ${contextKey1.slice(0, 16)}...`)

  // Use a random topic (like the networking tests)
  const topic = crypto.randomBytes(32)

  // Track actual peer connections (not just swarm join)
  let peer1ConnectedResolve
  const peer1ConnectedPromise = new Promise((resolve) => { peer1ConnectedResolve = resolve })
  let peer2ConnectedResolve
  const peer2ConnectedPromise = new Promise((resolve) => { peer2ConnectedResolve = resolve })

  // Create networking helpers using the new API (two-swarm architecture)
  const networking1 = new HypergraphNetworking(graph1, store1, {
    topic,
    role: 'owner',
    contexts: { chat: contextKey1 }
  })

  const networking2 = new HypergraphNetworking(graph2, store2, {
    topic,
    role: 'peer',
    contexts: { chat: contextKey1 }
  })

  // Track peer connections via the networking helper's peer-connected event
  networking1.on('peer-connected', () => {
    if (peer1ConnectedResolve) {
      peer1ConnectedResolve(true)
      peer1ConnectedResolve = null
    }
  })

  networking2.on('peer-connected', () => {
    if (peer2ConnectedResolve) {
      peer2ConnectedResolve(true)
      peer2ConnectedResolve = null
    }
  })

  // Connect both peers
  await networking1.connect()
  await networking2.connect()

  console.log(`[Peer 1] Connected to swarm`)
  console.log(`[Peer 2] Connected to swarm`)

  // Wait for peers to discover each other
  const connected = await Promise.race([
    Promise.all([peer1ConnectedPromise, peer2ConnectedPromise]),
    new Promise(resolve => setTimeout(() => resolve(false), 10000))
  ])
  
  t.ok(connected, 'Peers should discover each other')

  // Cleanup
  await networking1.destroy()
  await networking2.destroy()
  await store1.close()
  await store2.close()
  await graph1.close()
  await graph2.close()

  // Remove temporary directories
  fs.rmSync(storage1, { recursive: true, force: true })
  fs.rmSync(storage2, { recursive: true, force: true })
})

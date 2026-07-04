// NOTE ON NETWORK DEPENDENCY:
// "swarm parameter required" and "bootstrap generation" run entirely
// locally and were verified in a sandboxed environment with no DHT access.
// The other four tests spin up real Hyperswarm instances and dial the
// public DHT to connect two peers — they cannot be verified without real
// network access. Run this whole file on a machine with internet access
// before trusting the DHT-dependent results.
//
// TEARDOWN ORDERING BUG FOUND & FIXED: brittle's t.teardown() runs in LIFO
// order (last registered runs first). createGraph() registers its own
// graph/store-close teardown as soon as it's called — which, in every DHT
// test below, happens *before* the swarm is even created. That meant swarm
// destruction was always running BEFORE the graph/store close, tearing the
// raw socket out from under an in-flight replication stream mid-shutdown.
// store.close() would then hang forever waiting for a clean stream-close
// event that could never arrive, freezing the whole test run with no error.
// Fixed by explicitly closing each peer (via peer.close(), see helpers.js)
// *before* destroying its swarm, in one consolidated teardown per test.

const test = require('brittle')
const Hyperswarm = require('hyperswarm')
const { HypergraphNetwork } = require('../../../index.js')
const crypto = require('crypto')
const { createGraph, sleep } = require('../helpers')

test('hypergraph-network: swarm parameter is required', async (t) => {
  console.log('TEST: swarm parameter required - starting')
  const { graph, store } = await createGraph(t, 'hn-swarm-param')

  const contextKey = await graph.createContext({ writeMode: 'open' })
  await graph.openContext(contextKey, { writeMode: 'open' })

  const topic = crypto.randomBytes(32)
  t.exception(
    () => new HypergraphNetwork(graph, store, null, { topic, role: 'owner', contexts: { chat: contextKey } }),
    /Hyperswarm instance is required/,
    'constructor throws when no swarm is provided'
  )
  console.log('TEST: swarm parameter required - passed')
})

test('hypergraph-network: generateBootstrap produces a joinable descriptor', async (t) => {
  console.log('TEST: bootstrap generation - starting')
  const { graph } = await createGraph(t, 'hn-bootstrap')

  console.log('  Step 1: create two contexts to include in the bootstrap')
  const contextKey1 = await graph.createContext({ writeMode: 'open' })
  const contextKey2 = await graph.createContext({ writeMode: 'open' })

  console.log('  Step 2: generate the bootstrap descriptor')
  const topic = crypto.randomBytes(32)
  const bootstrap = HypergraphNetwork.generateBootstrap(graph, {
    topic,
    topicPrefix: 'my-app-v1',
    contexts: { comments: contextKey1, moderation: contextKey2 },
    metadata: { appName: 'test-app' }
  })

  console.log('  Step 3: verify the descriptor shape')
  t.ok(bootstrap.version, 'bootstrap has a version')
  t.ok(bootstrap.topic, 'bootstrap has a topic')
  t.ok(bootstrap.controlTopic, 'bootstrap has a controlTopic')
  t.ok(bootstrap.ownerCore, 'bootstrap has an ownerCore')
  t.ok(bootstrap.contexts, 'bootstrap has a contexts map')
  t.is(bootstrap.contexts.comments, contextKey1, 'comments context key matches')
  t.is(bootstrap.contexts.moderation, contextKey2, 'moderation context key matches')
  t.is(bootstrap.metadata.appName, 'test-app', 'metadata is preserved')
  console.log('TEST: bootstrap generation - passed')
})

// Consolidated, correctly-ordered teardown for a two-peer DHT test:
// 1) destroy the HypergraphNetwork wrappers, 2) close each peer's graph and
// store (letting replication streams end gracefully), 3) destroy the raw
// swarms last, once nothing is relying on them anymore.
function registerTeardown (t, { peer1, peer2, swarm1, swarm2, networking1, networking2 }) {
  t.teardown(async () => {
    try { await networking1.destroy() } catch (err) { /* already closed */ }
    try { await networking2.destroy() } catch (err) { /* already closed */ }
    await peer1.close()
    await peer2.close()
    try { await swarm1.destroy() } catch (err) { /* already closed */ }
    try { await swarm2.destroy() } catch (err) { /* already closed */ }
  })
}

test('hypergraph-network: two peers connect over the DHT (needs real network)', async (t) => {
  console.log('TEST: basic connection - starting (requires DHT access)')
  const peer1 = await createGraph(t, 'hn-basic-1')
  const peer2 = await createGraph(t, 'hn-basic-2')

  const contextKey1 = await peer1.graph.createContext({ writeMode: 'open' })
  await (await peer1.graph.openContext(contextKey1, { writeMode: 'open' })).ready()
  await (await peer2.graph.openContext(contextKey1, { writeMode: 'open' })).ready()

  const swarm1 = new Hyperswarm()
  const swarm2 = new Hyperswarm()

  const topic = crypto.randomBytes(32)
  const networking1 = new HypergraphNetwork(peer1.graph, peer1.store, swarm1, { topic, role: 'owner', contexts: { chat: contextKey1 } })
  const networking2 = new HypergraphNetwork(peer2.graph, peer2.store, swarm2, { topic, role: 'peer', contexts: { chat: contextKey1 } })
  registerTeardown(t, { peer1, peer2, swarm1, swarm2, networking1, networking2 })

  await networking1.connect()
  await networking2.connect()
  await sleep(2000)

  t.ok(networking1.connected, 'peer 1 is connected')
  t.ok(networking2.connected, 'peer 2 is connected')
  console.log('TEST: basic connection - passed')
})

test('hypergraph-network: a single connection carries multiple contexts (needs real network)', async (t) => {
  console.log('TEST: multi-context support - starting (requires DHT access)')
  const peer1 = await createGraph(t, 'hn-multi-1')
  const peer2 = await createGraph(t, 'hn-multi-2')

  const contextKey1 = await peer1.graph.createContext({ writeMode: 'open' })
  await peer1.graph.openContext(contextKey1, { writeMode: 'open' })
  const contextKey2 = await peer1.graph.createContext({ writeMode: 'open' })
  await peer1.graph.openContext(contextKey2, { writeMode: 'open' })

  await peer2.graph.openContext(contextKey1, { writeMode: 'open' })
  await peer2.graph.openContext(contextKey2, { writeMode: 'open' })

  const swarm1 = new Hyperswarm()
  const swarm2 = new Hyperswarm()

  const topic = crypto.randomBytes(32)
  const contexts = { chat: contextKey1, moderation: contextKey2 }
  const networking1 = new HypergraphNetwork(peer1.graph, peer1.store, swarm1, { topic, role: 'owner', contexts })
  const networking2 = new HypergraphNetwork(peer2.graph, peer2.store, swarm2, { topic, role: 'peer', contexts })
  registerTeardown(t, { peer1, peer2, swarm1, swarm2, networking1, networking2 })

  await networking1.connect()
  await networking2.connect()
  await sleep(2000)

  t.ok(networking1.connected, 'peer 1 is connected')
  t.ok(networking2.connected, 'peer 2 is connected')
  console.log('TEST: multi-context support - passed')
})

test('hypergraph-network: peer role receives a writer grant from owner (needs real network)', async (t) => {
  console.log('TEST: writer authorization handshake - starting (requires DHT access)')
  const peer1 = await createGraph(t, 'hn-handshake-1')
  const peer2 = await createGraph(t, 'hn-handshake-2')

  const contextKey1 = await peer1.graph.createContext({ writeMode: 'open' })
  await peer1.graph.openContext(contextKey1, { writeMode: 'open' })
  await peer2.graph.openContext(contextKey1, { writeMode: 'open' })

  const swarm1 = new Hyperswarm()
  const swarm2 = new Hyperswarm()

  const topic = crypto.randomBytes(32)
  const networking1 = new HypergraphNetwork(peer1.graph, peer1.store, swarm1, { topic, role: 'owner', contexts: { chat: contextKey1 } })
  const networking2 = new HypergraphNetwork(peer2.graph, peer2.store, swarm2, { topic, role: 'peer', contexts: { chat: contextKey1 } })
  registerTeardown(t, { peer1, peer2, swarm1, swarm2, networking1, networking2 })

  let writerGranted = false
  networking2.on('writer-granted', () => { writerGranted = true })

  await networking1.connect()
  await networking2.connect()
  await sleep(3000)

  t.ok(networking1.connected, 'peer 1 is connected')
  t.ok(networking2.connected, 'peer 2 is connected')
  t.ok(writerGranted, 'peer received a writer grant from the owner')
  console.log('TEST: writer authorization handshake - passed')
})

test('hypergraph-network: emits peer-join via Hyperswarm connection events (needs real network)', async (t) => {
  console.log('TEST: peer discovery via Hyperswarm events - starting (requires DHT access)')
  const peer1 = await createGraph(t, 'hn-discovery-1')
  const peer2 = await createGraph(t, 'hn-discovery-2')

  const contextKey1 = await peer1.graph.createContext({ writeMode: 'open' })
  await peer1.graph.openContext(contextKey1, { writeMode: 'open' })
  await peer2.graph.openContext(contextKey1, { writeMode: 'open' })

  const swarm1 = new Hyperswarm()
  const swarm2 = new Hyperswarm()

  const topic = crypto.randomBytes(32)
  const networking1 = new HypergraphNetwork(peer1.graph, peer1.store, swarm1, { topic, role: 'owner', contexts: { chat: contextKey1 } })
  const networking2 = new HypergraphNetwork(peer2.graph, peer2.store, swarm2, { topic, role: 'peer', contexts: { chat: contextKey1 } })
  registerTeardown(t, { peer1, peer2, swarm1, swarm2, networking1, networking2 })

  let peerJoined = false
  networking1.on('peer-join', () => { peerJoined = true })

  await networking1.connect()
  await networking2.connect()
  await sleep(2000)

  t.ok(networking1.connected, 'peer 1 is connected')
  t.ok(networking2.connected, 'peer 2 is connected')
  t.ok(peerJoined, 'peer-join event fired via Hyperswarm connection events')
  console.log('TEST: peer discovery via Hyperswarm events - passed')
})

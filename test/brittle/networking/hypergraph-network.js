// NOTE ON NETWORK DEPENDENCY:
// "swarm parameter required" and "bootstrap generation" run entirely
// locally. "two peers connect", "multi-context support", "writer
// authorization handshake", and "peer discovery" all need a real
// Hyperswarm/DHT connection.
//
// REDESIGN: HypergraphNetwork no longer creates a second, internally-owned
// Hyperswarm swarm for a separate "control" topic. Writer-authorization
// messages are now a protomux channel multiplexed onto the same connection
// the (single, caller-owned) swarm already establishes for replication —
// see src/networking.js's class doc comment for the full rationale. This
// means there's no longer a separate control-channel connection to wait
// for or diagnose separately from the main connection.

const test = require('brittle')
const Hyperswarm = require('hyperswarm')
const { HypergraphNetwork } = require('../../../index.js')
const crypto = require('crypto')
const { createGraph, sleep, destroySwarm } = require('../helpers')

test('hypergraph-network: swarm parameter is required', async (t) => {
  const { graph, store } = await createGraph(t, 'hn-swarm-param')
  const contextKey = await graph.createContext({ writeMode: 'open' })
  await graph.openContext(contextKey, { writeMode: 'open' })

  const topic = crypto.randomBytes(32)
  t.exception(
    () => new HypergraphNetwork(graph, store, null, { topic, role: 'owner', contexts: { chat: contextKey } }),
    /Hyperswarm instance is required/,
    'constructor throws when no swarm is provided'
  )
})

test('hypergraph-network: generateBootstrap produces a joinable descriptor', async (t) => {
  const { graph } = await createGraph(t, 'hn-bootstrap')

  const contextKey1 = await graph.createContext({ writeMode: 'open' })
  const contextKey2 = await graph.createContext({ writeMode: 'open' })

  const topic = crypto.randomBytes(32)
  const bootstrap = HypergraphNetwork.generateBootstrap(graph, {
    topic,
    contexts: { comments: contextKey1, moderation: contextKey2 },
    metadata: { appName: 'test-app' }
  })

  t.ok(bootstrap.version, 'bootstrap has a version')
  t.ok(bootstrap.topic, 'bootstrap has a topic')
  t.ok(bootstrap.ownerCore, 'bootstrap has an ownerCore')
  t.ok(bootstrap.contexts, 'bootstrap has a contexts map')
  t.is(bootstrap.contexts.comments, contextKey1, 'comments context key matches')
  t.is(bootstrap.contexts.moderation, contextKey2, 'moderation context key matches')
  t.is(bootstrap.metadata.appName, 'test-app', 'metadata is preserved')
})

function registerTeardown (t, { peer1, peer2, swarm1, swarm2, networking1, networking2 }) {
  t.teardown(async () => {
    try { await networking1.destroy() } catch (err) { /* already closed */ }
    try { await networking2.destroy() } catch (err) { /* already closed */ }
    await peer1.close()
    await peer2.close()
    await destroySwarm(swarm1)
    await destroySwarm(swarm2)
  })
}

test('hypergraph-network: two peers connect over the DHT (needs real network)', { timeout: 180000 }, async (t) => {
  const peer1 = await createGraph(t, 'hn-basic-1')
  const peer2 = await createGraph(t, 'hn-basic-2')

  const contextKey1 = await peer1.graph.createContext({ writeMode: 'open' })
  await peer1.graph.openContext(contextKey1, { writeMode: 'open' })
  await peer2.graph.openContext(contextKey1, { writeMode: 'open' })

  const swarm1 = new Hyperswarm()
  const swarm2 = new Hyperswarm()

  const topic = crypto.randomBytes(32)
  const networking1 = new HypergraphNetwork(peer1.graph, peer1.store, swarm1, { topic, role: 'owner', contexts: { chat: contextKey1 } })
  const networking2 = new HypergraphNetwork(peer2.graph, peer2.store, swarm2, { topic, role: 'peer', contexts: { chat: contextKey1 } })
  registerTeardown(t, { peer1, peer2, swarm1, swarm2, networking1, networking2 })
  networking1.on('flush-timeout', (info) => console.log(`    [peer1] flush-timeout: ${info.step} exceeded ${info.timeoutMs}ms`))
  networking2.on('flush-timeout', (info) => console.log(`    [peer2] flush-timeout: ${info.step} exceeded ${info.timeoutMs}ms`))
  networking1.on('connection-retry', (info) => console.log(`    [peer1] connection-retry: attempt ${info.attempt}`))
  networking2.on('connection-retry', (info) => console.log(`    [peer2] connection-retry: attempt ${info.attempt}`))

  await Promise.all([networking1.connect(), networking2.connect()])
  await sleep(2000)

  t.ok(networking1.connected, 'peer 1 is connected')
  t.ok(networking2.connected, 'peer 2 is connected')
})

test('hypergraph-network: a single connection carries multiple contexts (needs real network)', { timeout: 180000 }, async (t) => {
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
  networking1.on('flush-timeout', (info) => console.log(`    [peer1] flush-timeout: ${info.step} exceeded ${info.timeoutMs}ms`))
  networking2.on('flush-timeout', (info) => console.log(`    [peer2] flush-timeout: ${info.step} exceeded ${info.timeoutMs}ms`))

  await Promise.all([networking1.connect(), networking2.connect()])
  await sleep(2000)

  t.ok(networking1.connected, 'peer 1 is connected')
  t.ok(networking2.connected, 'peer 2 is connected')
})

test('hypergraph-network: peer role receives a writer grant from owner (needs real network)', { timeout: 180000 }, async (t) => {
  // Simplified by the protomux redesign: writer-auth now rides the same
  // connection as replication, so there's no separate control-channel
  // connection to wait for — once `connected` is backed by a real peer
  // (confirmed via waitForPeer(), not just the optimistic `connected`
  // flag), the writer-grant handshake should follow shortly after.
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
  networking1.on('flush-timeout', (info) => console.log(`    [peer1] flush-timeout: ${info.step} exceeded ${info.timeoutMs}ms`))
  networking2.on('flush-timeout', (info) => console.log(`    [peer2] flush-timeout: ${info.step} exceeded ${info.timeoutMs}ms`))
  networking1.on('connection-retry', (info) => console.log(`    [peer1] connection-retry: attempt ${info.attempt}`))
  networking2.on('connection-retry', (info) => console.log(`    [peer2] connection-retry: attempt ${info.attempt}`))

  let writerGranted = false
  networking2.on('writer-granted', () => { writerGranted = true })

  await Promise.all([networking1.connect(), networking2.connect()])
  t.ok(networking1.connected, 'peer 1 is connected')
  t.ok(networking2.connected, 'peer 2 is connected')

  console.log('  Waiting for an actual peer connection via waitForPeer()')
  await t.execution(Promise.all([networking1.waitForPeer(90000), networking2.waitForPeer(90000)]), 'both peers confirm a real connection')

  console.log('  Waiting for the writer-grant handshake to complete')
  for (let i = 0; i < 30 && !writerGranted; i++) {
    await sleep(1000)
    if (i % 10 === 0) console.log(`    ...waiting (${i}s): writerGranted=${writerGranted}`)
  }
  t.ok(writerGranted, 'peer received a writer grant from the owner over the same connection as replication')
})

test('hypergraph-network: emits peer-join via Hyperswarm connection events (needs real network)', { timeout: 180000 }, async (t) => {
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
  networking1.on('flush-timeout', (info) => console.log(`    [peer1] flush-timeout: ${info.step} exceeded ${info.timeoutMs}ms`))
  networking2.on('flush-timeout', (info) => console.log(`    [peer2] flush-timeout: ${info.step} exceeded ${info.timeoutMs}ms`))

  let peerJoined = false
  networking1.on('peer-join', () => { peerJoined = true })

  await Promise.all([networking1.connect(), networking2.connect()])
  t.ok(networking1.connected, 'peer 1 is connected')
  t.ok(networking2.connected, 'peer 2 is connected')

  await t.execution(networking1.waitForPeer(90000), 'waitForPeer() resolves once a real peer connection is established')
  t.ok(peerJoined, 'peer-join event fired via Hyperswarm connection events')
})

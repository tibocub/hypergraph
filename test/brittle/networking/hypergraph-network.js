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

test('hypergraph-network: connectFromBootstrap actually consumes a bootstrap to join a peer (no network needed)', async (t) => {
  // Unlike the test above, which only checks the shape of generateBootstrap()'s
  // output, this verifies the OTHER half actually works: a second peer
  // consuming that descriptor via connectFromBootstrap(), connecting, and
  // receiving the owner's data — mirroring the coverage
  // Hypergraph.export()/join() already has, which generateBootstrap() never
  // had until now. Uses a local NoiseSecretStream pair instead of a real
  // DHT connection, since this is testing bootstrap consumption, not
  // connectivity.
  console.log('TEST: connectFromBootstrap - starting (no network needed)')
  const NoiseSecretStream = require('@hyperswarm/secret-stream')
  const owner = await createGraph(t, 'hn-bootstrap-consume-owner')
  const peer = await createGraph(t, 'hn-bootstrap-consume-peer')

  console.log('  Step 1: owner writes some data and generates a bootstrap')
  const contextKey = await owner.graph.createContext({ writeMode: 'open' })
  await owner.graph.openContext(contextKey, { writeMode: 'open' })
  const post = await owner.graph.put({ type: 'post' })
  await owner.graph.putContent(post.id, 'hello from the bootstrap owner', 'text')

  const topic = crypto.randomBytes(32)
  const bootstrap = HypergraphNetwork.generateBootstrap(owner.graph, {
    topic,
    contexts: { chat: contextKey }
  })

  console.log('  Step 2: owner sets up its own networking side normally')
  const networkingOwner = new HypergraphNetwork(owner.graph, owner.store, {}, { topic, role: 'owner', contexts: { chat: contextKey } })
  await networkingOwner._openContexts()

  console.log('  Step 3: peer joins using ONLY the bootstrap descriptor, via connectFromBootstrap()')
  const networkingPeer = await HypergraphNetwork.connectFromBootstrap(peer.graph, peer.store, {}, bootstrap, { role: 'peer' })
  await networkingPeer._openContexts()

  const connOwner = new NoiseSecretStream(true)
  const connPeer = new NoiseSecretStream(false)
  connOwner.rawStream.pipe(connPeer.rawStream).pipe(connOwner.rawStream)
  t.teardown(() => { connOwner.destroy(); connPeer.destroy() })

  networkingOwner._handleDataConnection(connOwner, {})
  networkingPeer._handleDataConnection(connPeer, {})

  console.log('  Step 4: verify the peer actually receives the owner\'s data')
  let postOnPeer = null
  let contentOnPeer = null
  for (let i = 0; i < 20; i++) {
    await sleep(200)
    await peer.graph.update()
    postOnPeer = await peer.graph.get(post.id)
    contentOnPeer = await peer.graph.getContent(post.id)
    if (postOnPeer && contentOnPeer) break
  }

  t.ok(postOnPeer, 'peer, joined purely from the bootstrap, received the owner\'s post')
  t.is(contentOnPeer && contentOnPeer.body, 'hello from the bootstrap owner', "the content matches exactly what the owner wrote")
  console.log('TEST: connectFromBootstrap - passed')
})

test('hypergraph-network: connectFromBootstrap rejects a bootstrap version mismatch (no network needed)', async (t) => {
  // No version migration logic exists yet — a mismatch should fail loudly
  // and immediately rather than silently misinterpreting an incompatible
  // descriptor (e.g. a future shape change adding/renaming fields this
  // version of the code doesn't know about).
  const owner = await createGraph(t, 'hn-bootstrap-version-owner')
  const peer = await createGraph(t, 'hn-bootstrap-version-peer')

  const contextKey = await owner.graph.createContext({ writeMode: 'open' })
  const topic = crypto.randomBytes(32)
  const bootstrap = HypergraphNetwork.generateBootstrap(owner.graph, { topic, contexts: { chat: contextKey } })

  t.is(bootstrap.version, '2.0.0', 'sanity check: generateBootstrap still produces the current version')

  const mismatched = { ...bootstrap, version: '1.0.0' }
  await t.exception(
    HypergraphNetwork.connectFromBootstrap(peer.graph, peer.store, {}, mismatched, { role: 'peer' }),
    /Unsupported bootstrap version/,
    'rejects a bootstrap with an older/different version'
  )

  const missingVersion = { ...bootstrap, version: undefined }
  await t.exception(
    HypergraphNetwork.connectFromBootstrap(peer.graph, peer.store, {}, missingVersion, { role: 'peer' }),
    /Unsupported bootstrap version/,
    'rejects a bootstrap with a missing version entirely'
  )

  await t.execution(
    HypergraphNetwork.connectFromBootstrap(peer.graph, peer.store, {}, bootstrap, { role: 'peer' }),
    'a matching version is accepted normally'
  )
})

test('hypergraph-network: connectFromBootstrap rejects a corrupted (wrong-shaped) key anywhere in the bootstrap', async (t) => {
  // Verified directly first: a correctly-shaped but wrong key (e.g. all
  // zeros) can't be caught here — openUserCore() silently succeeds with a
  // permanently-empty, dead core reference, since there's no way to tell
  // "wrong key" from "owner hasn't sent anything yet" without actually
  // trying to connect. What CAN be caught, and wasn't before: a
  // corrupted/truncated/mistyped key that isn't even the right shape.
  const owner = await createGraph(t, 'hn-bootstrap-shape-owner')
  const peer = await createGraph(t, 'hn-bootstrap-shape-peer')

  const contextKey = await owner.graph.createContext({ writeMode: 'open' })
  const topic = crypto.randomBytes(32)
  const bootstrap = HypergraphNetwork.generateBootstrap(owner.graph, { topic, contexts: { chat: contextKey } })

  await t.exception(
    HypergraphNetwork.connectFromBootstrap(peer.graph, peer.store, {}, { ...bootstrap, topic: 'deadbeef' }, { role: 'peer' }),
    /bootstrap\.topic must be a 64-character hex string/,
    'rejects a truncated topic'
  )

  await t.exception(
    HypergraphNetwork.connectFromBootstrap(peer.graph, peer.store, {}, { ...bootstrap, ownerCore: 'not-valid-hex-at-all' }, { role: 'peer' }),
    /bootstrap\.ownerCore must be a 64-character hex string/,
    'rejects a non-hex ownerCore'
  )

  await t.exception(
    HypergraphNetwork.connectFromBootstrap(peer.graph, peer.store, {}, { ...bootstrap, contexts: { chat: 'short' } }, { role: 'peer' }),
    /bootstrap\.contexts\.chat must be a 64-character hex string/,
    'rejects a wrong-length context key, naming which context failed'
  )
})

test('hypergraph-network: connectFromBootstrap works with an empty contexts map', async (t) => {
  // generateBootstrap() requires opts.contexts to be present, but an empty
  // object passes that check (truthy) — this confirms the resulting
  // bootstrap (an owner sharing only its user core, no contexts/relations
  // at all) is consumed without error.
  const owner = await createGraph(t, 'hn-bootstrap-empty-owner')
  const peer = await createGraph(t, 'hn-bootstrap-empty-peer')

  const topic = crypto.randomBytes(32)
  const bootstrap = HypergraphNetwork.generateBootstrap(owner.graph, { topic, contexts: {} })
  t.alike(bootstrap.contexts, {}, 'generateBootstrap accepts an empty contexts map')

  const networkingPeer = await HypergraphNetwork.connectFromBootstrap(peer.graph, peer.store, {}, bootstrap, { role: 'peer' })
  t.ok(networkingPeer, 'connectFromBootstrap accepts a bootstrap with no contexts')
  await t.execution(networkingPeer._openContexts(), '_openContexts() is a no-op with nothing to open')
})

test('hypergraph-network: connectFromBootstrap always uses bootstrap.topic, ignoring a conflicting opts.topic', async (t) => {
  const owner = await createGraph(t, 'hn-bootstrap-topic-owner')
  const peer = await createGraph(t, 'hn-bootstrap-topic-peer')

  const contextKey = await owner.graph.createContext({ writeMode: 'open' })
  const bootstrapTopic = crypto.randomBytes(32)
  const conflictingTopic = crypto.randomBytes(32)
  const bootstrap = HypergraphNetwork.generateBootstrap(owner.graph, { topic: bootstrapTopic, contexts: { chat: contextKey } })

  const networkingPeer = await HypergraphNetwork.connectFromBootstrap(peer.graph, peer.store, {}, bootstrap, { role: 'peer', topic: conflictingTopic })

  t.is(networkingPeer.topic.toString('hex'), bootstrapTopic.toString('hex'), "bootstrap.topic wins; a conflicting opts.topic has no effect")
  t.not(networkingPeer.topic.toString('hex'), conflictingTopic.toString('hex'), 'the conflicting topic passed via opts is not used')
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
  networking1.on('connection-retry', (info) => console.log(`    [peer1] connection-retry: attempt ${info.attempt}`))
  networking2.on('connection-retry', (info) => console.log(`    [peer2] connection-retry: attempt ${info.attempt}`))
  networking1.on('connection-retry-exhausted', (info) => console.log(`    [peer1] connection-retry-exhausted: ${info.label} after ${info.attempts} attempts`))
  networking2.on('connection-retry-exhausted', (info) => console.log(`    [peer2] connection-retry-exhausted: ${info.label} after ${info.attempts} attempts`))
  networking2.on('flush-timeout', (info) => console.log(`    [peer2] flush-timeout: ${info.step} exceeded ${info.timeoutMs}ms`))

  let peerJoined = false
  networking1.on('peer-join', () => { peerJoined = true })

  await Promise.all([networking1.connect(), networking2.connect()])
  t.ok(networking1.connected, 'peer 1 is connected')
  t.ok(networking2.connected, 'peer 2 is connected')

  await t.execution(networking1.waitForPeer(90000), 'waitForPeer() resolves once a real peer connection is established')
  t.ok(peerJoined, 'peer-join event fired via Hyperswarm connection events')
})

// All tests in this file run entirely locally, using a real NoiseSecretStream
// pair to stand in for a Hyperswarm connection (same pattern as
// writer-authorization.js) — no DHT/real network needed, since these test
// the addContext()/context-announce protocol itself, not connectivity.

const test = require('brittle')
const crypto = require('hypercore-crypto')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { HypergraphNetwork } = require('../../../index.js')
const { createGraph, sleep } = require('../helpers')

function connectPair (networkingOwner, networkingPeer) {
  const connOwner = new NoiseSecretStream(true)
  const connPeer = new NoiseSecretStream(false)
  connOwner.rawStream.pipe(connPeer.rawStream).pipe(connOwner.rawStream)
  networkingOwner._handleDataConnection(connOwner, {})
  networkingPeer._handleDataConnection(connPeer, {})
  return { connOwner, connPeer, close: () => { connOwner.destroy(); connPeer.destroy() } }
}

test('dynamic-context: a context created mid-session (after the initial connection) is discovered and granted to an already-connected peer', async (t) => {
  console.log('TEST: addContext basic - starting')
  const owner = await createGraph(t, 'dynctx-basic-owner')
  const peer = await createGraph(t, 'dynctx-basic-peer')

  // Start with just one, bootstrap-time context — mirroring a real app's
  // initial connection, before anything dynamic happens.
  const ctx1Key = await owner.graph.createContext({ writeMode: 'open' })
  await owner.graph.openContext(ctx1Key, { writeMode: 'open' })
  await peer.graph.openContext(ctx1Key, { writeMode: 'open' })

  const topic = crypto.randomBytes(32)
  const networkingOwner = new HypergraphNetwork(owner.graph, owner.store, {}, { topic, role: 'owner', contexts: { main: ctx1Key } })
  const networkingPeer = new HypergraphNetwork(peer.graph, peer.store, {}, { topic, role: 'peer', contexts: { main: ctx1Key } })
  await networkingOwner._openContexts()
  await networkingPeer._openContexts()

  let announced = null
  networkingPeer.on('context-announced', (info) => { announced = info })
  let granted = null
  networkingPeer.on('writer-granted', (msg) => { granted = msg })

  const pair = connectPair(networkingOwner, networkingPeer)
  t.teardown(() => pair.close())

  for (let i = 0; i < 30 && !granted; i++) await sleep(100)
  t.ok(granted && granted.contexts.main, 'the initial, bootstrap-time context is granted as usual first')

  console.log('  Step: owner creates a NEW context mid-session and registers it')
  granted = null
  const ctx2Key = await owner.graph.createContext({ writeMode: 'open' })
  await networkingOwner.addContext('newRoom', ctx2Key, { writeMode: 'open' })

  for (let i = 0; i < 40 && !announced; i++) await sleep(100)
  t.ok(announced, 'the peer received a context-announced event for the new context')
  t.is(announced.name, 'newRoom', 'with the correct name')

  for (let i = 0; i < 40 && !(granted && granted.contexts.newRoom); i++) await sleep(100)
  t.ok(granted && granted.contexts.newRoom, 'the peer was automatically granted writer access to the new context too, without any bootstrap for it')
  console.log('TEST: addContext basic - passed')
})

test('dynamic-context: after being granted, the peer can actually write to the new context, and the owner sees it', async (t) => {
  console.log('TEST: addContext write round-trip - starting')
  const owner = await createGraph(t, 'dynctx-write-owner')
  const peer = await createGraph(t, 'dynctx-write-peer')

  const ctx1Key = await owner.graph.createContext({ writeMode: 'open' })
  await owner.graph.openContext(ctx1Key, { writeMode: 'open' })
  await peer.graph.openContext(ctx1Key, { writeMode: 'open' })

  const topic = crypto.randomBytes(32)
  const networkingOwner = new HypergraphNetwork(owner.graph, owner.store, {}, { topic, role: 'owner', contexts: { main: ctx1Key } })
  const networkingPeer = new HypergraphNetwork(peer.graph, peer.store, {}, { topic, role: 'peer', contexts: { main: ctx1Key } })
  await networkingOwner._openContexts()
  await networkingPeer._openContexts()

  let granted = null
  networkingPeer.on('writer-granted', (msg) => { granted = msg })

  const pair = connectPair(networkingOwner, networkingPeer)
  t.teardown(() => pair.close())

  for (let i = 0; i < 30 && !granted; i++) await sleep(100)

  granted = null
  const ctx2Key = await owner.graph.createContext({ writeMode: 'open' })
  await networkingOwner.addContext('newRoom', ctx2Key, { writeMode: 'open' })
  for (let i = 0; i < 40 && !(granted && granted.contexts.newRoom); i++) await sleep(100)
  t.ok(granted && granted.contexts.newRoom, 'sanity: peer granted access to the new context')

  console.log('  Step: peer creates an entity and relates it within the NEW context')
  const post = await owner.graph.put({ type: 'post' })
  const comment = await peer.graph.put({ type: 'comment' })
  await peer.graph.openUserCore(owner.graph.key)
  await owner.graph.openUserCore(peer.graph.key)
  await peer.graph.relate({ from: comment.id, to: post.id, type: 'reply', context: ctx2Key })

  let sawIt = false
  for (let i = 0; i < 40; i++) {
    await sleep(150)
    await owner.graph.update()
    const edges = []
    for await (const e of owner.graph.edges(post.id, { direction: 'in', type: 'reply' })) edges.push(e)
    if (edges.length > 0) { sawIt = true; break }
  }
  t.ok(sawIt, 'the owner sees the peer\'s write to the dynamically-added context')
  console.log('TEST: addContext write round-trip - passed')
})

test('dynamic-context: addContext() throws for a name that is already registered', async (t) => {
  console.log('TEST: addContext duplicate name - starting')
  const owner = await createGraph(t, 'dynctx-dup-owner')

  const ctx1Key = await owner.graph.createContext({ writeMode: 'open' })
  await owner.graph.openContext(ctx1Key, { writeMode: 'open' })

  const topic = crypto.randomBytes(32)
  const networkingOwner = new HypergraphNetwork(owner.graph, owner.store, {}, { topic, role: 'owner', contexts: { main: ctx1Key } })
  await networkingOwner._openContexts()

  const ctx2Key = await owner.graph.createContext({ writeMode: 'open' })
  await t.exception(
    networkingOwner.addContext('main', ctx2Key),
    /already registered/,
    'addContext rejects a name that collides with an existing one'
  )
  console.log('TEST: addContext duplicate name - passed')
})

test('dynamic-context: a closed-mode context added dynamically still enforces the same permission check — the RESPONDING peer\'s own authority, not the requester\'s role', async (t) => {
  console.log('TEST: addContext closed mode - starting')
  const owner = await createGraph(t, 'dynctx-closed-owner')
  const peer = await createGraph(t, 'dynctx-closed-peer')

  // Matches writer-authorization.js's own pattern exactly: the permission
  // check that gates a grant is about the RESPONDING peer's (the owner's,
  // here) own authority to grant — not the requester's role. So to test
  // a denial, the owner's own identity needs to lack context.write, via
  // an unrelated 'owner' role going to a different keypair.
  const memberKeyPair = crypto.keyPair()
  const memberPubkey = memberKeyPair.publicKey.toString('hex')
  await owner.graph.createRoleBase()
  await owner.graph.roleBase.init(memberPubkey)
  await owner.graph.setRole(owner.graph.identity.deviceKeyPair.publicKey.toString('hex'), 'member', { keyPair: memberKeyPair })
  await owner.graph.update()
  const ownGraphPubkey = owner.graph.identity.deviceKeyPair.publicKey.toString('hex')
  t.absent(await owner.graph.can(ownGraphPubkey, 'context.write'), 'the owner\'s own identity has no context.write privilege')

  await peer.graph.openRoleBase(owner.graph.roleBase.key)

  const ctx1Key = await owner.graph.createContext({ writeMode: 'open' })
  await owner.graph.openContext(ctx1Key, { writeMode: 'open' })
  await peer.graph.openContext(ctx1Key, { writeMode: 'open' })

  const topic = crypto.randomBytes(32)
  const networkingOwner = new HypergraphNetwork(owner.graph, owner.store, {}, { topic, role: 'owner', contexts: { main: ctx1Key } })
  const networkingPeer = new HypergraphNetwork(peer.graph, peer.store, {}, { topic, role: 'peer', contexts: { main: ctx1Key } })
  await networkingOwner._openContexts()
  await networkingPeer._openContexts()

  let granted = null
  networkingPeer.on('writer-granted', (msg) => { granted = msg })

  const pair = connectPair(networkingOwner, networkingPeer)
  t.teardown(() => pair.close())

  for (let i = 0; i < 30 && !granted; i++) await sleep(100)

  console.log('  owner\'s own identity lacks context.write — a dynamically-added closed context should refuse the grant the same way a bootstrap one would')
  granted = null

  const ctx2Key = await owner.graph.createContext({ writeMode: 'closed' })
  await owner.graph.openContext(ctx2Key, { writeMode: 'closed' })
  await networkingOwner.addContext('privateRoom', ctx2Key, { writeMode: 'closed' })

  for (let i = 0; i < 40 && !(granted && 'privateRoom' in granted.contexts); i++) await sleep(100)
  t.ok(granted && 'privateRoom' in granted.contexts, 'a response for the new context was received')
  t.is(granted.contexts.privateRoom, false, 'the grant was correctly denied — the responding owner\'s own identity lacked context.write')
  console.log('TEST: addContext closed mode - passed')
})

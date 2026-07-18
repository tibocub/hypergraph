// All tests in this file run entirely locally, using a real NoiseSecretStream
// pair to stand in for a Hyperswarm connection (the same pattern used to
// verify the protomux writer-auth channel redesign) — no DHT/real network
// needed, since these are testing the permission-checking logic itself, not
// connectivity.
//
// GAP FOUND & FIXED: HypergraphNetwork._handleWriterRequest() previously had
// no permission checking at all — any connected peer's writer-request was
// granted unconditionally (see the TODO that used to be at this line in
// src/networking.js). ContextBase.addWriter()'s own JSDoc already documented
// the intended design (closed-mode requires the 'context.write' privilege
// from the attached RoleBase) but never actually implemented it. Both are
// now fixed: addWriter() performs the check, and _handleWriterRequest()
// passes this peer's own identity as the author (checking whether the peer
// receiving the request has authority to grant it).

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

test('writer-authorization: closed context grants a writer when the responding peer has context.write', async (t) => {
  console.log('TEST: closed context, authorized responder - starting (no network needed)')
  const owner = await createGraph(t, 'writer-auth-authorized-owner')
  const peer = await createGraph(t, 'writer-auth-authorized-peer')

  const ownerPubkey = owner.graph.identity.deviceKeyPair.publicKey.toString('hex')
  await owner.graph.createRoleBase()
  await owner.graph.roleBase.init(ownerPubkey)
  await owner.graph.update()
  t.ok(await owner.graph.can(ownerPubkey, 'context.write'), 'owner has context.write via the owner role wildcard')

  // The peer's own graph must open the SAME RoleBase — each peer's own
  // apply function evaluates the closed-mode permission check
  // independently, so without this the peer's own side has nothing to
  // check against and would never agree the grant is valid on its own
  // copy of the context, even though the owner's side already does.
  await peer.graph.openRoleBase(owner.graph.roleBase.key)

  const contextKey = await owner.graph.createContext({ writeMode: 'closed' })
  await owner.graph.openContext(contextKey, { writeMode: 'closed' })
  await peer.graph.openContext(contextKey, { writeMode: 'closed' })

  const topic = crypto.randomBytes(32)
  const networkingOwner = new HypergraphNetwork(owner.graph, owner.store, {}, { topic, role: 'owner', contexts: { chat: contextKey } })
  const networkingPeer = new HypergraphNetwork(peer.graph, peer.store, {}, { topic, role: 'peer', contexts: { chat: contextKey } })
  await networkingOwner._openContexts()
  await networkingPeer._openContexts()

  let writerGranted = null
  networkingPeer.on('writer-granted', (msg) => { writerGranted = msg })

  const link = connectPair(networkingOwner, networkingPeer)
  t.teardown(() => link.close())

  let ok = false
  for (let i = 0; i < 20; i++) {
    await sleep(200)
    if (writerGranted) { ok = true; break }
  }

  t.ok(ok, 'peer received a writer-granted response')
  t.is(writerGranted.contexts.chat, true, 'the chat context was actually granted (owner has context.write)')

  const peerCtx = await peer.graph.openContext(contextKey, { writeMode: 'closed' })
  // writer-granted (a control message) and the context actually replicating
  // and applying the underlying roles/addWriter event are separate,
  // asynchronous processes — wait for the latter too, syncing the RoleBase
  // alongside it in case the apply-layer permission check runs before the
  // RoleBase data itself has arrived.
  for (let i = 0; i < 20 && !peerCtx.writable; i++) {
    await sleep(200)
    await peer.graph.roleBase.update()
    await peerCtx.update()
  }
  t.ok(peerCtx.writable, 'peer is actually able to write to the closed context now')
  console.log('TEST: closed context, authorized responder - passed')
})

test('writer-authorization: closed context denies a writer when the responding peer lacks context.write', async (t) => {
  console.log('TEST: closed context, unauthorized responder - starting (no network needed)')
  const owner = await createGraph(t, 'writer-auth-unauthorized-owner')
  const peer = await createGraph(t, 'writer-auth-unauthorized-peer')

  // The peer RECEIVING the writer-request is set up with only 'member'
  // role (no permissions) via its own RoleBase — the point is that THIS
  // peer's own lack of authority should block the grant, regardless of
  // who is asking.
  const memberKeyPair = crypto.keyPair()
  const memberPubkey = memberKeyPair.publicKey.toString('hex')
  await owner.graph.createRoleBase()
  await owner.graph.roleBase.init(memberPubkey) // owner role goes to a DIFFERENT key, not this graph's own identity
  await owner.graph.setRole(owner.graph.identity.deviceKeyPair.publicKey.toString('hex'), 'member', { keyPair: memberKeyPair })
  await owner.graph.update()
  const ownGraphPubkey = owner.graph.identity.deviceKeyPair.publicKey.toString('hex')
  t.absent(await owner.graph.can(ownGraphPubkey, 'context.write'), "the responding peer's own identity has no context.write privilege")

  const contextKey = await owner.graph.createContext({ writeMode: 'closed' })
  await owner.graph.openContext(contextKey, { writeMode: 'closed' })
  await peer.graph.openContext(contextKey, { writeMode: 'closed' })

  const topic = crypto.randomBytes(32)
  const networkingOwner = new HypergraphNetwork(owner.graph, owner.store, {}, { topic, role: 'owner', contexts: { chat: contextKey } })
  const networkingPeer = new HypergraphNetwork(peer.graph, peer.store, {}, { topic, role: 'peer', contexts: { chat: contextKey } })
  await networkingOwner._openContexts()
  await networkingPeer._openContexts()

  let writerGranted = null
  networkingPeer.on('writer-granted', (msg) => { writerGranted = msg })

  const link = connectPair(networkingOwner, networkingPeer)
  t.teardown(() => link.close())

  let ok = false
  for (let i = 0; i < 20; i++) {
    await sleep(200)
    if (writerGranted) { ok = true; break }
  }

  t.ok(ok, 'peer still received a response (the request itself is not an error)')
  t.is(writerGranted.contexts.chat, false, 'the chat context grant was denied (responding peer lacks context.write)')

  const peerCtx = await peer.graph.openContext(contextKey, { writeMode: 'closed' })
  t.absent(peerCtx.writable, 'peer was not actually granted write access')
  console.log('TEST: closed context, unauthorized responder - passed')
})

test('writer-authorization: an unexpected failure produces a writer-error message', async (t) => {
  console.log('TEST: writer-error path - starting (no network needed)')
  const owner = await createGraph(t, 'writer-auth-error-owner')
  const peer = await createGraph(t, 'writer-auth-error-peer')

  const contextKey = await owner.graph.createContext({ writeMode: 'open' })
  await owner.graph.openContext(contextKey, { writeMode: 'open' })
  await peer.graph.openContext(contextKey, { writeMode: 'open' })

  const topic = crypto.randomBytes(32)
  const networkingOwner = new HypergraphNetwork(owner.graph, owner.store, {}, { topic, role: 'owner', contexts: { chat: contextKey } })
  const networkingPeer = new HypergraphNetwork(peer.graph, peer.store, {}, { topic, role: 'peer', contexts: { chat: contextKey } })
  await networkingOwner._openContexts()
  await networkingPeer._openContexts()

  let writerError = null
  networkingOwner.on('writer-error', (msg) => { writerError = msg })

  const link = connectPair(networkingOwner, networkingPeer)
  t.teardown(() => link.close())

  // Force a genuinely unexpected failure: send a writer-request with a
  // malformed userCore key that openUserCore() can't handle, rather than
  // going through the normal _sendWriterRequest() path. Sent from the
  // owner's side of the channel, so networkingPeer processes it (via its
  // own _handleWriterRequest) and the resulting writer-error is sent back
  // over the same channel to the owner.
  await sleep(300)
  const rawMsg = { type: 'writer-request', userCore: 'not-valid-hex-!!', contexts: { chat: peer.graph.key.toString('hex') } }
  networkingOwner._sendControlMessage(link.connOwner, 'writerRequestMsg', rawMsg)

  let ok = false
  for (let i = 0; i < 20; i++) {
    await sleep(200)
    if (writerError) { ok = true; break }
  }

  t.ok(ok, 'peer received a writer-error response for the malformed request')
  t.ok(writerError.message, 'the writer-error message includes a description of what failed')
  console.log('TEST: writer-error path - passed')
})

test('writer-authorization: 3 peers all get writer-granted for a shared context (star topology via owner)', async (t) => {
  // Addresses gap #4: all prior writer-authorization tests use exactly 2
  // peers. This connects owner-peer1 and owner-peer2 (owner is the hub;
  // peer1 and peer2 are not directly connected to each other), verifying
  // the writer-auth handshake works correctly for multiple simultaneous
  // peer connections on the same HypergraphNetwork instance, not just one.
  console.log('TEST: 3-peer writer authorization - starting (no network needed)')
  const owner = await createGraph(t, 'writer-auth-multi-owner')
  const peer1 = await createGraph(t, 'writer-auth-multi-peer1')
  const peer2 = await createGraph(t, 'writer-auth-multi-peer2')

  const contextKey = await owner.graph.createContext({ writeMode: 'open' })
  await owner.graph.openContext(contextKey, { writeMode: 'open' })
  await peer1.graph.openContext(contextKey, { writeMode: 'open' })
  await peer2.graph.openContext(contextKey, { writeMode: 'open' })

  const topic = crypto.randomBytes(32)
  const networkingOwner = new HypergraphNetwork(owner.graph, owner.store, {}, { topic, role: 'owner', contexts: { chat: contextKey } })
  const networkingPeer1 = new HypergraphNetwork(peer1.graph, peer1.store, {}, { topic, role: 'peer', contexts: { chat: contextKey } })
  const networkingPeer2 = new HypergraphNetwork(peer2.graph, peer2.store, {}, { topic, role: 'peer', contexts: { chat: contextKey } })
  await networkingOwner._openContexts()
  await networkingPeer1._openContexts()
  await networkingPeer2._openContexts()

  let granted1 = null
  let granted2 = null
  networkingPeer1.on('writer-granted', (msg) => { granted1 = msg })
  networkingPeer2.on('writer-granted', (msg) => { granted2 = msg })

  const link1 = connectPair(networkingOwner, networkingPeer1)
  const link2 = connectPair(networkingOwner, networkingPeer2)
  t.teardown(() => { link1.close(); link2.close() })

  let ok = false
  for (let i = 0; i < 20; i++) {
    await sleep(200)
    if (granted1 && granted2) { ok = true; break }
  }

  t.ok(ok, 'both peer1 and peer2 received writer-granted responses')
  t.is(granted1.contexts.chat, true, 'peer1 was granted write access')
  t.is(granted2.contexts.chat, true, 'peer2 was granted write access')

  const ctx1 = await peer1.graph.openContext(contextKey, { writeMode: 'open' })
  const ctx2 = await peer2.graph.openContext(contextKey, { writeMode: 'open' })
  t.ok(ctx1.writable, 'peer1 is actually able to write to the context')
  t.ok(ctx2.writable, 'peer2 is actually able to write to the context')
  console.log('TEST: 3-peer writer authorization - passed')
})

test('writer-authorization: writer-grant handshake repeats correctly after a disconnect/reconnect cycle', async (t) => {
  // Addresses gap #5: verifies that (a) the writer-auth handshake fires
  // again automatically on a fresh connection after a disconnect (since
  // channel wiring is entirely event-driven per-connection, not a one-time
  // setup — see _handleDataConnection), and (b) write access, once
  // granted, persists across the disconnect (it's a permanent Autobase-
  // level grant, not tied to any specific connection).
  console.log('TEST: writer-grant repeats after reconnect - starting (no network needed)')
  const owner = await createGraph(t, 'writer-auth-reconnect-owner')
  const peer = await createGraph(t, 'writer-auth-reconnect-peer')

  const contextKey = await owner.graph.createContext({ writeMode: 'open' })
  await owner.graph.openContext(contextKey, { writeMode: 'open' })
  await peer.graph.openContext(contextKey, { writeMode: 'open' })

  const topic = crypto.randomBytes(32)
  const networkingOwner = new HypergraphNetwork(owner.graph, owner.store, {}, { topic, role: 'owner', contexts: { chat: contextKey } })
  const networkingPeer = new HypergraphNetwork(peer.graph, peer.store, {}, { topic, role: 'peer', contexts: { chat: contextKey } })
  await networkingOwner._openContexts()
  await networkingPeer._openContexts()

  let grantCount = 0
  let lastGrant = null
  networkingPeer.on('writer-granted', (msg) => { grantCount++; lastGrant = msg })

  console.log('  Step 1: initial connection, wait for the first writer-granted')
  const link1 = connectPair(networkingOwner, networkingPeer)
  let ok1 = false
  for (let i = 0; i < 20; i++) {
    await sleep(200)
    if (grantCount >= 1) { ok1 = true; break }
  }
  t.ok(ok1, 'peer received the first writer-granted')

  const ctxBeforeDisconnect = await peer.graph.openContext(contextKey, { writeMode: 'open' })
  t.ok(ctxBeforeDisconnect.writable, 'peer is writable after the first grant')

  console.log('  Step 2: disconnect (simulated — destroy the connection directly)')
  link1.close()
  await sleep(300)

  console.log('  Step 3: reconnect with a fresh connection pair')
  const link2 = connectPair(networkingOwner, networkingPeer)
  t.teardown(() => link2.close())

  let ok2 = false
  for (let i = 0; i < 20; i++) {
    await sleep(200)
    if (grantCount >= 2) { ok2 = true; break }
  }

  t.ok(ok2, 'the writer-auth handshake repeated on the fresh connection after reconnecting')
  t.is(lastGrant.contexts.chat, true, 'the repeated grant still succeeds (already a writer, addWriter() is idempotent)')

  const ctxAfterReconnect = await peer.graph.openContext(contextKey, { writeMode: 'open' })
  t.ok(ctxAfterReconnect.writable, 'peer write access persisted across the disconnect/reconnect cycle')
  console.log('TEST: writer-grant repeats after reconnect - passed')
})

test('writer-authorization: a single request can grant some contexts while denying others', async (t) => {
  // Addresses the remaining gap: every other test in this file requests
  // exactly one context, which can't distinguish "grants are evaluated
  // per-context" from "grants are all-or-nothing for the whole request".
  // This sends ONE writer-request spanning two contexts with different
  // writeModes — 'open' (always granted, no permission needed) and
  // 'closed' (requires context.write, which the responder here lacks) —
  // and verifies the response and actual writability differ per-context
  // within that single request, exercising the per-context error isolation
  // in _handleWriterRequest's loop (a denial for one context must not
  // block a grant for another in the same request).
  console.log('TEST: selective per-context authorization - starting (no network needed)')
  const owner = await createGraph(t, 'writer-auth-selective-owner')
  const peer = await createGraph(t, 'writer-auth-selective-peer')

  const ownGraphPubkey = owner.graph.identity.deviceKeyPair.publicKey.toString('hex')
  const someoneElseKeyPair = crypto.keyPair()
  await owner.graph.createRoleBase()
  // Owner role goes to a key other than this graph's own identity, so the
  // responding peer (owner.graph itself) ends up with no privileges of its
  // own — matching the "unauthorized responder" test's approach.
  await owner.graph.roleBase.init(someoneElseKeyPair.publicKey.toString('hex'))
  await owner.graph.setRole(ownGraphPubkey, 'member', { keyPair: someoneElseKeyPair })
  await owner.graph.update()
  t.absent(await owner.graph.can(ownGraphPubkey, 'context.write'), 'responding peer has no context.write privilege')

  const openContextKey = await owner.graph.createContext({ writeMode: 'open' })
  const closedContextKey = await owner.graph.createContext({ writeMode: 'closed' })
  await owner.graph.openContext(openContextKey, { writeMode: 'open' })
  await owner.graph.openContext(closedContextKey, { writeMode: 'closed' })
  await peer.graph.openContext(openContextKey, { writeMode: 'open' })
  await peer.graph.openContext(closedContextKey, { writeMode: 'closed' })

  const topic = crypto.randomBytes(32)
  const contexts = { openCtx: openContextKey, closedCtx: closedContextKey }
  const networkingOwner = new HypergraphNetwork(owner.graph, owner.store, {}, { topic, role: 'owner', contexts })
  const networkingPeer = new HypergraphNetwork(peer.graph, peer.store, {}, { topic, role: 'peer', contexts })
  await networkingOwner._openContexts()
  await networkingPeer._openContexts()

  let granted = null
  networkingPeer.on('writer-granted', (msg) => { granted = msg })

  const link = connectPair(networkingOwner, networkingPeer)
  t.teardown(() => link.close())

  let ok = false
  for (let i = 0; i < 20; i++) {
    await sleep(200)
    if (granted) { ok = true; break }
  }

  t.ok(ok, 'peer received a single writer-granted response covering both contexts')
  t.is(granted.contexts.openCtx, true, 'the open context is granted (no permission required)')
  t.is(granted.contexts.closedCtx, false, 'the closed context is denied (responder lacks context.write) in the SAME request')

  const openCtx = await peer.graph.openContext(openContextKey, { writeMode: 'open' })
  const closedCtx = await peer.graph.openContext(closedContextKey, { writeMode: 'closed' })
  t.ok(openCtx.writable, 'peer can actually write to the open context')
  t.absent(closedCtx.writable, 'peer cannot actually write to the closed context')
  console.log('TEST: selective per-context authorization - passed')
})

test('writer-authorization: emits writer-request-timeout if the owner never responds', async (t) => {
  // Addresses the gap: previously, if the channel opened but the owner
  // never responded (offline, a bug, a lost message), the peer had no way
  // to detect it and would wait indefinitely. Simulates "receives but never
  // responds" by overriding _handleWriterRequest on the owner instance
  // with a no-op, rather than simulating "never connects" (which wouldn't
  // exercise this at all, since the timeout only starts once the channel
  // actually opens and the request is actually sent).
  console.log('TEST: writer-request-timeout - starting (no network needed)')
  const owner = await createGraph(t, 'writer-auth-timeout-owner')
  const peer = await createGraph(t, 'writer-auth-timeout-peer')

  const contextKey = await owner.graph.createContext({ writeMode: 'open' })
  await owner.graph.openContext(contextKey, { writeMode: 'open' })
  await peer.graph.openContext(contextKey, { writeMode: 'open' })

  const topic = crypto.randomBytes(32)
  const networkingOwner = new HypergraphNetwork(owner.graph, owner.store, {}, { topic, role: 'owner', contexts: { chat: contextKey } })
  // Short timeout for a fast test; the default (30000ms) is for production use.
  const networkingPeer = new HypergraphNetwork(peer.graph, peer.store, {}, { topic, role: 'peer', contexts: { chat: contextKey }, writerRequestTimeoutMs: 500 })
  await networkingOwner._openContexts()
  await networkingPeer._openContexts()

  // Simulate a hung/buggy owner: the channel opens and the request
  // arrives, but nothing is ever sent back.
  networkingOwner._handleWriterRequest = async () => {}

  let timeoutInfo = null
  let granted = false
  networkingPeer.on('writer-request-timeout', (info) => { timeoutInfo = info })
  networkingPeer.on('writer-granted', () => { granted = true })

  const link = connectPair(networkingOwner, networkingPeer)
  t.teardown(() => link.close())

  let ok = false
  for (let i = 0; i < 20; i++) {
    await sleep(100)
    if (timeoutInfo) { ok = true; break }
  }

  t.ok(ok, 'writer-request-timeout fired since the owner never responded')
  t.is(timeoutInfo.timeoutMs, 500, 'the event reports the configured timeout duration')
  t.absent(granted, 'writer-granted never fired, confirming this is genuinely a non-response, not a slow response')
  console.log('TEST: writer-request-timeout - passed')
})

test('writer-authorization: waitForWriterGrant() resolves on a real grant and rejects on timeout', async (t) => {
  console.log('TEST: waitForWriterGrant - starting (no network needed)')

  console.log('  Case 1: resolves when a real grant arrives')
  {
    const owner = await createGraph(t, 'writer-auth-waitfor-ok-owner')
    const peer = await createGraph(t, 'writer-auth-waitfor-ok-peer')
    const contextKey = await owner.graph.createContext({ writeMode: 'open' })
    await owner.graph.openContext(contextKey, { writeMode: 'open' })
    await peer.graph.openContext(contextKey, { writeMode: 'open' })

    const topic = crypto.randomBytes(32)
    const networkingOwner = new HypergraphNetwork(owner.graph, owner.store, {}, { topic, role: 'owner', contexts: { chat: contextKey } })
    const networkingPeer = new HypergraphNetwork(peer.graph, peer.store, {}, { topic, role: 'peer', contexts: { chat: contextKey } })
    await networkingOwner._openContexts()
    await networkingPeer._openContexts()

    const link = connectPair(networkingOwner, networkingPeer)
    t.teardown(() => link.close())

    await t.execution(networkingPeer.waitForWriterGrant(5000), 'waitForWriterGrant() resolves once a real writer-granted arrives')
  }

  console.log('  Case 2: rejects when nothing ever arrives')
  {
    const owner = await createGraph(t, 'writer-auth-waitfor-fail-owner')
    const peer = await createGraph(t, 'writer-auth-waitfor-fail-peer')
    const contextKey = await owner.graph.createContext({ writeMode: 'open' })
    await owner.graph.openContext(contextKey, { writeMode: 'open' })
    await peer.graph.openContext(contextKey, { writeMode: 'open' })

    const topic = crypto.randomBytes(32)
    const networkingOwner = new HypergraphNetwork(owner.graph, owner.store, {}, { topic, role: 'owner', contexts: { chat: contextKey } })
    const networkingPeer = new HypergraphNetwork(peer.graph, peer.store, {}, { topic, role: 'peer', contexts: { chat: contextKey } })
    await networkingOwner._openContexts()
    await networkingPeer._openContexts()
    networkingOwner._handleWriterRequest = async () => {}

    const link = connectPair(networkingOwner, networkingPeer)
    t.teardown(() => link.close())

    let rejected = false
    try {
      await networkingPeer.waitForWriterGrant(500)
    } catch (err) {
      rejected = true
    }
    t.ok(rejected, 'waitForWriterGrant() rejects if nothing arrives within the timeout')
  }
  console.log('TEST: waitForWriterGrant - passed')
})

test('writer-authorization: autoReplicate:false actually skips Corestore replication', async (t) => {
  // The option existed but was never verified to actually do anything.
  // Also confirms autoReplicate only affects store.replicate(conn) — the
  // writer-auth channel is wired unconditionally in _handleDataConnection,
  // so the handshake should still work normally even with replication
  // disabled.
  console.log('TEST: autoReplicate:false - starting (no network needed)')
  const owner = await createGraph(t, 'writer-auth-noreplicate-owner')
  const peer = await createGraph(t, 'writer-auth-noreplicate-peer')

  const contextKey = await owner.graph.createContext({ writeMode: 'open' })
  await owner.graph.openContext(contextKey, { writeMode: 'open' })
  await peer.graph.openContext(contextKey, { writeMode: 'open' })
  const ownerUserCoreOnPeer = await peer.graph.openUserCore(owner.graph.key)

  const msg = await owner.graph.put({ type: 'message' })
  await owner.graph.putContent(msg.id, 'should never arrive', 'text')

  const topic = crypto.randomBytes(32)
  const networkingOwner = new HypergraphNetwork(owner.graph, owner.store, {}, { topic, role: 'owner', contexts: { chat: contextKey }, autoReplicate: false })
  const networkingPeer = new HypergraphNetwork(peer.graph, peer.store, {}, { topic, role: 'peer', contexts: { chat: contextKey }, autoReplicate: false })
  await networkingOwner._openContexts()
  await networkingPeer._openContexts()

  let granted = false
  networkingPeer.on('writer-granted', () => { granted = true })

  const link = connectPair(networkingOwner, networkingPeer)
  t.teardown(() => link.close())

  let grantOk = false
  for (let i = 0; i < 15; i++) {
    await sleep(200)
    if (granted) { grantOk = true; break }
  }
  t.ok(grantOk, 'writer-auth channel still works normally with autoReplicate:false (it is unaffected by this option)')

  // Give replication every chance it would normally have to happen, then
  // confirm it genuinely did not.
  for (let i = 0; i < 10; i++) {
    await sleep(200)
    await ownerUserCoreOnPeer.update({ wait: false })
  }
  t.is(ownerUserCoreOnPeer.length, 0, "peer's reference to the owner's user core never advanced — no replication happened at all")
  const msgOnPeer = await peer.graph.get(msg.id)
  t.absent(msgOnPeer, "the owner's message never reached the peer, confirming autoReplicate:false actually skips replication")
  console.log('TEST: autoReplicate:false - passed')
})

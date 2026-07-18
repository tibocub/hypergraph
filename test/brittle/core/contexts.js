const test = require('brittle')
const crypto = require('hypercore-crypto')
const { createGraph, sleep } = require('../helpers')

function replicatePair (peerA, peerB) {
  const s1 = peerA.store.replicate(true, { live: true })
  const s2 = peerB.store.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)

  return {
    close: async () => {
      try { s1.destroy() } catch (err) { /* already closed */ }
      try { s2.destroy() } catch (err) { /* already closed */ }
    }
  }
}

function signTagEvent (event, keyPair) {
  const payload = { entityId: event.entityId, tag: event.tag }
  const msg = { op: event.type, payload, author: event.author, timestamp: event.timestamp }
  const digest = require('crypto').createHash('sha256').update(JSON.stringify(msg)).digest()
  return crypto.sign(digest, keyPair.secretKey).toString('hex')
}

async function pumpUntil (fn, timeoutMs = 20000, intervalMs = 50) {
  const start = Date.now()
  let lastErr = null
  for (;;) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
    }
    if (Date.now() - start > timeoutMs) {
      const e = new Error('Timeout waiting for condition')
      e.cause = lastErr
      throw e
    }
    await sleep(intervalMs)
  }
}

test('contexts: createContext returns a key and openContext returns the same instance', async (t) => {
  console.log('TEST: createContext/openContext - starting')
  const { graph } = await createGraph(t, 'contexts-create-open')

  const contextKey = await graph.createContext()
  t.ok(contextKey, 'createContext returns a key')

  const context = await graph.openContext(contextKey)
  t.ok(context, 'openContext returns a ContextBase instance')
  t.is(context.key.toString('hex'), contextKey, 'opened context key matches created key')
  console.log('TEST: createContext/openContext - passed')
})

test('contexts: default write mode allows the creator to write immediately', async (t) => {
  console.log('TEST: default write mode - starting')
  const { graph } = await createGraph(t, 'contexts-default-writemode')

  const contextKey = await graph.createContext()
  const post = await graph.put({ type: 'post' })
  await t.execution(
    graph.relate({ from: 'comment/1', to: post.id, type: 'reply', context: contextKey }),
    'creator can write into a freshly created context'
  )
  console.log('TEST: default write mode - passed')
})

test('contexts: open write mode auto-authorizes a peer added as a writer', async (t) => {
  console.log('TEST: writeMode open (auto writers) - starting')
  const a = await createGraph(t, 'contexts-write-open-a')
  const b = await createGraph(t, 'contexts-write-open-b')

  console.log('  Step 1: replicate the corestores locally (no swarm/DHT needed)')
  const repl = replicatePair(a, b)
  t.teardown(async () => repl.close())

  console.log('  Step 2: create an open-mode context and add peer B as a writer')
  const ctxKey = await a.graph.createContext()
  const aCtx = await a.graph.openContext(ctxKey)
  const bCtx = await b.graph.openContext(ctxKey)

  await aCtx.addWriter(bCtx.localKey)

  console.log('  Step 3: wait for peer B to become writable')
  await pumpUntil(async () => {
    await b.graph.update()
    if (!bCtx.writable) throw new Error('peer not writable yet')
  }, 20000)
  t.ok(bCtx.writable, 'peer B became writable after being added')

  console.log('  Step 4: both peers append tag events signed with their own device key')
  const aKeyPair = a.graph.identity.deviceKeyPair
  const aTagEvent = {
    type: 'tag/add',
    entityId: 'post/a',
    tag: 'a',
    author: a.graph.key.toString('hex'),
    timestamp: Date.now()
  }
  aTagEvent.signature = signTagEvent(aTagEvent, aKeyPair)
  await aCtx.append(aTagEvent)

  const bKeyPair = b.graph.identity.deviceKeyPair
  const bTagEvent = {
    type: 'tag/add',
    entityId: 'post/b',
    tag: 'b',
    author: b.graph.key.toString('hex'),
    timestamp: Date.now()
  }
  bTagEvent.signature = signTagEvent(bTagEvent, bKeyPair)
  await bCtx.append(bTagEvent)

  console.log('  Step 5: verify both events converge on peer A')
  const aAuthor = a.graph.key.toString('hex')
  const bAuthor = b.graph.key.toString('hex')
  await pumpUntil(async () => {
    await a.graph.update()
    const a1 = await aCtx.get(`tref:a:post/a:${aAuthor}`)
    const b1 = await aCtx.get(`tref:b:post/b:${bAuthor}`)
    if (!a1) throw new Error('missing a tag')
    if (!b1) throw new Error('missing b tag')
  }, 20000)
  t.pass('both writers converged on peer A')
  console.log('TEST: writeMode open (auto writers) - passed')
})

test('contexts: closed write mode authorizes a role-approved writer', async (t) => {
  console.log('TEST: closed mode authorized writer - starting')
  const { graph } = await createGraph(t, 'contexts-closed-authorized')

  const ownerKeyPair = crypto.keyPair()
  const ownerPubkey = ownerKeyPair.publicKey.toString('hex')
  const adminKeyPair = crypto.keyPair()
  const adminPubkey = adminKeyPair.publicKey.toString('hex')

  console.log('  Step 1: set up roles — owner, and an admin (has context.write by default)')
  await graph.createRoleBase()
  await graph.roleBase.init(ownerPubkey)
  await graph.setRole(adminPubkey, 'admin', { keyPair: ownerKeyPair })
  await graph.update()
  t.ok(await graph.can(adminPubkey, 'context.write'), 'admin role has context.write by default')

  console.log('  Step 2: create a closed context and add a writer as the admin')
  const contextKey = await graph.createContext({ writeMode: 'closed' })
  const context = await graph.openContext(contextKey, { writeMode: 'closed' })
  const newWriterKey = crypto.keyPair().publicKey.toString('hex')

  await t.execution(
    context.addWriter(newWriterKey, { keyPair: adminKeyPair }),
    'admin (context.write privilege) can add a writer to a closed context'
  )
  console.log('TEST: closed mode authorized writer - passed')
})

test('contexts: closed write mode rejects an unauthorized writer', async (t) => {
  console.log('TEST: closed mode unauthorized writer - starting')
  const { graph } = await createGraph(t, 'contexts-closed-unauthorized')

  const ownerKeyPair = crypto.keyPair()
  const ownerPubkey = ownerKeyPair.publicKey.toString('hex')
  const memberKeyPair = crypto.keyPair()
  const memberPubkey = memberKeyPair.publicKey.toString('hex')

  console.log('  Step 1: set up roles — owner, and a plain member (no permissions by default)')
  await graph.createRoleBase()
  await graph.roleBase.init(ownerPubkey)
  await graph.setRole(memberPubkey, 'member', { keyPair: ownerKeyPair })
  await graph.update()
  t.absent(await graph.can(memberPubkey, 'context.write'), 'member role does not have context.write')

  console.log('  Step 2: create a closed context and attempt to add a writer as the unauthorized member')
  const contextKey = await graph.createContext({ writeMode: 'closed' })
  const context = await graph.openContext(contextKey, { writeMode: 'closed' })
  const newWriterKey = crypto.keyPair().publicKey.toString('hex')

  await t.exception(
    context.addWriter(newWriterKey, { keyPair: memberKeyPair }),
    /Not authorized/,
    'member (no context.write privilege) cannot add a writer to a closed context'
  )

  console.log('  Step 3: also reject when opts.keyPair is missing entirely')
  await t.exception(
    context.addWriter(newWriterKey, {}),
    /opts.keyPair.*is required/,
    'closed mode requires opts.keyPair to be provided at all'
  )
  console.log('TEST: closed mode unauthorized writer - passed')
})

test('contexts: a legitimate but unprivileged writer cannot bypass addWriter() via the generic append() method', async (t) => {
  // SECURITY REGRESSION TEST — do not remove without re-verifying this
  // scenario by hand first.
  //
  // append() is a generic method with no per-event-type validation at all
  // (confirmed by reading its implementation: it only branches on
  // writeMode for the optimistic-append option, nothing else). This means
  // a caller could construct a { type: 'roles/addWriter', key } event
  // directly and append it, completely bypassing addWriter()'s permission
  // check. The apply layer that processes this event now independently
  // verifies both the signature and the context.write permission (see
  // context-base.js), which is what actually closes this gap — not just
  // an unexplained Autobase-internal behavior as an earlier investigation
  // of this scenario had to rely on before this fix.
  console.log('TEST: append() bypass security regression - starting')
  const owner = await createGraph(t, 'contexts-bypass-owner')
  const attacker = await createGraph(t, 'contexts-bypass-attacker')

  const ownerPubkey = owner.graph.identity.deviceKeyPair.publicKey.toString('hex')
  const attackerAppPubkey = attacker.graph.identity.deviceKeyPair.publicKey.toString('hex')

  await owner.graph.createRoleBase()
  await owner.graph.roleBase.init(ownerPubkey)
  await owner.graph.setRole(attackerAppPubkey, 'member', { keyPair: owner.graph.identity.deviceKeyPair })
  await owner.graph.update()
  t.absent(await owner.graph.can(attackerAppPubkey, 'context.write'), 'attacker has no context.write privilege')

  // The attacker's own graph must open the SAME RoleBase — Autobase's
  // apply function runs independently and deterministically on every
  // peer, so without this, the attacker's own side has nothing to check
  // permissions against and would never agree the grant is valid either.
  await attacker.graph.openRoleBase(owner.graph.roleBase.key)

  const s1 = owner.store.replicate(true, { live: true })
  const s2 = attacker.store.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)
  t.teardown(async () => { try { s1.destroy() } catch {}; try { s2.destroy() } catch {} })

  // Fully sync the RoleBase data BEFORE any context/writer-change events
  // exist. A peer's context apply function only evaluates each
  // writer-change event once, at the point it first arrives — if the
  // RoleBase hasn't synced by then the event is queued (not lost), but
  // ensuring the RoleBase syncs first avoids depending on that at all.
  for (let i = 0; i < 20 && !(await attacker.graph.roleBase.getRegistry()); i++) {
    await sleep(200)
    await attacker.graph.roleBase.update()
  }
  t.absent(await attacker.graph.can(attackerAppPubkey, 'context.write'), "attacker's RoleBase view is synced and confirms no context.write privilege")

  const contextKey = await owner.graph.createContext({ writeMode: 'closed' })
  const ownerCtx = await owner.graph.openContext(contextKey, { writeMode: 'closed' })
  const attackerCtx = await attacker.graph.openContext(contextKey, { writeMode: 'closed' })

  // Owner legitimately makes the attacker a real writer (a normal,
  // low-privilege contributor) via the properly-authorized path.
  await ownerCtx.addWriter(attackerCtx.localKey, { keyPair: owner.graph.identity.deviceKeyPair })

  for (let i = 0; i < 20 && !attackerCtx.writable; i++) {
    await sleep(200)
    await attackerCtx.update()
  }
  t.ok(attackerCtx.writable, 'attacker is confirmed to be a real, writable writer before attempting the bypass')

  const victimKey = crypto.keyPair().publicKey.toString('hex')
  await attackerCtx.append({ type: 'roles/addWriter', key: victimKey })

  for (let i = 0; i < 20; i++) {
    await sleep(200)
    await ownerCtx.update()
  }

  t.absent(ownerCtx.writerKeys().includes(victimKey), 'the victim key did NOT become a writer despite the attacker bypassing addWriter() via append()')
  console.log('TEST: append() bypass security regression - passed')
})

test('contexts: removeWriter in open mode is unrestricted, no keyPair needed', async (t) => {
  console.log('TEST: removeWriter open mode - starting')
  const owner = await createGraph(t, 'contexts-remove-open-owner')
  const peer = await createGraph(t, 'contexts-remove-open-peer')
  const contextKey = await owner.graph.createContext({ writeMode: 'open' })
  const ownerCtx = await owner.graph.openContext(contextKey, { writeMode: 'open' })
  const peerCtx = await peer.graph.openContext(contextKey, { writeMode: 'open' })

  const s1 = owner.store.replicate(true, { live: true })
  const s2 = peer.store.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)
  t.teardown(async () => { try { s1.destroy() } catch {}; try { s2.destroy() } catch {} })

  await ownerCtx.addWriter(peerCtx.localKey)
  for (let i = 0; i < 20 && !peerCtx.writable; i++) {
    await sleep(200)
    await peerCtx.update()
  }
  t.ok(peerCtx.writable, 'peer was added as a writer')

  await ownerCtx.removeWriter(peerCtx.localKey)
  for (let i = 0; i < 20 && peerCtx.writable; i++) {
    await sleep(200)
    await peerCtx.update()
  }
  t.absent(peerCtx.writable, 'peer was removed as a writer, no keyPair needed in open mode')
  await sleep(300) // let Autobase's internal drain settle before teardown closes the stores
  console.log('TEST: removeWriter open mode - passed')
})

test('contexts: removeWriter in closed mode — admin (context.write) can remove a writer', async (t) => {
  console.log('TEST: removeWriter closed mode authorized - starting')
  const owner = await createGraph(t, 'contexts-remove-closed-authorized-owner')
  const peer = await createGraph(t, 'contexts-remove-closed-authorized-peer')
  const ownerKeyPair = owner.graph.identity.deviceKeyPair
  const ownerPubkey = ownerKeyPair.publicKey.toString('hex')

  await owner.graph.createRoleBase()
  await owner.graph.roleBase.init(ownerPubkey)
  await owner.graph.update()
  await peer.graph.openRoleBase(owner.graph.roleBase.key)

  const contextKey = await owner.graph.createContext({ writeMode: 'closed' })
  const ownerCtx = await owner.graph.openContext(contextKey, { writeMode: 'closed' })
  const peerCtx = await peer.graph.openContext(contextKey, { writeMode: 'closed' })

  const s1 = owner.store.replicate(true, { live: true })
  const s2 = peer.store.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)
  t.teardown(async () => { try { s1.destroy() } catch {}; try { s2.destroy() } catch {} })

  await ownerCtx.addWriter(peerCtx.localKey, { keyPair: ownerKeyPair })
  for (let i = 0; i < 20 && !peerCtx.writable; i++) {
    await sleep(200)
    await peer.graph.roleBase.update()
    await peerCtx.update()
  }
  t.ok(peerCtx.writable, 'peer was added by the owner (who has context.write via the owner role)')

  await t.execution(
    ownerCtx.removeWriter(peerCtx.localKey, { keyPair: ownerKeyPair }),
    'owner (context.write privilege) can remove a writer from a closed context'
  )
  for (let i = 0; i < 20 && peerCtx.writable; i++) {
    await sleep(200)
    await peerCtx.update()
  }
  t.absent(peerCtx.writable, 'peer was actually removed')
  await sleep(300)
  console.log('TEST: removeWriter closed mode authorized - passed')
})

test('contexts: removeWriter in closed mode — member (no context.write) cannot remove a writer', async (t) => {
  console.log('TEST: removeWriter closed mode unauthorized - starting')
  const owner = await createGraph(t, 'contexts-remove-closed-unauthorized-owner')
  const peer = await createGraph(t, 'contexts-remove-closed-unauthorized-peer')
  const ownerKeyPair = owner.graph.identity.deviceKeyPair
  const ownerPubkey = ownerKeyPair.publicKey.toString('hex')
  const memberKeyPair = crypto.keyPair()
  const memberPubkey = memberKeyPair.publicKey.toString('hex')

  await owner.graph.createRoleBase()
  await owner.graph.roleBase.init(ownerPubkey)
  await owner.graph.setRole(memberPubkey, 'member', { keyPair: ownerKeyPair })
  await owner.graph.update()
  await peer.graph.openRoleBase(owner.graph.roleBase.key)

  const contextKey = await owner.graph.createContext({ writeMode: 'closed' })
  const ownerCtx = await owner.graph.openContext(contextKey, { writeMode: 'closed' })
  const peerCtx = await peer.graph.openContext(contextKey, { writeMode: 'closed' })

  const s1 = owner.store.replicate(true, { live: true })
  const s2 = peer.store.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)
  t.teardown(async () => { try { s1.destroy() } catch {}; try { s2.destroy() } catch {} })

  await ownerCtx.addWriter(peerCtx.localKey, { keyPair: ownerKeyPair })
  for (let i = 0; i < 20 && !peerCtx.writable; i++) {
    await sleep(200)
    await peer.graph.roleBase.update()
    await peerCtx.update()
  }
  t.ok(peerCtx.writable, 'peer was added by the owner')

  await t.exception(
    ownerCtx.removeWriter(peerCtx.localKey, { keyPair: memberKeyPair }),
    /Not authorized/,
    'member (no context.write privilege) cannot remove a writer from a closed context'
  )
  t.ok(peerCtx.writable, 'peer was NOT actually removed')
  await sleep(300)
  console.log('TEST: removeWriter closed mode unauthorized - passed')
})

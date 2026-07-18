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
    context.addWriter(newWriterKey, { author: adminPubkey }),
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
    context.addWriter(newWriterKey, { author: memberPubkey }),
    /Not authorized/,
    'member (no context.write privilege) cannot add a writer to a closed context'
  )

  console.log('  Step 3: also reject when opts.author is missing entirely')
  await t.exception(
    context.addWriter(newWriterKey, {}),
    /opts.author is required/,
    'closed mode requires opts.author to be provided at all'
  )
  console.log('TEST: closed mode unauthorized writer - passed')
})

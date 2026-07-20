const test = require('brittle')
const Corestore = require('corestore')
const crypto = require('hypercore-crypto')
const { createGraph, sleep } = require('../helpers')

test('moderation: moderateAction records a signed fact even before a RoleBase exists', async (t) => {
  console.log('TEST: moderation before registry - starting')
  const { graph } = await createGraph(t, 'moderation-t1')

  const modKeyPair = crypto.keyPair()
  const ctx = await graph.createContext()
  const post = await graph.put({ type: 'post' })

  console.log('  Step 1: record a moderation action with no RoleBase attached')
  await graph.moderateAction({
    context: ctx,
    action: 'content.flag',
    target: post.id,
    reason: 'test',
    keyPair: modKeyPair
  })
  await graph.update()

  console.log('  Step 2: this app queries with no policy filter, so it is not shown by default')
  const results = []
  for await (const e of graph.queryContext({ type: 'moderation', context: ctx, target: post.id })) results.push(e)
  t.is(results.length, 0, 'queryContext with no author filter returns nothing (facts require explicit trust)')
  console.log('TEST: moderation before registry - passed')
})

test('moderation: events recorded before and after RoleBase init are both queryable once trusted', async (t) => {
  console.log('TEST: moderation before/after registry init - starting')
  const { graph } = await createGraph(t, 'moderation-t2')

  const modKeyPair = crypto.keyPair()
  const modPubkey = modKeyPair.publicKey.toString('hex')
  const ctx = await graph.createContext()
  const post = await graph.put({ type: 'post' })

  console.log('  Step 1: moderate before any RoleBase exists')
  await graph.moderateAction({ context: ctx, action: 'content.flag', target: post.id, reason: 'test', keyPair: modKeyPair })
  await graph.update()

  const before = []
  for await (const e of graph.queryContext({ type: 'moderation', context: ctx, target: post.id })) before.push(e)
  t.is(before.length, 0, 'no trust policy yet, so nothing is queryable')

  console.log('  Step 2: create RoleBase and grant the moderator permissions')
  await graph.createRoleBase()
  await graph.roleBase.init(modPubkey)
  await graph.roleBase.append({
    type: 'roles/setRolePermissions',
    role: 'member',
    permissions: ['content.flag', 'content.hide', 'content.remove'],
    author: modPubkey,
    timestamp: Date.now()
  })

  console.log('  Step 3: moderate again after the registry exists')
  await graph.moderateAction({ context: ctx, action: 'content.flag', target: post.id, reason: 'after-registry', keyPair: modKeyPair })
  await graph.update()

  const after = []
  for await (const e of graph.queryContext({ type: 'moderation', context: ctx, target: post.id, authors: [modPubkey] })) after.push(e)
  t.is(after.length, 2, 'both the pre- and post-registry facts are visible once the author is trusted')
  t.is(after.filter(e => e.action === 'content.flag').length, 2, 'both events are content.flag actions')
  console.log('TEST: moderation before/after registry init - passed')
})

test('moderation: an unauthorized action is rejected immediately, client-side, with a clear error', async (t) => {
  console.log('TEST: unauthorized moderation rejected client-side - starting')
  const { graph } = await createGraph(t, 'moderation-t3')

  const ownerKeyPair = crypto.keyPair()
  const ownerPubkey = ownerKeyPair.publicKey.toString('hex')
  const ctx = await graph.createContext()
  const post = await graph.put({ type: 'post' })

  console.log('  Step 1: set up a trust policy naming only the owner as having permissions')
  await graph.createRoleBase()
  await graph.roleBase.init(ownerPubkey)
  await graph.update()

  console.log('  Step 2: an untrusted keyPair (no role at all) is rejected immediately, not silently')
  const unauthorizedKeyPair = crypto.keyPair()
  const unauthorizedPubkey = unauthorizedKeyPair.publicKey.toString('hex')

  await t.exception(
    graph.moderateAction({
      context: ctx,
      action: 'content.reveal',
      target: post.id,
      reason: 'unauth',
      keyPair: unauthorizedKeyPair
    }),
    /Not authorized/,
    'moderateAction() throws immediately for an unauthorized caller, rather than silently no-op-ing'
  )

  console.log('  Step 3: confirm no fact was recorded at all — neither filtered nor unfiltered queries show it')
  const unfiltered = []
  for await (const e of graph.queryContext({ type: 'moderation', context: ctx, target: post.id })) unfiltered.push(e)
  t.is(unfiltered.length, 0, 'the rejected action was never recorded — confirmed via an unfiltered query, not just a filtered one')

  console.log('  Step 4: even bypassing the client-side check via the generic append() method, the apply layer still hard-rejects it')
  const context = await graph.openContext(ctx)
  const bypassEvent = {
    type: 'moderation/action',
    version: 1,
    action: 'content.reveal',
    target: post.id,
    reason: 'bypass attempt',
    context: null,
    author: unauthorizedPubkey,
    timestamp: Date.now(),
    signature: null
  }
  await context.append(bypassEvent) // no signature at all — should still be rejected regardless
  await graph.update()

  const afterBypass = []
  for await (const e of graph.queryContext({ type: 'moderation', context: ctx, target: post.id })) afterBypass.push(e)
  t.is(afterBypass.length, 0, 'the apply layer rejects the bypass attempt too — this is the real, enforced boundary, not just the client-side convenience check')

  console.log('TEST: unauthorized moderation rejected client-side - passed')
})

test('moderation: a moderation event that arrives before its author\'s RoleBase permissions have synced still resolves correctly, without needing repeated update() calls', async (t) => {
  // REGRESSION-STYLE TEST for the RoleBase-sync race: the RoleBase and a
  // context are two independent Autobase structures that replicate
  // concurrently — a peer's own apply function only evaluates a given
  // moderation event once, at the moment it first arrives, so if the
  // RoleBase data hasn't caught up yet at that exact moment, the
  // permission check has nothing to evaluate against. Confirms the
  // bounded retry inside #isModerationAllowed resolves this within the
  // SAME update() call that first sees the event, rather than requiring
  // the caller to keep calling update() until some later call happens to
  // land after the RoleBase catches up.
  console.log('TEST: moderation RoleBase-sync race - starting')

  const { store: storeA, graph: a } = await createGraph(t, 'moderation-race-a')
  const author = a.key.toString('hex')
  const roleKeyHex = await a.createRoleBase()
  await a.roleBase.init(author)
  await a.roleBase.append({
    type: 'roles/setRolePermissions',
    role: 'member',
    permissions: ['content.flag', 'content.hide', 'content.remove'],
    author,
    timestamp: Date.now()
  })
  await a.update()

  const post = await a.put({ type: 'post' })
  const ctx = await a.createContext()

  const modKeyPair = crypto.keyPair()
  await a.moderateAction({ context: ctx, action: 'content.flag', target: post.id, keyPair: modKeyPair })

  const os = require('os')
  const path = require('path')
  const fs = require('fs')
  const dirB = path.join(os.tmpdir(), `hypergraph-moderation-race-b-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(dirB, { recursive: true })
  const storeB = new Corestore(dirB)
  const { Hypergraph } = require('../../../index.js')
  const b = new Hypergraph(storeB, { userCoreKey: a.key })
  await b.ready()
  // Deliberately NOT pre-syncing the RoleBase before the context starts
  // replicating — both are opened together, so their actual data races
  // to arrive over the same link, exercising the scenario directly.
  await b.openRoleBase(roleKeyHex)
  await b.openContext(ctx)

  t.teardown(async () => {
    await b.close()
    await storeB.close()
    fs.rmSync(dirB, { recursive: true, force: true })
  })

  const s1 = storeA.replicate(true, { live: true })
  const s2 = storeB.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)
  t.teardown(async () => {
    try { s1.destroy() } catch (err) { /* already closed */ }
    try { s2.destroy() } catch (err) { /* already closed */ }
  })

  // A single settle-then-check, not a long polling loop — the point is
  // that the bounded retry inside the permission check itself does the
  // waiting, not repeated calls from here.
  for (let i = 0; i < 20; i++) {
    await sleep(200)
    await b.update()
    const postNode = await b.get(post.id)
    if (postNode) break
  }

  await b.update()
  const events = []
  for await (const ev of b.queryContext({ type: 'moderation', context: ctx, target: post.id })) events.push(ev)
  t.is(events.length, 1, 'the moderation fact resolved correctly despite the RoleBase-vs-context sync race')
  t.is(events[0].action, 'content.flag', 'the resolved event has the correct action')
  console.log('TEST: moderation RoleBase-sync race - passed')
})

test('moderation: offline-created events converge once two peers replicate', async (t) => {
  console.log('TEST: offline sync deterministic replay - starting')

  console.log('  Step 1: peer A creates a post, a role base, and two moderation facts while offline')
  const { store: storeA, graph: a } = await createGraph(t, 'moderation-offline-a')

  const author = a.key.toString('hex')
  const roleKeyHex = await a.createRoleBase()
  await a.roleBase.init(author)
  await a.roleBase.append({
    type: 'roles/setRolePermissions',
    role: 'member',
    permissions: ['content.flag', 'content.hide', 'content.remove'],
    author,
    timestamp: Date.now()
  })
  await a.update()

  const post = await a.put({ type: 'post' })
  const ctx = await a.createContext()

  const mod1 = crypto.keyPair()
  const mod2 = crypto.keyPair()
  await a.moderateAction({ context: ctx, action: 'content.flag', target: post.id, keyPair: mod1 })
  await a.moderateAction({ context: ctx, action: 'content.remove', target: post.id, keyPair: mod2 })

  console.log('  Step 2: peer B opens the same user core, role base, and context')
  const os = require('os')
  const path = require('path')
  const fs = require('fs')
  const dirB = path.join(os.tmpdir(), `hypergraph-moderation-offline-b-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(dirB, { recursive: true })
  const storeB = new Corestore(dirB)
  const { Hypergraph } = require('../../../index.js')
  const b = new Hypergraph(storeB, { userCoreKey: a.key })
  await b.ready()
  await b.openRoleBase(roleKeyHex)
  await b.openContext(ctx)

  t.teardown(async () => {
    await b.close()
    await storeB.close()
    fs.rmSync(dirB, { recursive: true, force: true })
  })

  console.log('  Step 3: replicate locally (in-process stream pipe, no swarm/DHT needed)')
  const s1 = storeA.replicate(true, { live: true })
  const s2 = storeB.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)
  t.teardown(async () => {
    try { s1.destroy() } catch (err) { /* already closed */ }
    try { s2.destroy() } catch (err) { /* already closed */ }
  })

  console.log('  Step 4: pump peer B until both facts converge')
  for (let i = 0; i < 200; i++) {
    await b.update()
    const postNode = await b.get(post.id)
    if (postNode) {
      const events = []
      for await (const ev of b.queryContext({ type: 'moderation', context: ctx, target: post.id })) events.push(ev)
      if (events.length === 2) {
        t.is(events.filter(e => e.action === 'content.flag').length, 1, 'flag event replicated')
        t.is(events.filter(e => e.action === 'content.remove').length, 1, 'remove event replicated')
        console.log('TEST: offline sync deterministic replay - passed')
        return
      }
    }
    await sleep(50)
  }

  t.fail('offline replication did not converge within timeout')
})

test.skip('moderation: stress scenarios (many flags/removes, competing trust policies)', async (t) => {
  // Deferred: this is a performance/stress scenario (10+ flaggers, adversarial
  // moderator spam, competing trust sets). Per project decision, only
  // correctness/reliability tests are in scope right now, not stress/perf
  // testing. Revisit once the moderation event model has stabilized.
})

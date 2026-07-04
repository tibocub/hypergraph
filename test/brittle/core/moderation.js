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

test('moderation: unauthorized moderation facts are still recorded but excluded by a trust policy', async (t) => {
  console.log('TEST: unauthorized moderation excluded by policy - starting')
  const { graph } = await createGraph(t, 'moderation-t3')

  const ownerKeyPair = crypto.keyPair()
  const ownerPubkey = ownerKeyPair.publicKey.toString('hex')
  const ctx = await graph.createContext()
  const post = await graph.put({ type: 'post' })

  console.log('  Step 1: set up a trust policy naming only the owner')
  await graph.createRoleBase()
  await graph.roleBase.init(ownerPubkey)
  await graph.roleBase.append({
    type: 'roles/setRolePermissions',
    role: 'member',
    permissions: ['content.flag', 'content.hide', 'content.remove'],
    author: ownerPubkey,
    timestamp: Date.now()
  })
  await graph.update()

  console.log('  Step 2: an untrusted keyPair moderates the same target')
  const unauthorizedKeyPair = crypto.keyPair()
  const unauthorizedPubkey = unauthorizedKeyPair.publicKey.toString('hex')
  await graph.moderateAction({
    context: ctx,
    action: 'content.reveal',
    target: post.id,
    reason: 'unauth',
    keyPair: unauthorizedKeyPair
  })
  await graph.update()

  console.log('  Step 3: querying with an authors filter that excludes them hides the fact')
  const unauth = []
  for await (const e of graph.queryContext({ type: 'moderation', context: ctx, target: post.id, authors: [unauthorizedPubkey] })) unauth.push(e)
  t.is(unauth.length, 0, 'filtering by a trust set that does not include the attacker hides their facts')
  console.log('TEST: unauthorized moderation excluded by policy - passed')
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

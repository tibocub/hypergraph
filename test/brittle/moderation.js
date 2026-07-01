const test = require('brittle')
const Corestore = require('corestore')
const { Hypergraph } = require('../../index.js')
const crypto = require('hypercore-crypto')
const os = require('os')
const path = require('path')
const fs = require('fs')

test.skip('hypergraph: moderation (facts only) stress scenarios', async (t) => {
  const tmpDir = path.join(os.tmpdir(), `hypergraph-test-moderation-${process.pid}-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })

  const store = new Corestore(tmpDir)
  const graph = new Hypergraph(store)
  await graph.ready()

  t.teardown(async () => {
    await graph.close()
    await store.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const authorKeyPair = crypto.keyPair()
  const author = graph.key.toString('hex')

  const roleKeyHex = await graph.createRoleBase()
  await graph.openRoleBase(roleKeyHex)
  await graph.roleBase.init(author)
  await graph.roleBase.append({
    type: 'roles/setRolePermissions',
    role: 'member',
    permissions: ['content.flag', 'content.hide', 'content.remove'],
    author,
    timestamp: Date.now()
  })
  await graph.update()

  const post = await graph.put({ type: 'post' })

  const ctx = await graph.createContext()

  // Case 1: Spam comment (many flags + a few removes)
  const target = post.id

  const flaggers = Array.from({ length: 10 }, () => crypto.keyPair())
  for (const kp of flaggers) {
    await graph.moderateAction({
      context: ctx,
      action: 'content.flag',
      target,
      keyPair: kp
    })
  }

  const moderators = [crypto.keyPair(), crypto.keyPair()]
  for (const kp of moderators) {
    await graph.moderateAction({
      context: ctx,
      action: 'content.remove',
      target,
      keyPair: kp
    })
  }

  const all = []
  for await (const ev of graph.queryContext({ type: 'moderation', context: ctx, target })) all.push(ev)
  t.is(all.length, 12)

  const removes = all.filter(e => e.action === 'content.remove')
  t.is(removes.length, 2)

  // Case 2: Malicious moderator (untrusted author spams remove)
  const attacker = crypto.keyPair()
  for (let i = 0; i < 5; i++) {
    await graph.moderateAction({
      context: ctx,
      action: 'content.remove',
      target,
      keyPair: attacker
    })
  }

  const trustedMods = new Set(moderators.map(kp => kp.publicKey.toString('hex')))
  const trustedView = []
  for await (const ev of graph.queryContext({ type: 'moderation', context: ctx, target, authors: [...trustedMods] })) trustedView.push(ev)
  t.is(trustedView.filter(e => e.action === 'content.remove').length, 2)

  // Case 3: Competing communities/policies (same facts, different trust sets)
  const policyA = new Set([moderators[0].publicKey.toString('hex')])
  const policyB = new Set([moderators[1].publicKey.toString('hex')])

  const a = []
  for await (const ev of graph.queryContext({ type: 'moderation', context: ctx, target, authors: [...policyA] })) a.push(ev)
  const b = []
  for await (const ev of graph.queryContext({ type: 'moderation', context: ctx, target, authors: [...policyB] })) b.push(ev)

  t.is(a.filter(e => e.action === 'content.remove').length, 1)
  t.is(b.filter(e => e.action === 'content.remove').length, 1)
})

test.skip('hypergraph: moderation offline sync (deterministic replay)', async (t) => {
  const dirA = path.join(os.tmpdir(), `hypergraph-test-mod-offline-a-${process.pid}-${Date.now()}`)
  const dirB = path.join(os.tmpdir(), `hypergraph-test-mod-offline-b-${process.pid}-${Date.now()}`)
  fs.mkdirSync(dirA, { recursive: true })
  fs.mkdirSync(dirB, { recursive: true })

  const storeA = new Corestore(dirA)
  const a = new Hypergraph(storeA)
  await a.ready()

  const authorKp = crypto.keyPair()
  const author = a.key.toString('hex')

  const roleKeyHex = await a.createRoleBase()
  await a.openRoleBase(roleKeyHex)
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

  const storeB = new Corestore(dirB)
  const b = new Hypergraph(storeB, { userCoreKey: a.key })
  await b.ready()
  await b.openRoleBase(roleKeyHex)
  await b.openContext(ctx)

  t.teardown(async () => {
    await a.close(); await storeA.close(); fs.rmSync(dirA, { recursive: true, force: true })
    await b.close(); await storeB.close(); fs.rmSync(dirB, { recursive: true, force: true })
  })

  // offline replication via corestore replication streams
  const s1 = storeA.replicate(true, { live: true })
  const s2 = storeB.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)

  for (let i = 0; i < 200; i++) {
    await b.update()
    const postNode = await b.get(post.id)
    if (!postNode) continue
    const events = []
    for await (const ev of b.queryContext({ type: 'moderation', context: ctx, target: post.id })) events.push(ev)
    if (events.length === 2) {
      t.is(events.filter(e => e.action === 'content.flag').length, 1)
      t.is(events.filter(e => e.action === 'content.remove').length, 1)
      return
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }

  t.fail('offline replication did not converge')
})

test('hypergraph: moderation roles T1 (pending before registry)', async (t) => {
  const tmpDir = path.join(os.tmpdir(), `hypergraph-test-mod-roles-t1-${process.pid}-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })

  const store = new Corestore(tmpDir)
  const graph = new Hypergraph(store)
  await graph.ready()

  t.teardown(async () => {
    await graph.close()
    await store.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const modKeyPair = crypto.keyPair()
  const ctx = await graph.createContext()
  const post = await graph.put({ type: 'post' })

  await graph.moderateAction({
    context: ctx,
    action: 'content.flag',
    target: post.id,
    reason: 'test',
    keyPair: modKeyPair
  })
  await graph.update()

  const results = []
  for await (const e of graph.queryContext({ type: 'moderation', context: ctx, target: post.id })) results.push(e)
  t.is(results.length, 0)
})

test.skip('hypergraph: moderation roles T2 (flush after registry init)', async (t) => {
  const tmpDir = path.join(os.tmpdir(), `hypergraph-test-mod-roles-t2-${process.pid}-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })

  const store = new Corestore(tmpDir)
  const graph = new Hypergraph(store)
  await graph.ready()

  t.teardown(async () => {
    await graph.close()
    await store.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const modKeyPair = crypto.keyPair()
  const modPubkey = modKeyPair.publicKey.toString('hex')
  const ctx = await graph.createContext()

  const post = await graph.put({ type: 'post' })

  await graph.moderateAction({
    context: ctx,
    action: 'content.flag',
    target: post.id,
    reason: 'test',
    keyPair: modKeyPair
  })

  await graph.update()

  const before = []
  for await (const e of graph.queryContext({ type: 'moderation', context: ctx, target: post.id })) before.push(e)
  t.is(before.length, 0)

  const roleKeyHex = await graph.createRoleBase()
  await graph.openRoleBase(roleKeyHex)
  await graph.roleBase.init(modPubkey)
  await graph.roleBase.append({
    type: 'roles/setRolePermissions',
    role: 'member',
    permissions: ['content.flag', 'content.hide', 'content.remove'],
    author: modPubkey,
    timestamp: Date.now()
  })

  await graph.moderateAction({
    context: ctx,
    action: 'content.flag',
    target: post.id,
    reason: 'after-registry',
    keyPair: modKeyPair
  })
  await graph.update()

  const after = []
  for await (const e of graph.queryContext({ type: 'moderation', context: ctx, target: post.id })) after.push(e)
  t.is(after.length, 2)
  t.is(after.filter(e => e.action === 'content.flag').length, 2)
})

test.skip('hypergraph: moderation roles T3 (unauthorized dropped)', async (t) => {
  const tmpDir = path.join(os.tmpdir(), `hypergraph-test-mod-roles-t3-${process.pid}-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })

  const store = new Corestore(tmpDir)
  const graph = new Hypergraph(store)
  await graph.ready()

  t.teardown(async () => {
    await graph.close()
    await store.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const ownerKeyPair = crypto.keyPair()
  const ownerPubkey = ownerKeyPair.publicKey.toString('hex')
  const ctx = await graph.createContext()

  const post = await graph.put({ type: 'post' })

  const roleKeyHex = await graph.createRoleBase()
  await graph.openRoleBase(roleKeyHex)
  await graph.roleBase.init(ownerPubkey)
  await graph.roleBase.append({
    type: 'roles/setRolePermissions',
    role: 'member',
    permissions: ['content.flag', 'content.hide', 'content.remove'],
    author: ownerPubkey,
    timestamp: Date.now()
  })
  await graph.update()

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

  const unauth = []
  for await (const e of graph.queryContext({ type: 'moderation', context: ctx, target: post.id, authors: [unauthorizedPubkey] })) unauth.push(e)
  t.is(unauth.length, 0)
})

test.skip('hypergraph: moderation roles T4 (can() correctness)', async (t) => {
  const tmpDir = path.join(os.tmpdir(), `hypergraph-test-mod-roles-t4-${process.pid}-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })

  const store = new Corestore(tmpDir)
  const graph = new Hypergraph(store)
  await graph.ready()

  t.teardown(async () => {
    await graph.close()
    await store.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const ownerKeyPair = crypto.keyPair()
  const ownerPubkey = ownerKeyPair.publicKey.toString('hex')

  const roleKeyHex = await graph.createRoleBase()
  await graph.openRoleBase(roleKeyHex)
  await graph.roleBase.init(ownerPubkey)
  await graph.update()

  t.ok(await graph.can(ownerPubkey, '*'))
  t.ok(await graph.can(ownerPubkey, 'content.remove'))
  t.ok(await graph.can(ownerPubkey, 'mod.add'))
  t.absent(await graph.can('deadbeef'.repeat(8), 'content.flag'))
})

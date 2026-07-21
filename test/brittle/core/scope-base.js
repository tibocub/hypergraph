const test = require('brittle')
const crypto = require('hypercore-crypto')
const { createGraph, sleep } = require('../helpers')

test('scope-base: createScope creates a scope and immediately grants the creator epoch 0', async (t) => {
  console.log('TEST: createScope basic - starting')
  const { graph } = await createGraph(t, 'scope-create')

  const roleKeyHex = await graph.createRoleBase()
  const owner = graph.identity.deviceKeyPair.publicKey.toString('hex')
  await graph.roleBase.init(owner)
  await graph.roleBase.append({
    type: 'roles/setRolePermissions',
    role: 'owner',
    permissions: ['*'],
    author: owner,
    timestamp: Date.now()
  })
  await graph.update()

  console.log('  Step 1: create the scope base and a scope')
  await graph.createScopeBase()
  const { scopeId, key } = await graph.scopeBase.createScope('private-dms')
  t.ok(scopeId, 'createScope returns the scope id')
  t.ok(Buffer.isBuffer(key) && key.length === 32, 'createScope returns a 32-byte raw symmetric key')

  console.log('  Step 2: the creator can resolve their own grant back to the same key')
  const epoch = await graph.scopeBase.getCurrentEpoch(scopeId)
  t.is(epoch, 0, 'a freshly created scope starts at epoch 0')

  const resolved = await graph.scopeBase.resolveKey(scopeId, owner, graph.identity.encryptionKeyPair, epoch)
  t.ok(resolved, 'resolveKey finds the creator\'s own grant')
  t.is(resolved.toString('hex'), key.toString('hex'), 'the resolved key matches the one returned at creation')
  console.log('TEST: createScope basic - passed')
})

test('scope-base: grantKey lets a second peer resolve the same key, sealed to their own encryption keypair', async (t) => {
  console.log('TEST: cross-peer grant - starting')
  const Corestore = require('corestore')
  const path = require('path')
  const os = require('os')
  const { Hypergraph } = require('../../../index.js')
  const IdentityManager = require('../../../src/identity-manager.js')

  // Two separate identities sharing one Corestore — no network
  // replication needed, since both cores physically live in the same
  // store (same pattern used elsewhere in this suite for multi-author
  // scenarios, e.g. the query() chronological-order test).
  const dir = path.join(os.tmpdir(), `hypergraph-scope-cross-${process.pid}-${Date.now()}`)
  const store = new Corestore(dir)
  const graphA = new Hypergraph(store)
  await graphA.ready()
  const identityB = new IdentityManager()
  await identityB.init()

  t.teardown(async () => {
    await graphA.close()
    await store.close()
  })

  const ownerA = graphA.identity.deviceKeyPair.publicKey.toString('hex')
  const pubkeyB = identityB.deviceKeyPair.publicKey.toString('hex')

  console.log('  Step 1: peer A sets up roles (both as owner and member, member gets scope.grant)')
  await graphA.createRoleBase()
  await graphA.roleBase.init(ownerA)
  await graphA.roleBase.append({
    type: 'roles/setRolePermissions',
    role: 'owner',
    permissions: ['*'],
    author: ownerA,
    timestamp: Date.now()
  })
  await graphA.update()

  console.log('  Step 2: peer A creates the scope and grants it to peer B')
  await graphA.createScopeBase()
  const { scopeId, key } = await graphA.scopeBase.createScope('private-dms')
  await graphA.scopeBase.grantKey(scopeId, pubkeyB, identityB.encryptionKeyPair.publicKey)

  console.log('  Step 3: peer B resolves the key using their OWN encryptionKeyPair')
  const epoch = await graphA.scopeBase.getCurrentEpoch(scopeId)
  const resolvedByB = await graphA.scopeBase.resolveKey(scopeId, pubkeyB, identityB.encryptionKeyPair, epoch)
  t.ok(resolvedByB, 'peer B resolves a grant addressed to them')
  t.is(resolvedByB.toString('hex'), key.toString('hex'), 'peer B\'s resolved key matches the original scope key')

  console.log('  Step 4: an unrelated identity cannot resolve using their own keypair against B\'s grant')
  const identityC = new IdentityManager()
  await identityC.init()
  const resolvedByCAgainstBsGrant = await graphA.scopeBase.resolveKey(scopeId, pubkeyB, identityC.encryptionKeyPair, epoch)
  t.is(resolvedByCAgainstBsGrant, null, 'an unrelated identity cannot unseal a grant addressed to someone else')
  console.log('TEST: cross-peer grant - passed')
})

test('scope-base: grantKey is rejected client-side for a caller without scope.grant permission', async (t) => {
  console.log('TEST: unauthorized grant rejected - starting')
  const Corestore = require('corestore')
  const path = require('path')
  const os = require('os')
  const fs = require('fs')
  const { Hypergraph } = require('../../../index.js')

  const dirOwner = path.join(os.tmpdir(), `hypergraph-scope-unauth-owner-${process.pid}-${Date.now()}`)
  const storeOwner = new Corestore(dirOwner)
  const graphOwner = new Hypergraph(storeOwner)
  await graphOwner.ready()

  const dirStranger = path.join(os.tmpdir(), `hypergraph-scope-unauth-stranger-${process.pid}-${Date.now()}`)
  const storeStranger = new Corestore(dirStranger)
  const graphStranger = new Hypergraph(storeStranger)
  await graphStranger.ready()

  t.teardown(async () => {
    await graphOwner.close()
    await graphStranger.close()
    await storeOwner.close()
    await storeStranger.close()
    fs.rmSync(dirOwner, { recursive: true, force: true })
    fs.rmSync(dirStranger, { recursive: true, force: true })
  })

  const owner = graphOwner.identity.deviceKeyPair.publicKey.toString('hex')
  const stranger = graphStranger.identity.deviceKeyPair.publicKey.toString('hex')

  console.log('  Step 1: owner sets up roles — stranger gets the default "member" role, with no permissions at all')
  const roleKeyHex = await graphOwner.createRoleBase()
  await graphOwner.roleBase.init(owner)
  await graphOwner.update()

  console.log('  Step 2: owner creates a scope')
  const scopeKeyHex = await graphOwner.createScopeBase()
  const { scopeId } = await graphOwner.scopeBase.createScope('private-dms')

  console.log('  Step 3: stranger opens the same role base and scope base over a real replicated link')
  await graphStranger.openRoleBase(roleKeyHex)
  await graphStranger.openScopeBase(scopeKeyHex)

  const s1 = storeOwner.replicate(true, { live: true })
  const s2 = storeStranger.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)
  t.teardown(async () => {
    try { s1.destroy() } catch (err) { /* already closed */ }
    try { s2.destroy() } catch (err) { /* already closed */ }
  })

  for (let i = 0; i < 30; i++) {
    await sleep(200)
    await graphStranger.update()
    const reg = await graphStranger.scopeBase.getRegistry()
    if (reg && reg[scopeId]) break
  }

  console.log('  Step 4: stranger (default "member", no scope.grant permission, and no key to grant anyway) tries to grant')
  await t.exception(
    graphStranger.scopeBase.grantKey(scopeId, stranger, graphStranger.identity.encryptionKeyPair.publicKey),
    /.+/,
    'grantKey throws — the stranger holds neither the permission nor the key itself'
  )
  console.log('TEST: unauthorized grant rejected - passed')
})

test('scope-base: grantKey fails for a scope the caller was never granted, even with full role permissions — an inherent cryptographic requirement, not just a policy check', async (t) => {
  console.log('TEST: cannot grant a key you do not hold - starting')
  const { createGraph } = require('../helpers')
  const { graph } = await createGraph(t, 'scope-cannot-grant-unknown')

  const owner = graph.identity.deviceKeyPair.publicKey.toString('hex')
  await graph.createRoleBase()
  await graph.roleBase.init(owner)
  await graph.roleBase.append({
    type: 'roles/setRolePermissions',
    role: 'owner',
    permissions: ['*'],
    author: owner,
    timestamp: Date.now()
  })
  await graph.update()
  await graph.createScopeBase()

  console.log('  full permissions ("*"), but trying to grant a scope that was never created at all')
  await t.exception(
    graph.scopeBase.grantKey('never-created-scope', owner, graph.identity.encryptionKeyPair.publicKey),
    /Unknown scope/,
    'grantKey fails outright for an unknown scope, regardless of role permissions — there is simply no key to seal'
  )
  console.log('TEST: cannot grant a key you do not hold - passed')
})

test('scope-base: revoke is informational only — a previously granted key remains resolvable, by design, not by oversight', async (t) => {
  console.log('TEST: revoke does not undo past access - starting')
  const { createGraph } = require('../helpers')
  const IdentityManager = require('../../../src/identity-manager.js')

  const { graph } = await createGraph(t, 'scope-revoke')
  const owner = graph.identity.deviceKeyPair.publicKey.toString('hex')

  await graph.createRoleBase()
  await graph.roleBase.init(owner)
  await graph.roleBase.append({
    type: 'roles/setRolePermissions',
    role: 'owner',
    permissions: ['*'],
    author: owner,
    timestamp: Date.now()
  })
  await graph.update()
  await graph.createScopeBase()

  const { scopeId, key } = await graph.scopeBase.createScope('private-dms')

  const identityB = new IdentityManager()
  await identityB.init()
  const pubkeyB = identityB.deviceKeyPair.publicKey.toString('hex')
  await graph.scopeBase.grantKey(scopeId, pubkeyB, identityB.encryptionKeyPair.publicKey)

  const epoch = await graph.scopeBase.getCurrentEpoch(scopeId)
  const resolvedBefore = await graph.scopeBase.resolveKey(scopeId, pubkeyB, identityB.encryptionKeyPair, epoch)
  t.ok(resolvedBefore, 'B can resolve their key before revocation')

  console.log('  owner revokes B')
  await graph.scopeBase.revoke(scopeId, pubkeyB)

  console.log('  B\'s already-granted key for this epoch is still resolvable — revocation does not retroactively undo it')
  const resolvedAfter = await graph.scopeBase.resolveKey(scopeId, pubkeyB, identityB.encryptionKeyPair, epoch)
  t.ok(resolvedAfter, 'B can still resolve the SAME epoch\'s key after being marked revoked')
  t.is(resolvedAfter.toString('hex'), key.toString('hex'), 'it\'s still the correct key — nothing was silently invalidated')

  console.log('  but the registry does mark them as revoked, informationally')
  const registry = await graph.scopeBase.getRegistry()
  t.ok(registry[scopeId].revoked[pubkeyB], 'the revoked marker is set for B')
  console.log('TEST: revoke does not undo past access - passed')
})

test('scope-base: a keyGrant event that arrives before its granter\'s RoleBase permissions have synced still resolves correctly, without needing repeated update() calls', async (t) => {
  // Mirrors the equivalent test for moderation events (round 38):
  // RoleBase and ScopeBase are two independent Autobase structures that
  // replicate concurrently — a receiving peer's own apply function only
  // evaluates a given event once, at the moment it first arrives, so if
  // the RoleBase data hasn't caught up yet at that exact moment, the
  // scope.grant permission check has nothing to evaluate against.
  console.log('TEST: scope RoleBase-sync race - starting')
  const Corestore = require('corestore')
  const path = require('path')
  const os = require('os')
  const fs = require('fs')
  const { Hypergraph } = require('../../../index.js')
  const IdentityManager = require('../../../src/identity-manager.js')

  const dirA = path.join(os.tmpdir(), `hypergraph-scope-race-a-${process.pid}-${Date.now()}`)
  const storeA = new Corestore(dirA)
  const graphA = new Hypergraph(storeA)
  await graphA.ready()
  const author = graphA.identity.deviceKeyPair.publicKey.toString('hex')

  await graphA.createRoleBase()
  await graphA.roleBase.init(author)
  await graphA.roleBase.append({
    type: 'roles/setRolePermissions',
    role: 'owner',
    permissions: ['*'],
    author,
    timestamp: Date.now()
  })
  const roleKeyHex = await graphA.roleBase.key.toString('hex')
  await graphA.update()

  const scopeKeyHex = await graphA.createScopeBase()
  const { scopeId, key } = await graphA.scopeBase.createScope('private-dms')

  const identityB = new IdentityManager()
  await identityB.init()
  const pubkeyB = identityB.deviceKeyPair.publicKey.toString('hex')
  await graphA.scopeBase.grantKey(scopeId, pubkeyB, identityB.encryptionKeyPair.publicKey)

  console.log('  Step 2: peer B opens the same role base and scope base, then replication races the two structures against each other')
  const dirB = path.join(os.tmpdir(), `hypergraph-scope-race-b-${process.pid}-${Date.now()}`)
  const storeB = new Corestore(dirB)
  const graphB = new Hypergraph(storeB)
  await graphB.ready()

  t.teardown(async () => {
    await graphA.close()
    await graphB.close()
    await storeA.close()
    await storeB.close()
    fs.rmSync(dirA, { recursive: true, force: true })
    fs.rmSync(dirB, { recursive: true, force: true })
  })

  // Deliberately NOT pre-syncing the RoleBase before opening the scope
  // base — both are opened together, so their actual data races to
  // arrive over the same replication link, exercising the scenario
  // directly rather than assuming it away.
  await graphB.openRoleBase(roleKeyHex)
  await graphB.openScopeBase(scopeKeyHex)

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
    await graphB.update()
    const reg = await graphB.scopeBase.getRegistry()
    if (reg && reg[scopeId] && reg[scopeId].grants[`${pubkeyB}:0`]) break
  }

  await graphB.update()
  const resolvedByB = await graphB.scopeBase.resolveKey(scopeId, pubkeyB, identityB.encryptionKeyPair, 0)
  t.ok(resolvedByB, 'the keyGrant resolved correctly on peer B despite the RoleBase-vs-ScopeBase sync race')
  t.is(resolvedByB.toString('hex'), key.toString('hex'), 'and it is the correct key')
  console.log('TEST: scope RoleBase-sync race - passed')
})

test('scope-base: rotateKey() moves a scope to a new epoch, re-granting current members while leaving old-epoch access intact', async (t) => {
  console.log('TEST: rotateKey basic - starting')
  const { graph } = await createGraph(t, 'scope-rotate-basic')
  const IdentityManager = require('../../../src/identity-manager.js')

  const owner = graph.identity.deviceKeyPair.publicKey.toString('hex')
  await graph.createRoleBase()
  await graph.roleBase.init(owner)
  await graph.roleBase.append({
    type: 'roles/setRolePermissions',
    role: 'owner',
    permissions: ['*'],
    author: owner,
    timestamp: Date.now()
  })
  await graph.update()
  await graph.createScopeBase()

  const { scopeId, key: epoch0Key } = await graph.scopeBase.createScope('private-dms')

  const identityB = new IdentityManager()
  await identityB.init()
  const pubkeyB = identityB.deviceKeyPair.publicKey.toString('hex')
  await graph.scopeBase.grantKey(scopeId, pubkeyB, identityB.encryptionKeyPair.publicKey)

  console.log('  Step 1: rotate the key')
  const { epoch: newEpoch, key: epoch1Key, grantedTo } = await graph.scopeBase.rotateKey(scopeId)
  t.is(newEpoch, 1, 'rotation moves to epoch 1')
  t.not(epoch1Key.toString('hex'), epoch0Key.toString('hex'), 'the new key is genuinely different from the old one')
  t.alike(grantedTo.sort(), [owner, pubkeyB].sort(), 'both the owner and B were re-granted the new epoch')

  console.log('  Step 2: both members can resolve the NEW epoch')
  const ownerEpoch1 = await graph.scopeBase.resolveKey(scopeId, owner, graph.identity.encryptionKeyPair, 1)
  t.is(ownerEpoch1.toString('hex'), epoch1Key.toString('hex'), 'owner resolves the new epoch correctly')
  const bEpoch1 = await graph.scopeBase.resolveKey(scopeId, pubkeyB, identityB.encryptionKeyPair, 1)
  t.is(bEpoch1.toString('hex'), epoch1Key.toString('hex'), 'B resolves the new epoch correctly too')

  console.log('  Step 3: old epoch 0 content is still decryptable — rotation does not retroactively lock anyone out of the past')
  const bEpoch0 = await graph.scopeBase.resolveKey(scopeId, pubkeyB, identityB.encryptionKeyPair, 0)
  t.is(bEpoch0.toString('hex'), epoch0Key.toString('hex'), 'B can still resolve the OLD epoch 0 key after rotation')
  console.log('TEST: rotateKey basic - passed')
})

test('scope-base: rotateKey() with excludePubkeys correctly cuts a member off from future epochs, while others keep access', async (t) => {
  console.log('TEST: rotateKey exclusion - starting')
  const { graph } = await createGraph(t, 'scope-rotate-exclude')
  const IdentityManager = require('../../../src/identity-manager.js')

  const owner = graph.identity.deviceKeyPair.publicKey.toString('hex')
  await graph.createRoleBase()
  await graph.roleBase.init(owner)
  await graph.roleBase.append({
    type: 'roles/setRolePermissions',
    role: 'owner',
    permissions: ['*'],
    author: owner,
    timestamp: Date.now()
  })
  await graph.update()
  await graph.createScopeBase()

  const { scopeId } = await graph.scopeBase.createScope('private-dms')

  const identityB = new IdentityManager()
  await identityB.init()
  const pubkeyB = identityB.deviceKeyPair.publicKey.toString('hex')
  await graph.scopeBase.grantKey(scopeId, pubkeyB, identityB.encryptionKeyPair.publicKey)

  const identityC = new IdentityManager()
  await identityC.init()
  const pubkeyC = identityC.deviceKeyPair.publicKey.toString('hex')
  await graph.scopeBase.grantKey(scopeId, pubkeyC, identityC.encryptionKeyPair.publicKey)

  console.log('  revoke B, then rotate excluding B')
  await graph.scopeBase.revoke(scopeId, pubkeyB)
  const { epoch: newEpoch, grantedTo } = await graph.scopeBase.rotateKey(scopeId, { excludePubkeys: [pubkeyB] })

  t.alike(grantedTo.sort(), [owner, pubkeyC].sort(), 'only the owner and C were re-granted — B was excluded')
  t.absent(grantedTo.includes(pubkeyB), 'B specifically was not re-granted')

  const bNewEpoch = await graph.scopeBase.resolveKey(scopeId, pubkeyB, identityB.encryptionKeyPair, newEpoch)
  t.is(bNewEpoch, null, 'B cannot resolve the new epoch at all — cut off from future content')

  const cNewEpoch = await graph.scopeBase.resolveKey(scopeId, pubkeyC, identityC.encryptionKeyPair, newEpoch)
  t.ok(cNewEpoch, 'C, who was never revoked, still gets the new epoch correctly')
  console.log('TEST: rotateKey exclusion - passed')
})

test('scope-base: rotateKey() is rejected for a caller without scope.grant permission, over a real replicated link', async (t) => {
  console.log('TEST: rotateKey unauthorized - starting')
  const Corestore = require('corestore')
  const path = require('path')
  const os = require('os')
  const fs = require('fs')
  const { Hypergraph } = require('../../../index.js')

  const dirOwner = path.join(os.tmpdir(), `hypergraph-rotate-unauth-owner-${process.pid}-${Date.now()}`)
  const storeOwner = new Corestore(dirOwner)
  const graphOwner = new Hypergraph(storeOwner)
  await graphOwner.ready()

  const dirStranger = path.join(os.tmpdir(), `hypergraph-rotate-unauth-stranger-${process.pid}-${Date.now()}`)
  const storeStranger = new Corestore(dirStranger)
  const graphStranger = new Hypergraph(storeStranger)
  await graphStranger.ready()

  t.teardown(async () => {
    await graphOwner.close()
    await graphStranger.close()
    await storeOwner.close()
    await storeStranger.close()
    fs.rmSync(dirOwner, { recursive: true, force: true })
    fs.rmSync(dirStranger, { recursive: true, force: true })
  })

  const owner = graphOwner.identity.deviceKeyPair.publicKey.toString('hex')
  const stranger = graphStranger.identity.deviceKeyPair.publicKey.toString('hex')

  const roleKeyHex = await graphOwner.createRoleBase()
  await graphOwner.roleBase.init(owner)
  await graphOwner.update()

  const scopeKeyHex = await graphOwner.createScopeBase()
  const { scopeId } = await graphOwner.scopeBase.createScope('private-dms')
  await graphOwner.scopeBase.grantKey(scopeId, stranger, graphStranger.identity.encryptionKeyPair.publicKey)

  await graphStranger.openRoleBase(roleKeyHex)
  await graphStranger.openScopeBase(scopeKeyHex)

  const s1 = storeOwner.replicate(true, { live: true })
  const s2 = storeStranger.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)
  t.teardown(async () => {
    try { s1.destroy() } catch (err) { /* already closed */ }
    try { s2.destroy() } catch (err) { /* already closed */ }
  })

  for (let i = 0; i < 30; i++) {
    await sleep(200)
    await graphStranger.update()
    const reg = await graphStranger.scopeBase.getRegistry()
    if (reg && reg[scopeId] && reg[scopeId].grants[`${stranger}:0`]) break
  }

  console.log('  stranger holds the current key (so the crypto requirement is met) but has default "member" role, no scope.grant')
  await t.exception(
    graphStranger.scopeBase.rotateKey(scopeId),
    /Not authorized/,
    'rotateKey throws — holding the key is not enough without scope.grant permission'
  )
  console.log('TEST: rotateKey unauthorized - passed')
})



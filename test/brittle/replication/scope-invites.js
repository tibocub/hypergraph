// Invites that also give read access to encrypted content (spec 006, US3).
//
// The link only asks for the scope's key; a member who holds it, online,
// seals it to the redeemer on update(). In-memory streams through
// graph.replicate(), so it is deterministic.

const test = require('brittle')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { createGraph, sleep } = require('../helpers')
const { stableContextHash } = require('../../../src/utils')

function link (a, b) {
  const s1 = a.graph.replicate(true)
  const s2 = b.graph.replicate(false)
  s1.pipe(s2).pipe(s1)
  return () => { s1.destroy(); s2.destroy() }
}

async function until (fn, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await sleep(100)
  }
  return false
}

const pub = (p) => p.graph.identity.deviceKeyPair.publicKey.toString('hex')

// An owner with a RoleBase (all permissions), a ScopeBase with one scope, a
// version 3 context, and a post whose content is encrypted under the scope.
async function setup (t, label) {
  const owner = await createGraph(t, `${label}-owner`)
  const me = pub(owner)
  await owner.graph.createRoleBase()
  await owner.graph.roleBase.init(me)
  await owner.graph.roleBase.append({ type: 'roles/setRolePermissions', role: 'owner', permissions: ['*'], author: me, timestamp: Date.now() })
  await owner.graph.update()
  await owner.graph.createScopeBase()
  const { scopeId } = await owner.graph.scopeBase.createScope('private')
  const ctx = await owner.graph.createContext()
  owner.ctx = await owner.graph.openContext(ctx)
  const post = await owner.graph.put({ type: 'post' })
  await owner.graph.putContent(post.id, 'members only', 'text', { scope: scopeId })
  return { owner, ctx, scopeId, post }
}

async function peer (t, label, ...others) {
  const p = await createGraph(t, label)
  for (const o of others) t.teardown(link(o, p))
  return p
}

async function pump (peers) {
  for (const p of peers) await p.graph.update()
}

async function readsSecret (p, owner, post) {
  await p.graph.openUserCore(owner.graph.key)
  const content = await p.graph.getContent(post.id)
  return !!(content && content.body === 'members only')
}

test('scope-invites: a link holder becomes a member and, once a key holder is online, reads the encrypted content', { timeout: 120000 }, async (t) => {
  const { owner, scopeId, post } = await setup(t, 'si-basic')
  const invite = await owner.ctx.createInvite({ role: 'member', scope: scopeId, keyPair: owner.graph.identity.deviceKeyPair })
  t.alike((await owner.ctx.invites())[(await owner.graph.constructor.parseInvite(invite)).inviteKey].scope, scopeId, 'the invite records its scope')

  const b = await peer(t, 'si-basic-b', owner)
  const bCtx = await b.graph.redeemInvite(invite, { timeout: 20000 })
  t.ok(bCtx.writable, 'b is a writer')
  t.ok(b.graph.scopeBase && b.graph.roleBase, 'redeeming opened the invite\'s ScopeBase and RoleBase')

  t.ok(await until(async () => {
    await pump([owner, b])
    return readsSecret(b, owner, post)
  }), 'b reads the encrypted post after the owner\'s update() sealed the key to it')
  t.ok((await owner.graph.scopeBase.getRegistry())[scopeId].grants[`${pub(b)}:0`], 'through an ordinary key grant')
})

test('scope-invites: redeemInvite({ scopeTimeout }) also waits for the key', { timeout: 120000 }, async (t) => {
  const { owner, scopeId, post } = await setup(t, 'si-wait')
  const invite = await owner.ctx.createInvite({ scope: scopeId, keyPair: owner.graph.identity.deviceKeyPair })
  const b = await peer(t, 'si-wait-b', owner)
  // The owner keeps updating in the background, as an app would.
  let running = true
  const loop = (async () => { while (running) { await owner.graph.update().catch(() => {}); await sleep(100) } })()
  t.teardown(async () => { running = false; await loop })

  await b.graph.redeemInvite(invite, { timeout: 20000, scopeTimeout: 20000 })
  const epoch = await b.graph.scopeBase.getCurrentEpoch(scopeId)
  t.ok(await b.graph.scopeBase.resolveKey(scopeId, pub(b), b.graph.identity.encryptionKeyPair, epoch), 'the key is there when redeemInvite resolves')
  t.ok(await until(async () => { await b.graph.update(); return readsSecret(b, owner, post) }), 'and opens the content once the owner log is indexed')
})

test('scope-invites: a plain invite gives no key; a minter without the key cannot mint one', { timeout: 120000 }, async (t) => {
  const { owner, scopeId, post } = await setup(t, 'si-plain')
  const plain = await owner.ctx.createInvite({ keyPair: owner.graph.identity.deviceKeyPair })
  const b = await peer(t, 'si-plain-b', owner)
  await b.graph.redeemInvite(plain, { timeout: 20000 })
  for (let i = 0; i < 10; i++) { await pump([owner, b]); await sleep(100) }
  t.absent((await owner.graph.scopeBase.getRegistry())[scopeId].grants[`${pub(b)}:0`], 'no grant for a plain invite')
  t.absent(await readsSecret(b, owner, post).catch(() => false), 'and nothing readable')

  // b is now a member of the context, with the same RoleBase and ScopeBase
  // open, but holds no key: it can't ask for the scope by link.
  await b.graph.openRoleBase(owner.graph.roleBase.key)
  await b.graph.openScopeBase(owner.graph.scopeBase.key)
  await until(async () => { await pump([owner, b]); return !!(await b.graph.scopeBase.getRegistry())?.[scopeId] })
  const bCtx = await b.graph.openContext(owner.ctx.key.toString('hex'))
  let error = null
  try {
    await bCtx.createInvite({ scope: scopeId, keyPair: b.graph.identity.deviceKeyPair })
  } catch (err) {
    error = err
  }
  t.ok(error && /do not hold the current key/.test(error.message), `minting a scoped invite needs the key (${error && error.message})`)
})

test('scope-invites: a scoped invite from a minter who could not grant the scope gets nothing from other key holders', { timeout: 180000 }, async (t) => {
  const { owner, ctx, scopeId, post } = await setup(t, 'si-forged')
  const ownerKp = owner.graph.identity.deviceKeyPair

  // An admin of the context (may mint member invites) who has no scope key.
  const adminInvite = await owner.ctx.createInvite({ role: 'admin', keyPair: ownerKp })
  const admin = await peer(t, 'si-forged-admin', owner)
  const adminCtx = await admin.graph.redeemInvite(adminInvite, { timeout: 20000 })

  // It appends a scoped invite by hand (createInvite would refuse).
  const seed = crypto.randomBytes(32)
  const inviteKey = b4a.toString(crypto.keyPair(seed).publicKey, 'hex')
  const event = {
    type: 'context/invite',
    inviteKey,
    role: 'member',
    uses: 1,
    scope: scopeId,
    scopeBase: owner.graph.scopeBase.key.toString('hex'),
    roleBase: owner.graph.roleBase.key.toString('hex'),
    author: pub(admin),
    timestamp: Date.now(),
    signature: null
  }
  event.signature = b4a.toString(crypto.sign(stableContextHash(event, ctx), admin.graph.identity.deviceKeyPair.secretKey), 'hex')
  await adminCtx.append(event)

  const c = await peer(t, 'si-forged-c', owner, admin)
  const cCtx = await c.graph.redeemInvite(`hypergraph://invite/${ctx}/${b4a.toString(seed, 'hex')}`, { timeout: 20000 })
  t.ok(cCtx.writable, 'the redemption itself is valid: the admin may hand out the member role')

  for (let i = 0; i < 20; i++) { await pump([owner, admin, c]); await sleep(100) }
  t.absent((await owner.graph.scopeBase.getRegistry())[scopeId].grants[`${pub(c)}:0`], 'the owner, who holds the key, did not grant it on the admin\'s behalf')
  t.absent(await readsSecret(c, owner, post).catch(() => false), 'and c cannot read')
})

test('scope-invites: a member revoked from the scope is not granted the new key again', { timeout: 180000 }, async (t) => {
  const { owner, scopeId, post } = await setup(t, 'si-revoked')
  const invite = await owner.ctx.createInvite({ scope: scopeId, keyPair: owner.graph.identity.deviceKeyPair })
  const b = await peer(t, 'si-revoked-b', owner)
  await b.graph.redeemInvite(invite, { timeout: 20000 })
  t.ok(await until(async () => { await pump([owner, b]); return readsSecret(b, owner, post) }), 'granted first')

  await owner.graph.scopeBase.revoke(scopeId, pub(b))
  const { epoch } = await owner.graph.scopeBase.rotateKey(scopeId, { excludePubkeys: [pub(b)] })
  for (let i = 0; i < 20; i++) { await pump([owner, b]); await sleep(100) }
  t.absent((await owner.graph.scopeBase.getRegistry())[scopeId].grants[`${pub(b)}:${epoch}`], 'no grant at the new epoch')
})

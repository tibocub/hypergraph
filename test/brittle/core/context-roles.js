// Roles recorded inside the context (spec 005): every permission decision
// comes from the context's own log, so every peer decides the same.

const test = require('brittle')
const crypto = require('hypercore-crypto')
const { createGraph, sleep } = require('../helpers')

const hex = (kp) => kp.publicKey.toString('hex')

async function until (fn, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await sleep(50)
  }
  return false
}

async function newContext (t, label, opts = {}) {
  const { graph, store } = await createGraph(t, label)
  const owner = graph.identity.deviceKeyPair
  const ctx = await graph.createContext(opts)
  const context = await graph.openContext(ctx, opts)
  return { graph, store, owner, ctx, context }
}

test('context-roles: a new context is version 3 and its creator is the owner', async (t) => {
  const { context, owner } = await newContext(t, 'roles-init')
  t.is((await context.status()).version, 3, 'version 3')
  const table = await context.roles()
  t.is(table.members[hex(owner)], 'owner', 'creator is owner')
  t.alike(table.roles.owner, ['*'], 'owner can do everything')
  t.ok(table.roles.admin.includes('context.index'), 'admins index by default')
})

test('context-roles: who may change roles is decided from the context\'s own table', async (t) => {
  const { context, owner } = await newContext(t, 'roles-assign')
  const alice = crypto.keyPair()
  const bob = crypto.keyPair()
  const mallory = crypto.keyPair()

  await context.setRole(hex(alice), 'admin', { keyPair: owner })
  t.is((await context.roles()).members[hex(alice)], 'admin', 'owner grants admin')

  await context.setRole(hex(mallory), 'owner', { keyPair: mallory })
  t.absent((await context.roles()).members[hex(mallory)], 'a stranger cannot grant itself a role')

  await context.setRole(hex(bob), 'admin', { keyPair: alice })
  t.absent((await context.roles()).members[hex(bob)], 'an admin cannot grant admin (not above or equal to its own)')

  await context.setRole(hex(bob), 'mod', { keyPair: alice })
  t.is((await context.roles()).members[hex(bob)], 'mod', 'an admin (mod.add) grants mod')

  await context.removeRole(hex(bob), { keyPair: alice })
  t.absent((await context.roles()).members[hex(bob)], 'an admin (mod.remove) removes a mod')

  await context.removeRole(hex(alice), { keyPair: mallory })
  t.is((await context.roles()).members[hex(alice)], 'admin', 'a stranger cannot remove an admin')

  // A grant whose signature doesn't match its author.
  const forged = { type: 'context/role', member: hex(mallory), role: 'admin', author: hex(owner), timestamp: Date.now(), signature: 'ab'.repeat(64) }
  await context.append(forged)
  t.absent((await context.roles()).members[hex(mallory)], 'a forged grant is ignored')
})

test('context-roles: closed-mode writers and moderation are checked against the context, not the RoleBase', async (t) => {
  const { graph, owner, ctx, context } = await newContext(t, 'roles-closed', { writeMode: 'closed' })
  const contextAdmin = crypto.keyPair()
  const roleBaseOnly = crypto.keyPair()

  // A RoleBase that says roleBaseOnly is an admin and a mod...
  await graph.createRoleBase()
  await graph.roleBase.init(hex(owner))
  await graph.setRole(hex(roleBaseOnly), 'admin', { keyPair: owner })
  await graph.update()
  t.ok(await graph.can(hex(roleBaseOnly), 'context.write'), 'the RoleBase grants it context.write')

  // ...but only contextAdmin has a role in this context.
  await context.setRole(hex(contextAdmin), 'admin', { keyPair: owner })

  const w1 = crypto.keyPair().publicKey
  const w2 = crypto.keyPair().publicKey
  await context.addWriter(w1, { keyPair: contextAdmin })
  await context.addWriter(w2, { keyPair: roleBaseOnly }).catch(() => {})
  await graph.update()
  const writers = context.writerKeys()
  t.ok(writers.includes(w1.toString('hex')), 'the context admin added a writer')
  t.absent(writers.includes(w2.toString('hex')), 'the RoleBase-only admin could not')

  const post = await graph.put({ type: 'post' })
  await graph.moderateAction({ context: ctx, action: 'content.hide', target: post.id, keyPair: contextAdmin })
  await t.exception(graph.moderateAction({ context: ctx, action: 'content.hide', target: post.id, keyPair: roleBaseOnly }), /Not authorized/, 'pre-check uses the context table')
  const seen = []
  for await (const e of graph.queryContext({ type: 'moderation', context: ctx, target: post.id, authors: [hex(contextAdmin), hex(roleBaseOnly)] })) seen.push(e.author)
  t.alike(seen, [hex(contextAdmin)], 'only the context admin\'s moderation is indexed')
})

test('context-roles: the creator converts a version 1 context — only it indexes afterwards, writers keep writing', async (t) => {
  const ContextBase = require('../../../src/context-base.js')
  const a = await createGraph(t, 'roles-upgrade-a')
  const b = await createGraph(t, 'roles-upgrade-b')
  const s1 = a.store.replicate(true, { live: true })
  const s2 = b.store.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)
  t.teardown(() => { s1.destroy(); s2.destroy() })

  const legacy = new ContextBase(a.store, null, {})
  await legacy.ready()
  t.teardown(() => legacy.close())
  const ctx = legacy.key.toString('hex')
  const bCtx = await b.graph.openContext(ctx)
  await legacy.addWriter(bCtx.localKey)
  t.ok(await until(async () => { await legacy.update(); await b.graph.update(); return (await legacy.status()).indexers.length === 2 }), 'version 1: both index')

  // A non-creator cannot convert.
  await bCtx.upgrade({ keyPair: b.graph.identity.deviceKeyPair })
  await until(async () => { await legacy.update(); await b.graph.update(); return legacy.base.length === bCtx.base.length })
  t.is((await legacy.status()).version, 1, 'conversion by a non-creator ignored')

  await legacy.upgrade({ keyPair: a.graph.identity.deviceKeyPair })
  t.ok(await until(async () => {
    await legacy.update(); await b.graph.update()
    const s = await bCtx.status()
    return s.version === 3 && s.indexers.length === 1
  }), 'after conversion, version 3 everywhere')
  const status = await bCtx.status()
  t.alike(status.indexers, [legacy.localKey.toString('hex')], 'only the creator indexes')
  t.ok(bCtx.writable, 'the other writer still writes')
  t.is((await bCtx.roles()).members[a.graph.identity.deviceKeyPair.publicKey.toString('hex')], 'owner', 'creator is owner')
})

test('context-roles: the creator converts a version 2 (RoleBase) context; it then has its own table', async (t) => {
  const { graph, owner } = await createGraph(t, 'roles-upgrade-v2').then(r => ({ ...r, owner: r.graph.identity.deviceKeyPair }))
  const ctx = await graph.createContext({ roles: 'rolebase' })
  const context = await graph.openContext(ctx)
  t.is((await context.status()).version, 2, 'starts as version 2')
  t.alike((await context.roles()).members, {}, 'no role table of its own yet')
  await t.exception(context.setRole('ab'.repeat(32), 'mod', { keyPair: owner }), /version 3 only/, 'roles cannot be set in the context before converting')

  await context.upgrade({ keyPair: owner })
  await graph.update()
  t.is((await context.status()).version, 3, 'version 3 after conversion')
  t.is((await context.roles()).members[hex(owner)], 'owner', 'creator is owner')
  await context.setRole('ab'.repeat(32), 'mod', { keyPair: owner })
  t.is((await context.roles()).members['ab'.repeat(32)], 'mod', 'roles now live in the context')
})

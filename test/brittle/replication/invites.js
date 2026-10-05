// Invite links that carry a role (spec 006).
//
// Peers are linked with graph.replicate(), which carries Autobase's writer
// discovery: that is what lets a redeemer that isn't a writer yet be seen.
// In-memory streams, so it is deterministic.

const test = require('brittle')
const crypto = require('hypercore-crypto')
const { createGraph, sleep } = require('../helpers')
const { Hypergraph } = require('../../../index.js')

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

async function ownerWithContext (t, label) {
  const owner = await createGraph(t, `${label}-owner`)
  const ctx = await owner.graph.createContext()
  owner.ctx = await owner.graph.openContext(ctx)
  owner.kp = owner.graph.identity.deviceKeyPair
  return { owner, ctx }
}

async function peer (t, label, owner) {
  const p = await createGraph(t, label)
  t.teardown(link(owner, p))
  return p
}

test('invites: a link holder redeems an admin invite with the owner only replicating, and is an admin and indexer everywhere', { timeout: 120000 }, async (t) => {
  const { owner, ctx } = await ownerWithContext(t, 'inv-admin')
  const invite = await owner.ctx.createInvite({ role: 'admin', keyPair: owner.kp })
  t.ok(invite.startsWith('hypergraph://invite/'), `a link: ${invite.slice(0, 40)}…`)
  const parsed = Hypergraph.parseInvite(invite)
  t.is(parsed.context, ctx, 'the link names the context')

  const b = await peer(t, 'inv-admin-b', owner)
  const started = Date.now()
  const bCtx = await b.graph.redeemInvite(invite, { timeout: 20000 })
  t.ok(bCtx.writable, `the redeemer can write (${Date.now() - started} ms)`)

  t.ok(await until(async () => {
    await owner.graph.update(); await b.graph.update()
    return (await owner.ctx.roles()).members[pub(b)] === 'admin'
  }), 'the owner sees the redeemer as admin')
  t.ok(await until(async () => {
    await owner.graph.update()
    return (await owner.ctx.status()).indexers.includes(bCtx.localKey.toString('hex'))
  }), 'and its device as an indexer')
  t.is((await owner.ctx.invites())[parsed.inviteKey].used, 1, 'the use is counted')

  const post = await b.graph.put({ type: 'post' })
  await b.graph.relate({ from: post.id, to: post.id, type: 'self', context: ctx })
  t.ok(await until(async () => { await owner.graph.update(); await owner.graph.openUserCore(b.graph.key); return (await owner.graph.countEdgesIn(post.id, 'self', { context: ctx })) === 1 }), 'and writes like any writer')
})

test('invites: a member invite makes a writer that doesn\'t index', { timeout: 120000 }, async (t) => {
  const { owner } = await ownerWithContext(t, 'inv-member')
  const invite = await owner.ctx.createInvite({ keyPair: owner.kp }) // role defaults to member
  const c = await peer(t, 'inv-member-c', owner)
  const cCtx = await c.graph.redeemInvite(invite, { timeout: 20000 })
  t.ok(cCtx.writable, 'writer')
  await until(async () => { await owner.graph.update(); return (await owner.ctx.roles()).members[pub(c)] === 'member' })
  t.is((await owner.ctx.roles()).members[pub(c)], 'member', 'member role')
  t.absent((await owner.ctx.status()).indexers.includes(cCtx.localKey.toString('hex')), 'not an indexer')
})

test('invites: limits hold — single use, revocation, unauthorized minting, wrong secret, stray blocks', { timeout: 180000 }, async (t) => {
  const { owner, ctx } = await ownerWithContext(t, 'inv-limits')

  // Single use: the second holder gets nothing.
  const once = await owner.ctx.createInvite({ role: 'member', uses: 1, keyPair: owner.kp })
  const first = await peer(t, 'inv-limits-first', owner)
  await first.graph.redeemInvite(once, { timeout: 20000 })
  const second = await peer(t, 'inv-limits-second', owner)
  await t.exception(second.graph.redeemInvite(once, { timeout: 4000 }), /not granted|timed out/i, 'a used-up invite grants nothing')

  // Revoked.
  const revoked = await owner.ctx.createInvite({ role: 'member', keyPair: owner.kp })
  await owner.ctx.revokeInvite(revoked, { keyPair: owner.kp })
  const r = await peer(t, 'inv-limits-revoked', owner)
  await t.exception(r.graph.redeemInvite(revoked, { timeout: 4000 }), /not granted|timed out/i, 'a revoked invite grants nothing')

  // A plain member can't mint an admin invite.
  const memberKp = first.graph.identity.deviceKeyPair
  const firstCtx = await first.graph.openContext(ctx)
  const forbidden = await firstCtx.createInvite({ role: 'admin', keyPair: memberKp })
  const x = await peer(t, 'inv-limits-x', owner)
  t.teardown(link(first, x))
  await t.exception(x.graph.redeemInvite(forbidden, { timeout: 4000 }), /not granted|timed out/i, 'an invite minted without the right to grant is worthless')

  // Wrong secret: a well-formed link for an invite that doesn't exist.
  const fake = `hypergraph://invite/${ctx}/${crypto.randomBytes(32).toString('hex')}`
  const y = await peer(t, 'inv-limits-y', owner)
  await t.exception(y.graph.redeemInvite(fake, { timeout: 4000 }), /not granted|timed out/i, 'a wrong secret grants nothing')

  // A non-writer's ordinary block is ignored.
  const yCtx = await y.graph.openContext(ctx)
  const p = await y.graph.put({ type: 'post' })
  await y.graph.relate({ from: p.id, to: p.id, type: 'stray', context: ctx })
  await sleep(1500)
  await owner.graph.update()
  t.is(await owner.graph.countEdgesIn(p.id, 'stray', { context: ctx }), 0, 'a stray block from a non-writer is not applied')
  t.absent(yCtx.writable, 'and its author is still not a writer')

  const members = (await owner.ctx.roles()).members
  for (const [name, who] of [['second', second], ['revoked', r], ['x', x], ['y', y]]) t.absent(members[pub(who)], `${name} has no role`)
})

test('invites: two peers racing for the last use — exactly one wins, the same one everywhere', { timeout: 180000 }, async (t) => {
  const { owner } = await ownerWithContext(t, 'inv-race')
  const invite = await owner.ctx.createInvite({ role: 'member', uses: 1, keyPair: owner.kp })
  const p1 = await peer(t, 'inv-race-1', owner)
  const p2 = await peer(t, 'inv-race-2', owner)
  t.teardown(link(p1, p2))

  const results = await Promise.allSettled([
    p1.graph.redeemInvite(invite, { timeout: 8000 }),
    p2.graph.redeemInvite(invite, { timeout: 8000 })
  ])
  t.is(results.filter(r => r.status === 'fulfilled').length, 1, 'exactly one redemption succeeded')

  await until(async () => {
    for (const p of [owner, p1, p2]) await p.graph.update()
    const lengths = await Promise.all([owner, p1, p2].map(async p => (await p.graph.openContext(Hypergraph.parseInvite(invite).context)).base.length))
    return new Set(lengths).size === 1
  })
  const tables = await Promise.all([owner, p1, p2].map(async p => JSON.stringify((await (await p.graph.openContext(Hypergraph.parseInvite(invite).context)).roles()).members)))
  t.is(new Set(tables).size, 1, 'every peer agrees on who got it')
})

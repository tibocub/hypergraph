// v2 invites: one link to join (spec 008, US3, FR-013..018).

const test = require('brittle')
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const { member, link, until } = require('./_helpers')
const { Community } = require('../../../src/v2')
const { decodeLink, encodeLink, makeInvite } = require('../../../src/v2/invites')

const who = (p) => ({ identity: p.pub, encryptionKey: p.community.encryptionKey })

test('v2 invites: links only for what the maker could give; a link carries no key', async (t) => {
  const owner = await member(t, 'inv-refuse-owner')
  const channel = await owner.community.createChannel({ name: 'secret', private: true, keep: true })
  const m = await member(t, 'inv-refuse-m', { key: owner.community.key })
  t.teardown(link(owner, m))
  await until(async () => { await m.community.update(); return m.community.channels().length === 1 })
  await t.exception(m.community.createInvite({ role: 'mod' }), /not allowed/, 'a member can’t invite as mod')
  await t.exception(m.community.createInvite({ channels: [channel] }), /not allowed/, 'nor into a private channel')

  const l = await owner.community.createInvite({ role: 'keeper', channels: [channel], uses: 3 })
  t.ok(l.startsWith('hg2:'))
  const inv = decodeLink(l)
  t.alike(Object.keys(inv).sort(), ['channels', 'community', 'expires', 'id', 'maker', 'role', 'sig', 'uses'], 'only the invite’s fields: no key, sealed or not')
  t.alike(inv.community, owner.community.key)
  t.is(inv.role, 'keeper')
})

test('v2 invites: a link joins a community; a forged one gives nothing', async (t) => {
  const owner = await member(t, 'inv-join-owner')
  const general = await owner.community.createChannel({ name: 'general', keep: true })
  await owner.community.post(general, 'welcome')
  const l = await owner.community.createInvite({})

  const { store, identity } = await member(t, 'inv-join-n-store')
  await store.ready()
  const n = await Community.join(store.namespace('joined'), l, { identity })
  t.teardown(() => n.close())
  t.teardown(link(owner, { community: n }))
  const result = await n.redeem(l, { timeout: 15000 })
  t.ok(result.recorded, 'recorded')
  t.ok(await until(async () => (await n.latest(general)).some(m => m.text === 'welcome')), 'reads the public channel')

  // An invite signed by someone who isn't staff, claiming admin.
  const stranger = hcrypto.keyPair()
  const forged = encodeLink(makeInvite({ community: owner.community.key, role: 'admin' }, stranger))
  const x = await member(t, 'inv-join-x', { key: owner.community.key })
  t.teardown(link(owner, x))
  const r = await x.community.redeem(forged, { timeout: 3000 })
  t.absent(r.recorded, 'the forged invite is never recorded')
  await x.community.update()
  t.is(x.community.role(x.pub), null)
})

test('v2 invites: role and private channel with the maker offline', async (t) => {
  const owner = await member(t, 'inv-offline-owner')
  const channel = await owner.community.createChannel({ name: 'secret', private: true })
  const keeper = await member(t, 'inv-offline-keeper', { key: owner.community.key })
  const admin = await member(t, 'inv-offline-admin', { key: owner.community.key })
  const unlinks = [link(owner, keeper), link(owner, admin), link(keeper, admin)]
  t.teardown(() => unlinks.forEach(u => u()))
  await until(async () => { await keeper.community.update(); await admin.community.update(); return keeper.community.channels().length === 1 && admin.community.channels().length === 1 })
  await owner.community.setRole(keeper.pub, 'keeper', { writer: keeper.community.localKey })
  await owner.community.setRole(admin.pub, 'admin', { writer: admin.community.localKey })
  await until(async () => { await keeper.community.update(); return keeper.community.control.writable })
  await keeper.community.keep(channel)
  await until(async () => { await owner.community.update(); return owner.community.keepers(channel).length === 1 })
  await owner.community.grant(channel, who(admin))
  await until(async () => (await admin.community.access(channel)).current)
  await admin.community.post(channel, 'staff only') // posted by someone who stays online (the owner's own log leaves with it)
  const l = await owner.community.createInvite({ role: 'mod', channels: [channel] })
  unlinks.slice(0, 2).forEach(u => u()) // the maker goes offline

  const n = await member(t, 'inv-offline-n', { key: owner.community.key })
  t.teardown(link(keeper, n))
  t.teardown(link(admin, n))
  const result = await n.community.redeem(l, { timeout: 20000 })
  t.ok(result.recorded, 'recorded by a writer that is online')
  t.is(result.role, 'mod')
  t.ok(await until(async () => { await n.community.update(); return n.community.role(n.pub) === 'mod' && n.community.control.writable }), 'the role applies (and it can write the control log)')
  t.ok(await until(async () => (await n.community.latest(channel)).some(m => m.text === 'staff only'), 20000), 'the key arrives from an online key holder')
})

test('v2 invites: use limits, the same person twice, expiry, revocation, a demoted maker', async (t) => {
  const owner = await member(t, 'inv-limits-owner')
  const other = await member(t, 'inv-limits-other', { key: owner.community.key })
  t.teardown(link(owner, other))
  const join = async (name) => {
    const p = await member(t, `inv-limits-${name}`, { key: owner.community.key })
    t.teardown(link(owner, p))
    return p
  }
  const l = await owner.community.createInvite({ role: 'keeper', uses: 2 })
  const id = b4a.toString(decodeLink(l).id, 'hex')
  const a = await join('a')
  const b = await join('b')
  const c = await join('c')
  t.ok((await a.community.redeem(l, { timeout: 15000 })).recorded, 'first use')
  t.ok((await a.community.redeem(l, { timeout: 15000 })).recorded, 'the same person again: still theirs')
  const results = await Promise.all([b, c].map(p => p.community.redeem(l, { timeout: 6000 })))
  t.is(results.filter(r => r.recorded).length, 1, 'of the next two, one gets the last use')
  t.ok(await until(async () => { await other.community.update(); return other.community.redemptions(id).length === 2 }), 'exactly 2, as another peer sees it too')
  t.alike(other.community.redemptions(id).sort(), owner.community.redemptions(id).sort())

  const expired = await owner.community.createInvite({ role: 'keeper', expires: Date.now() - 1000 })
  const d = await join('d')
  t.absent((await d.community.redeem(expired, { timeout: 3000 })).recorded, 'an expired link gives nothing')

  const revoked = await owner.community.createInvite({ role: 'keeper' })
  await owner.community.revokeInvite(revoked)
  t.absent((await d.community.redeem(revoked, { timeout: 3000 })).recorded, 'a revoked link gives nothing')

  // An admin's link, then the admin is demoted before anyone redeems it.
  await owner.community.setRole(other.pub, 'admin', { writer: other.community.localKey })
  await until(async () => { await other.community.update(); return other.community.role(other.pub) === 'admin' && other.community.control.writable })
  const fromAdmin = await other.community.createInvite({ role: 'mod' })
  await owner.community.setRole(other.pub, null)
  await until(async () => { await other.community.update(); return other.community.role(other.pub) === null })
  t.absent((await d.community.redeem(fromAdmin, { timeout: 3000 })).recorded, 'a demoted maker’s link gives nothing')
  await d.community.update()
  t.is(d.community.role(d.pub), null)
})

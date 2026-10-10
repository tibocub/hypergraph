// Sub-spaces in the decision log (story 8, research.md A13): a sub-space's
// decisions live in its parent's decision log, marked with the sub-space
// (`scoped`), so a parent ban and a sub-space decision are always in one
// order. Its effective state: the parent's members and roles (a private one:
// the parent's owner and admins only), then its own (guests, role overrides);
// nobody banned above; cuts are the union.

const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const { applyNodes, initProof } = require('../../../lib/decisions/apply.js')
const { State } = require('../../../lib/decisions/state.js')
const { Identity } = require('../../../lib/identity.js')
const invites = require('../../../lib/invites.js')
const enc = require('../../../lib/encodings.js')

function memoryView () {
  const map = new Map()
  return {
    map,
    async get (key) { return map.has(key) ? { key, value: map.get(key) } : null },
    async put (key, value) { map.set(key, value) },
    async del (key) { map.delete(key) }
  }
}

const host = { async addWriter () {}, removeable () { return true }, async removeWriter () {} }

async function forum () {
  const owner = await Identity.create({ device: crypto.keyPair() })
  const key = crypto.randomBytes(32)
  const view = memoryView()
  let stamp = 1000
  const apply = async (writer, d, at = stamp++) => {
    await applyNodes([{ from: { key: writer }, value: c.encode(enc.decision, { stamp: at, ...d }) }], view, host, { space: key })
    return State.from(view.map)
  }
  await apply(key, { type: 'space/init', name: 'F', parent: null, private: false, policy: 'auto', version: 1, proof: initProof(owner, key, key) })
  const person = async () => {
    const identity = await Identity.create({ device: crypto.keyPair() })
    return { identity, writer: crypto.randomBytes(32), publicKey: identity.publicKey }
  }
  const claim = (who) => apply(key, { type: 'writer/add', key: who.writer, proof: initProof(who.identity, who.writer, key) })
  const promote = async (who, role) => {
    await apply(key, { type: 'role/set', identity: who.publicKey, role, cut: [] })
    await claim(who)
  }
  // A decision in sub-space `sub` (a key), by `writer`.
  const inSub = (writer, sub, d, at = stamp++) => apply(writer, { type: 'scoped', space: sub, decision: c.encode(enc.decision, { stamp: at, ...d }) }, at)
  const create = (writer, opts = {}, parent = null) => {
    const sub = crypto.randomBytes(32)
    const d = { type: 'subspace/create', key: sub, name: opts.name || 'Sub', private: !!opts.private, writeRoles: opts.writeRoles || [] }
    const done = parent ? inSub(writer, parent, d) : apply(writer, d)
    return done.then((st) => ({ sub, st }))
  }
  const invite = (maker, space, opts = {}) => invites.makeInvite({ space, role: 'member', uses: 1, expires: 0, ...opts }, maker, key)
  const redemption = (inv, who) => c.encode(enc.redemption, invites.makeRedemption(inv, who.identity, who.writer))
  const redeemIn = (recorder, sub, inv, who) => inSub(recorder, sub, { type: 'invite/redeem', redemption: redemption(inv, who) })
  return { owner, key, view, apply, person, claim, promote, inSub, create, invite, redeemIn, state: () => State.from(view.map) }
}

test('who may create a sub-space; sub-spaces nest; a decision for an unknown sub-space counts for nothing', async (t) => {
  const f = await forum()
  const m = await f.person()
  await f.apply(f.key, { type: 'role/set', identity: m.publicKey, role: 'moderator', cut: [] })
  await f.claim(m)
  let { sub: bad, st } = await f.create(m.writer)
  t.absent(st.subspaces.has(b4a.toString(bad, 'hex')), 'a moderator (no decide) can\'t')
  const { sub, st: st2 } = await f.create(f.key, { name: 'News' })
  const info = st2.subspaces.get(b4a.toString(sub, 'hex'))
  t.is(info.name, 'News')
  t.is(info.parent, null, 'a child of the top space')
  const { sub: deep, st: st3 } = await f.create(f.key, { name: 'Deep' }, sub)
  t.is(st3.subspaces.get(b4a.toString(deep, 'hex')).parent, b4a.toString(sub, 'hex'), 'nested under the sub-space')
  t.is(st3.sub(deep).roleOf(f.owner.publicKey), 'owner', 'the owner is owner two levels down')
  const g = await f.person()
  st = await f.redeemIn(f.key, crypto.randomBytes(32), f.invite(f.owner, crypto.randomBytes(32)), g)
  t.absent(st.isMember(g.publicKey), 'nothing in the top space')
  t.is(st.sub(sub).roleOf(g.publicKey), null)
  ;({ st } = await f.create(f.key, { name: 'Again' }))
  t.is(st.subspaces.size, 3, 'the same key twice would be refused; three sub-spaces')
})

test('effective state: parent members and roles, own guests and overrides, write roles', async (t) => {
  const f = await forum()
  const [b, g, m] = [await f.person(), await f.person(), await f.person()]
  await f.apply(f.key, { type: 'role/set', identity: b.publicKey, role: 'member', cut: [] })
  await f.promote(m, 'moderator')
  const { sub } = await f.create(f.key, { name: 'News', writeRoles: ['moderator'] })
  let st = await f.redeemIn(f.key, sub, f.invite(f.owner, sub, { role: 'guest' }), g)
  const news = st.sub(sub)
  t.is(news.roleOf(b.publicKey), 'member', 'a parent member is a member there')
  t.is(news.roleOf(g.publicKey), 'guest', 'the guest is a guest there')
  t.is(st.roleOf(g.publicKey), null, 'and nothing in the parent')
  t.absent(news.canWrite(b.publicKey), 'a member doesn\'t post in a moderators-only sub-space')
  t.absent(news.canWrite(g.publicKey), 'nor a guest')
  t.ok(news.canWrite(m.publicKey), 'a moderator does')
  t.ok(news.canWrite(f.owner.publicKey), 'the owner always does')
  t.is(news.limitOf(b.publicKey, crypto.randomBytes(32)), 0, 'so a member\'s log there counts for nothing')
  st = await f.inSub(f.key, sub, { type: 'role/set', identity: b.publicKey, role: 'moderator', cut: [] })
  t.is(st.sub(sub).roleOf(b.publicKey), 'moderator', 'a role given in the sub-space only')
  t.ok(st.sub(sub).canWrite(b.publicKey))
  t.is(st.roleOf(b.publicKey), 'member', 'unchanged in the parent')
  t.ok(st.writesDecisions(b.publicKey), 'a sub-space moderator records decisions (in the parent\'s log)')
  // A sub-space moderator moderates there, not in the parent.
  await f.claim(b)
  const rec = c.encode(enc.recordId, { log: crypto.randomBytes(32), seq: 3 })
  st = await f.inSub(b.writer, sub, { type: 'moderate', action: 'hide', target: rec, reason: '', cut: [] })
  t.ok(st.sub(sub).moderation(rec).hidden, 'hidden in the sub-space')
  st = await f.apply(b.writer, { type: 'moderate', action: 'hide', target: rec, reason: '', cut: [] })
  t.absent(st.moderation(rec).hidden, 'not in the parent')
})

test('a private sub-space: its own members and the parent\'s owner and admins only', async (t) => {
  const f = await forum()
  const [a, b, g] = [await f.person(), await f.person(), await f.person()]
  await f.promote(a, 'admin')
  await f.apply(f.key, { type: 'role/set', identity: b.publicKey, role: 'member', cut: [] })
  const { sub } = await f.create(f.key, { name: 'Staff', private: true })
  let st = f.state()
  const staff = st.sub(sub)
  t.ok(staff.private)
  t.is(staff.roleOf(f.owner.publicKey), 'owner')
  t.is(staff.roleOf(a.publicKey), 'admin', 'parent admins are in')
  t.is(staff.roleOf(b.publicKey), null, 'a plain member of the parent isn\'t')
  st = await f.redeemIn(a.writer, sub, f.invite(a.identity, sub, { role: 'member' }), g)
  t.is(st.sub(sub).roleOf(g.publicKey), 'member', 'invited in')
  t.absent(st.isMember(g.publicKey), 'not in the parent')
})

test('a parent ban applies below, whichever came first; a parent removal takes sub-space roles away', async (t) => {
  // Invited in the sub-space, then banned in the parent.
  const f = await forum()
  const [g, h, x] = [await f.person(), await f.person(), await f.person()]
  const { sub } = await f.create(f.key, { name: 'Guests' })
  const log = crypto.randomBytes(32)
  const parentLog = crypto.randomBytes(32)
  let st = await f.redeemIn(f.key, sub, f.invite(f.owner, sub, { role: 'guest' }), g)
  t.is(st.sub(sub).roleOf(g.publicKey), 'guest')
  st = await f.apply(f.key, { type: 'moderate', action: 'ban', target: g.publicKey, reason: 'spam', cut: [{ log, length: 4 }] })
  t.is(st.sub(sub).roleOf(g.publicKey), null, 'out of the sub-space too, though the sub-space invited them')
  t.ok(st.sub(sub).isBanned(g.publicKey))
  t.is(st.sub(sub).limitOf(g.publicKey, log), 4, 'their sub-space log counts up to the cut the ban carried')
  t.is(st.sub(sub).limitOf(g.publicKey, crypto.randomBytes(32)), 0, 'a log the ban didn\'t name: nothing')

  // Banned first, invited after: refused.
  await f.apply(f.key, { type: 'moderate', action: 'ban', target: h.publicKey, reason: '', cut: [] })
  st = await f.redeemIn(f.key, sub, f.invite(f.owner, sub, { role: 'guest' }), h)
  t.is(st.sub(sub).roleOf(h.publicKey), null, 'a banned person can\'t be let into a sub-space')
  st = await f.inSub(f.key, sub, { type: 'role/set', identity: h.publicKey, role: 'member', cut: [] })
  t.is(st.sub(sub).roleOf(h.publicKey), null, 'nor given a role there')

  // Cuts: the union, lowest per log.
  await f.inSub(f.key, sub, { type: 'role/set', identity: x.publicKey, role: 'member', cut: [] })
  await f.inSub(f.key, sub, { type: 'moderate', action: 'ban', target: x.publicKey, reason: '', cut: [{ log, length: 9 }] })
  st = await f.apply(f.key, { type: 'moderate', action: 'ban', target: x.publicKey, reason: '', cut: [{ log, length: 6 }, { log: parentLog, length: 2 }] })
  t.is(st.sub(sub).limitOf(x.publicKey, log), 6, 'the lower of the two cuts')

  // A removal from the parent: the member's own roles below go.
  const [mm] = [await f.person()]
  await f.apply(f.key, { type: 'role/set', identity: mm.publicKey, role: 'member', cut: [] })
  await f.inSub(f.key, sub, { type: 'role/set', identity: mm.publicKey, role: 'moderator', cut: [] })
  st = await f.apply(f.key, { type: 'member/remove', identity: mm.publicKey, cut: [] })
  t.is(st.sub(sub).roleOf(mm.publicKey), null, 'removed from the parent: out of the sub-space too')
  t.absent(st.writesDecisions(mm.publicKey), 'and no longer records decisions')
})

test('decisions in a sub-space by a parent admin demoted later stay valid (FR-019); after, they count for nothing', async (t) => {
  const f = await forum()
  const [a, g1, g2] = [await f.person(), await f.person(), await f.person()]
  await f.promote(a, 'admin')
  const { sub } = await f.create(f.key, { name: 'Guests' })
  let st = await f.redeemIn(a.writer, sub, f.invite(a.identity, sub, { role: 'guest', uses: 0 }), g1)
  t.is(st.sub(sub).roleOf(g1.publicKey), 'guest', 'let in by the admin')
  await f.apply(f.key, { type: 'role/set', identity: a.publicKey, role: 'member', cut: [] })
  st = f.state()
  t.is(st.sub(sub).roleOf(g1.publicKey), 'guest', 'still in after the admin\'s demotion')
  st = await f.inSub(a.writer, sub, { type: 'role/set', identity: g2.publicKey, role: 'member', cut: [] })
  t.is(st.sub(sub).roleOf(g2.publicKey), null, 'the demoted admin\'s later decision counts for nothing')
})

test('key/rotate in a private sub-space: the next epoch only, by who may decide or moderate; a rotation that lost a race stays readable', async (t) => {
  const f = await forum()
  const [a, m] = [await f.person(), await f.person()]
  await f.promote(a, 'admin')
  await f.apply(f.key, { type: 'role/set', identity: m.publicKey, role: 'member', cut: [] })
  await f.claim(m)
  const { sub } = await f.create(f.key, { name: 'Staff', private: true })
  const { sub: open } = await f.create(f.key, { name: 'Open' })
  const commit = () => crypto.randomBytes(32)
  const c0 = commit()
  let st = await f.inSub(f.key, sub, { type: 'key/rotate', epoch: 0, commit: c0 })
  t.alike(st.sub(sub).keys, { current: 0, commits: { 0: b4a.toString(c0, 'hex') }, others: {} }, 'epoch 0')
  st = await f.inSub(f.key, sub, { type: 'key/rotate', epoch: 2, commit: commit() })
  t.is(st.sub(sub).keys.current, 0, 'an epoch that skips one is ignored')
  const lost = commit()
  st = await f.inSub(a.writer, sub, { type: 'key/rotate', epoch: 0, commit: lost })
  t.is(st.sub(sub).keys.commits[0], b4a.toString(c0, 'hex'), 'the first in the order stays current')
  t.is(st.sub(sub).keys.others[b4a.toString(lost, 'hex')], 0, 'the other is kept as readable')
  st = await f.inSub(m.writer, sub, { type: 'key/rotate', epoch: 1, commit: commit() })
  t.is(st.sub(sub).keys.current, 0, 'a plain member can\'t rotate')
  st = await f.inSub(f.key, open, { type: 'key/rotate', epoch: 0, commit: commit() })
  t.is(st.sub(open).keys, null, 'nor anyone in a sub-space that isn\'t private')
})

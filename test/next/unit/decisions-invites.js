// Invites in the decision log (spec 008's design, research R16, story 4):
// revocation, uses per distinct person, expiry against the recorder's stamp,
// who may invite to what, roles never lowered, and the reason a newcomer is
// refused (State.inviteRefusal), the same checks apply makes.

const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const { applyNodes, initProof } = require('../../../lib/decisions/apply.js')
const { State, mayInvite } = require('../../../lib/decisions/state.js')
const { Identity } = require('../../../lib/identity.js')
const invites = require('../../../lib/invites.js')
const enc = require('../../../lib/encodings.js')

const hex = (b) => b4a.toString(b, 'hex')

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

async function space () {
  const owner = await Identity.create({ device: crypto.keyPair() })
  const key = crypto.randomBytes(32)
  const view = memoryView()
  let stamp = 1000
  const apply = async (writer, d, at = stamp++) => {
    await applyNodes([{ from: { key: writer }, value: c.encode(enc.decision, { stamp: at, ...d }) }], view, host, { space: key })
    return State.from(view.map)
  }
  await apply(key, { type: 'space/init', name: 'F', parent: null, private: false, policy: 'auto', version: 1, proof: initProof(owner, key, key) })
  // Someone new, and their device's key in the decision log.
  const person = async () => {
    const identity = await Identity.create({ device: crypto.keyPair() })
    return { identity, writer: crypto.randomBytes(32), publicKey: identity.publicKey }
  }
  // `who` gets `role` from the owner and, if it records decisions, claims its key.
  const promote = async (who, role) => {
    await apply(key, { type: 'role/set', identity: who.publicKey, role, cut: [] })
    await apply(key, { type: 'writer/add', key: who.writer, proof: initProof(who.identity, who.writer, key) })
  }
  const invite = (maker, opts = {}) => invites.makeInvite({ space: key, role: 'member', uses: 1, expires: 0, ...opts }, maker)
  const redeem = (recorder, inv, who, at) => apply(recorder, { type: 'invite/redeem', redemption: c.encode(enc.redemption, invites.makeRedemption(inv, who.identity, who.writer)) }, at)
  const revoke = (recorder, inv) => apply(recorder, { type: 'invite/revoke', invite: c.encode(enc.invite, inv) })
  return { owner, key, view, apply, person, promote, invite, redeem, revoke, state: () => State.from(view.map) }
}

test('a revoked invite lets no one else in; the maker or an admin revokes, nobody else', async (t) => {
  const s = await space()
  const b = await s.person()
  await s.promote(b, 'admin')
  const inv = s.invite(b.identity, { uses: 0 })
  const [c1, c2, c3] = [await s.person(), await s.person(), await s.person()]
  let st = await s.redeem(s.key, inv, c1)
  t.is(st.roleOf(c1.publicKey), 'member', 'an open invite lets someone in')

  const m = await s.person()
  await s.promote(m, 'moderator')
  st = await s.revoke(m.writer, inv)
  t.absent(st.isRevoked(inv.id), 'a moderator who did not make it can\'t revoke it')
  st = await s.revoke(b.writer, inv)
  t.ok(st.isRevoked(inv.id), 'its maker revokes it')
  st = await s.redeem(s.key, inv, c2)
  t.is(st.roleOf(c2.publicKey), null, 'nobody else gets in with it')
  t.is(st.roleOf(c1.publicKey), 'member', 'who came in stays')

  const other = s.invite(b.identity)
  st = await s.revoke(s.key, other)
  t.ok(st.isRevoked(other.id), 'the owner (decide) revokes anyone\'s invite')
  st = await s.redeem(s.key, other, c3)
  t.is(st.roleOf(c3.publicKey), null)
})

test('uses count distinct people; expiry is judged by the recorder\'s stamp', async (t) => {
  const s = await space()
  const inv = s.invite(s.owner, { uses: 2 })
  const [a, b, c1] = [await s.person(), await s.person(), await s.person()]
  await s.redeem(s.key, inv, a)
  await s.redeem(s.key, inv, a)
  let st = await s.redeem(s.key, inv, b)
  t.is(st.roleOf(b.publicKey), 'member', 'the same person twice uses one')
  st = await s.redeem(s.key, inv, c1)
  t.is(st.roleOf(c1.publicKey), null, 'used up')

  const soon = s.invite(s.owner, { uses: 0, expires: 5000 })
  const [d, e] = [await s.person(), await s.person()]
  st = await s.redeem(s.key, soon, d, 4999)
  t.is(st.roleOf(d.publicKey), 'member', 'recorded before it expires')
  st = await s.redeem(s.key, soon, e, 5001)
  t.is(st.roleOf(e.publicKey), null, 'recorded after: refused')
})

test('who may invite to what', async (t) => {
  const roles = new Map([['inviter', ['post', 'invite']], ['helper', ['post', 'edit-pages']], ['deputy', ['post', 'moderate']], ['warden', ['post', 'invite', 'moderate']]])
  t.ok(mayInvite('owner', 'admin', roles), 'the owner invites admins')
  t.absent(mayInvite('owner', 'owner', roles), 'never to owner')
  t.ok(mayInvite('admin', 'moderator', roles), 'an admin invites moderators')
  t.absent(mayInvite('admin', 'admin', roles), 'not its own rank')
  t.ok(mayInvite('admin', 'helper', roles), 'an app role')
  t.ok(mayInvite('admin', 'deputy', roles), 'an admin holds moderate')
  t.absent(mayInvite('moderator', 'member', roles), 'a moderator can\'t invite')
  t.ok(mayInvite('inviter', 'member', roles), 'a role with invite invites members, at its own rank')
  t.ok(mayInvite('inviter', 'guest', roles))
  t.absent(mayInvite('inviter', 'moderator', roles), 'nothing above it')
  t.absent(mayInvite('inviter', 'deputy', roles), 'nor a permission it lacks')
  t.ok(mayInvite('inviter', 'inviter', roles), 'its own role, which has no power over others (F6: friends invite friends)')
  t.absent(mayInvite('warden', 'warden', roles), 'not its own role if it moderates: nobody mints moderators')
  t.absent(mayInvite('admin', 'admin', roles), 'nor admins')
  t.absent(mayInvite('admin', 'nope', roles), 'nor a role that does not exist')

  const s = await space()
  const b = await s.person()
  await s.promote(b, 'admin')
  const above = s.invite(b.identity, { role: 'admin' })
  const who = await s.person()
  const st = await s.redeem(s.key, above, who)
  t.is(st.roleOf(who.publicKey), null, 'a link made anyway is refused at redemption')
})

test('a redemption never lowers a role', async (t) => {
  const s = await space()
  const m = await s.person()
  await s.promote(m, 'moderator')
  const st = await s.redeem(s.key, s.invite(s.owner), m)
  t.is(st.roleOf(m.publicKey), 'moderator')
})

test('the reason a newcomer is refused, from its own copy of the decisions', async (t) => {
  const s = await space()
  const who = await s.person()
  const at = 2000
  t.is(s.state().inviteRefusal(s.invite(s.owner), who.publicKey, at), null, 'a good invite')
  t.is(s.state().inviteRefusal(s.invite(s.owner, { expires: 1000 }), who.publicKey, at), 'INVITE_EXPIRED')
  const used = s.invite(s.owner)
  await s.redeem(s.key, used, await s.person())
  t.is(s.state().inviteRefusal(used, who.publicKey, at), 'INVITE_USED_UP')
  const revoked = s.invite(s.owner, { uses: 0 })
  await s.revoke(s.key, revoked)
  t.is(s.state().inviteRefusal(revoked, who.publicKey, at), 'INVITE_REVOKED')
  const m = await s.person()
  await s.promote(m, 'moderator')
  t.is(s.state().inviteRefusal(s.invite(m.identity), who.publicKey, at), 'NOT_ALLOWED', 'a maker who can\'t invite')
  await s.apply(s.key, { type: 'moderate', action: 'ban', target: who.publicKey, reason: '', cut: [] })
  t.is(s.state().inviteRefusal(s.invite(s.owner), who.publicKey, at), 'NOT_ALLOWED', 'banned')
  t.ok(hex(who.publicKey))
})

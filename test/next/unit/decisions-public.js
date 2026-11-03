// Public spaces (spec 016, research R2, R3): `settings/set { public: true }`
// by who may decide makes a scope public for good; there an identity the
// decision log doesn't name counts as `member` unless banned.

const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const enc = require('../../../lib/encodings.js')
const { applyNodes, initProof } = require('../../../lib/decisions/apply.js')
const { State, touched } = require('../../../lib/decisions/state.js')
const { Identity } = require('../../../lib/identity.js')

const hex = (b) => b4a.toString(b, 'hex')

async function setup () {
  const map = new Map()
  const view = { get: async (k) => (map.has(k) ? { key: k, value: map.get(k) } : null), put: async (k, v) => { map.set(k, v) }, del: async (k) => { map.delete(k) } }
  let stamp = 1
  const owner = await Identity.create({ device: crypto.keyPair() })
  const space = crypto.randomBytes(32)
  const apply = (writer, d) => applyNodes([{ from: { key: writer }, value: c.encode(enc.decision, { stamp: stamp++, ...d }) }], view, null, { space })
  await apply(space, { type: 'space/init', name: 'Open', parent: null, private: false, policy: 'auto', version: 1, proof: initProof(owner, space, space) })
  // a writer key speaking for an identity with `role`
  const writerOf = async (role) => {
    const w = crypto.randomBytes(32)
    const id = crypto.randomBytes(32)
    map.set(`writer:${hex(w)}`, { identity: hex(id) })
    map.set(`member:${hex(id)}`, { role, by: '', stamp: 0 })
    return w
  }
  const settings = (more) => ({ type: 'settings/set', policy: null, writeLimit: null, rules: null, ...more })
  const inSub = (sub, d) => ({ type: 'scoped', space: sub, decision: c.encode(enc.decision, { stamp: stamp++, ...d }) })
  return { map, apply, space, owner, writerOf, settings, inSub, state: () => State.from(map) }
}

test('settings/set public: true by an owner or admin counts; by a member it doesn\'t', async (t) => {
  const s = await setup()
  t.is(s.state().public, false, 'not public at first')
  const member = await s.writerOf('member')
  await s.apply(member, s.settings({ public: true }))
  t.is(s.state().public, false, 'a member may not')
  const moderator = await s.writerOf('moderator')
  await s.apply(moderator, s.settings({ public: true }))
  t.is(s.state().public, false, 'a moderator may not')
  const admin = await s.writerOf('admin')
  await s.apply(admin, s.settings({ public: true }))
  t.is(s.state().public, true, 'an admin may')
  t.is(s.state().policy, 'auto', 'other settings stay')
})

test('public: false on a public scope doesn\'t count and leaves it public', async (t) => {
  const s = await setup()
  await s.apply(s.space, s.settings({ public: true }))
  t.is(s.state().public, true)
  await s.apply(s.space, s.settings({ public: false }))
  t.is(s.state().public, true, 'the door can\'t be closed')
  const list = [...s.map].filter(([k]) => k.startsWith('~log:')).map(([, v]) => v)
  const last = list[list.length - 1]
  t.is(last.type, 'settings/set')
  t.is(last.counted, false, 'listed as not counted')
  t.is(list[list.length - 2].public, true, 'the decision list shows it')
  await s.apply(s.space, s.settings({ writeLimit: { records: 5, periodMs: 1000 } }))
  t.is(s.state().public, true, 'a later setting (public absent) leaves it public')
})

test('old settings/set decisions decode with public absent', async (t) => {
  const d = c.decode(enc.decision, c.encode(enc.decision, { type: 'settings/set', stamp: 1, policy: 'auto', writeLimit: null, rules: null }))
  t.is(d.public, null)
  t.is(c.decode(enc.decision, c.encode(enc.decision, { type: 'settings/set', stamp: 1, policy: null, writeLimit: null, rules: null, public: true })).public, true)
  t.is(c.decode(enc.decision, c.encode(enc.decision, { type: 'settings/set', stamp: 1, policy: null, writeLimit: null, rules: null, public: false })).public, false)
})

test('scoped to a sub-space: public there only, not inherited either way', async (t) => {
  const s = await setup()
  const sub = crypto.randomBytes(32)
  const other = crypto.randomBytes(32)
  await s.apply(s.space, { type: 'subspace/create', key: sub, name: 'Open sub', private: false, writeRoles: [] })
  await s.apply(s.space, { type: 'subspace/create', key: other, name: 'Staff', private: false, writeRoles: [] })
  await s.apply(s.space, s.inSub(sub, s.settings({ public: true })))
  const st = s.state()
  t.is(st.public, false, 'the top space stays closed')
  t.is(st.sub(sub).public, true)
  const stranger = crypto.randomBytes(32)
  t.is(st.sub(sub).roleOf(stranger), 'member', 'anyone writes in the public sub-space')
  t.is(st.roleOf(stranger), null, 'not in the top space')
  await s.apply(s.space, s.settings({ public: true }))
  t.is(s.state().sub(other).public, false, 'a public top space doesn\'t make its sub-spaces public')
  t.is(s.state().sub(other).roleOf(stranger), null)
})

test('roleOf falls back to member in a public space only; bans and recorded roles win', async (t) => {
  const s = await setup()
  const stranger = crypto.randomBytes(32)
  const banned = crypto.randomBytes(32)
  t.is(s.state().roleOf(stranger), null, 'not public: nobody unrecorded')
  t.absent(s.state().isMember(stranger))
  await s.apply(s.space, s.settings({ public: true }))
  const mod = await s.writerOf('moderator')
  await s.apply(mod, { type: 'moderate', action: 'ban', target: banned, reason: 'spam', cut: [] })
  const st = s.state()
  t.is(st.roleOf(stranger), 'member', 'an unrecorded identity is a member')
  t.ok(st.isMember(stranger))
  t.ok(st.canWrite(stranger))
  t.is(st.limitOf(stranger, crypto.randomBytes(32)), Infinity)
  t.absent(st.isRecorded(stranger), 'but not recorded')
  t.is(st.roleOf(banned), null, 'a banned identity gets nothing')
  t.is(st.limitOf(banned, crypto.randomBytes(32)), 0)
  t.is(st.roleOf(hex(s.owner.publicKey)), 'owner', 'a recorded role wins')
  t.ok(st.isRecorded(s.owner.publicKey))
})

test('mustAdmit is false for fallback members (a public space lets anyone back in)', async (t) => {
  const s = await setup()
  const who = crypto.randomBytes(32)
  const oldLog = crypto.randomBytes(32)
  s.map.set(`member:${hex(who)}`, { role: 'member', by: '', stamp: 0 })
  await s.apply(s.space, { type: 'member/remove', identity: who, cut: [{ log: oldLog, length: 3 }] })
  const before = s.state()
  t.is(before.roleOf(who), null, 'removed')
  t.is(before.limitOf(who, oldLog), 3, 'its log is cut')
  await s.apply(s.space, s.settings({ public: true }))
  const st = s.state()
  t.is(st.roleOf(who), 'member', 'back as a public member')
  t.is(st.limitOf(who, oldLog), 3, 'the cut stays')
  const fresh = crypto.randomBytes(32)
  t.absent(st.mustAdmit(who, fresh), 'a new log needs no admission code')
  t.is(st.limitOf(who, fresh), Infinity, 'and counts')
})

test('touched() marks all when public changes', async (t) => {
  t.ok(touched(['meta']).all)
  t.ok(touched([`sub:${'a'.repeat(64)}:meta`]).all)
})

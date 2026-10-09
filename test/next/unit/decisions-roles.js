// Roles and moderation in the decision log (research R8, story 2): built-in
// and custom roles, a decision valid only if its author held the permission
// at that point of the order, bans with cuts, writers of the decision log.
// Applied to an in-memory view, the way every member applies them.

const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const { applyNodes, initProof } = require('../../../lib/decisions/apply.js')
const { State } = require('../../../lib/decisions/state.js')
const { Identity } = require('../../../lib/identity.js')
const enc = require('../../../lib/encodings.js')

const hex = (b) => b4a.toString(b, 'hex')

function memoryView () {
  const map = new Map()
  return {
    map,
    async get (key) { return map.has(key) ? { key, value: map.get(key) } : null },
    async put (key, value) { map.set(key, value) },
    async del (key) { map.delete(key) },
    dump () { return JSON.stringify([...map].sort()) }
  }
}

// A space with an owner, and helpers to apply decisions as someone.
async function space () {
  const owner = await Identity.create({ device: crypto.keyPair() })
  const key = crypto.randomBytes(32)
  const view = memoryView()
  const added = []
  const host = { addWriter: async (k) => { added.push(hex(k)) } }
  let stamp = 1
  const apply = async (writer, d) => {
    await applyNodes([{ from: { key: writer }, value: c.encode(enc.decision, { stamp: stamp++, ...d }) }], view, host, { space: key })
    return State.from(view.map)
  }
  await apply(key, { type: 'space/init', name: 'F', parent: null, private: false, policy: 'auto', version: 1, proof: initProof(owner, key, key) })
  // A member with a writer key of their own (as a redemption brings it).
  const member = async (role = 'member') => {
    const identity = crypto.randomBytes(32)
    const writer = crypto.randomBytes(32)
    await view.put(`member:${hex(identity)}`, { role, by: '', stamp: 0, writer: hex(writer) })
    if (role !== 'member') await view.put(`writer:${hex(writer)}`, { identity: hex(identity) })
    return { identity, writer }
  }
  return { owner, key, view, added, apply, member, state: () => State.from(view.map) }
}

const recordId = () => enc.idBytes({ log: crypto.randomBytes(32), seq: 1 })

test('built-in roles and their permissions', async (t) => {
  const s = await space()
  const st = s.state()
  t.ok(st.can(s.owner.publicKey, 'decide') && st.can(s.owner.publicKey, 'moderate') && st.can(s.owner.publicKey, 'roles'))
  const admin = await s.member('admin')
  const mod = await s.member('moderator')
  const m = await s.member('member')
  const g = await s.member('guest')
  const now = s.state()
  t.ok(now.can(admin.identity, 'decide') && now.can(admin.identity, 'roles') && now.can(admin.identity, 'moderate'))
  t.ok(now.can(mod.identity, 'moderate') && !now.can(mod.identity, 'decide') && !now.can(mod.identity, 'roles'))
  t.ok(now.can(m.identity, 'post') && !now.can(m.identity, 'moderate'))
  t.ok(now.can(g.identity, 'post'))
})

test('setRole: who may give which role; v1 meanings', async (t) => {
  const s = await space()
  const admin = await s.member('admin')
  const m = await s.member()
  const outsider = crypto.randomBytes(32)

  let st = await s.apply(admin.writer, { type: 'role/set', identity: m.identity, role: 'moderator', cut: [] })
  t.is(st.roleOf(m.identity), 'moderator', 'an admin makes a moderator')
  t.ok(s.added.includes(hex(m.writer)), 'a moderator becomes a writer of the decision log')
  st = await s.apply(admin.writer, { type: 'role/set', identity: m.identity, role: 'admin', cut: [] })
  t.is(st.roleOf(m.identity), 'moderator', 'an admin cannot make admins')
  st = await s.apply(s.key, { type: 'role/set', identity: m.identity, role: 'admin', cut: [] })
  t.is(st.roleOf(m.identity), 'admin', 'the owner can')
  st = await s.apply(admin.writer, { type: 'role/set', identity: m.identity, role: 'member', cut: [] })
  t.is(st.roleOf(m.identity), 'admin', 'an admin cannot demote another admin')
  st = await s.apply(s.key, { type: 'role/set', identity: s.owner.publicKey, role: 'member', cut: [] })
  t.is(st.roleOf(s.owner.publicKey), 'owner', 'nobody changes the owner')
  st = await s.apply(s.key, { type: 'role/set', identity: outsider, role: 'member', cut: [] })
  t.is(st.roleOf(outsider), 'member', 'setRole on a non-member adds them (v1)')
  st = await s.apply(s.key, { type: 'role/set', identity: outsider, role: 'nope', cut: [] })
  t.is(st.roleOf(outsider), 'member', 'an unknown role is ignored')
})

test('custom roles: defined with permission lists, given like built-in ones', async (t) => {
  const s = await space()
  const admin = await s.member('admin')
  const m = await s.member()
  let st = await s.apply(admin.writer, { type: 'role/define', name: 'editor', permissions: ['post', 'edit-pages'] })
  t.alike(st.permissionsOf('editor'), ['post', 'edit-pages'])
  st = await s.apply(admin.writer, { type: 'role/set', identity: m.identity, role: 'editor', cut: [] })
  t.is(st.roleOf(m.identity), 'editor')
  t.ok(st.can(m.identity, 'edit-pages') && st.can(m.identity, 'post') && !st.can(m.identity, 'moderate'))

  st = await s.apply(admin.writer, { type: 'role/define', name: 'admin', permissions: ['post'] })
  t.alike(st.permissionsOf('admin'), ['decide', 'moderate', 'invite', 'roles', 'post'], 'built-in roles cannot be redefined')
  const mod = await s.member('moderator')
  st = await s.apply(mod.writer, { type: 'role/define', name: 'x', permissions: ['post'] })
  t.is(st.permissionsOf('x'), null, 'defining roles needs the roles permission')
  st = await s.apply(admin.writer, { type: 'role/define', name: 'editor', permissions: ['post', 'edit-pages', 'tag'] })
  t.alike(st.permissionsOf('editor'), ['post', 'edit-pages', 'tag'], 'a custom role gains permissions')
  st = await s.apply(admin.writer, { type: 'role/define', name: 'editor', permissions: ['edit-pages'] })
  t.alike(st.permissionsOf('editor'), ['post', 'edit-pages', 'tag'], 'but never loses post (that would need a cut per holder)')
})

test('a decision counts only if its author held the permission at that point', async (t) => {
  const s = await space()
  const mod = await s.member('moderator')
  const first = recordId()
  const second = recordId()
  let st = await s.apply(mod.writer, { type: 'moderate', action: 'hide', target: first, reason: '', cut: [] })
  t.ok(st.moderation(first).hidden, 'a moderator hides')
  st = await s.apply(s.key, { type: 'role/set', identity: mod.identity, role: 'member', cut: [] })
  st = await s.apply(mod.writer, { type: 'moderate', action: 'hide', target: second, reason: '', cut: [] })
  t.absent(st.moderation(second).hidden, 'once demoted, their decisions are ignored')
  t.ok(st.moderation(first).hidden, 'their earlier ones stay')
  const m = await s.member()
  st = await s.apply(m.writer, { type: 'moderate', action: 'hide', target: second, reason: '', cut: [] })
  t.absent(st.moderation(second).hidden, 'a member does not moderate')
})

test('moderation: flag, hide, reveal, remove (for good)', async (t) => {
  const s = await space()
  const id = recordId()
  let st = await s.apply(s.key, { type: 'moderate', action: 'flag', target: id, reason: 'look', cut: [] })
  t.alike(st.moderation(id), { flagged: true, hidden: false, removed: false })
  st = await s.apply(s.key, { type: 'moderate', action: 'hide', target: id, reason: '', cut: [] })
  t.ok(st.moderation(id).hidden)
  st = await s.apply(s.key, { type: 'moderate', action: 'reveal', target: id, reason: '', cut: [] })
  t.absent(st.moderation(id).hidden, 'revealed')
  st = await s.apply(s.key, { type: 'moderate', action: 'remove', target: id, reason: '', cut: [] })
  st = await s.apply(s.key, { type: 'moderate', action: 'reveal', target: id, reason: '', cut: [] })
  t.ok(st.moderation(id).removed, 'a removal is for good')
  st = await s.apply(s.key, { type: 'moderate', action: 'shout', target: id, reason: '', cut: [] })
  t.ok(st.moderation(id).removed, 'unknown actions are ignored')
})

test('a ban takes them out with a cut, for good; ranks hold', async (t) => {
  const s = await space()
  const mod = await s.member('moderator')
  const admin = await s.member('admin')
  const spammer = await s.member()
  const log = crypto.randomBytes(32)
  let st = await s.apply(mod.writer, { type: 'moderate', action: 'ban', target: admin.identity, reason: '', cut: [] })
  t.is(st.roleOf(admin.identity), 'admin', 'a moderator cannot ban an admin')
  st = await s.apply(mod.writer, { type: 'moderate', action: 'ban', target: s.owner.publicKey, reason: '', cut: [] })
  t.is(st.roleOf(s.owner.publicKey), 'owner', 'nobody bans the owner')

  st = await s.apply(mod.writer, { type: 'moderate', action: 'ban', target: spammer.identity, reason: 'spam', cut: [{ log, length: 5 }] })
  t.absent(st.isMember(spammer.identity), 'banned: no longer a member')
  t.ok(st.isBanned(spammer.identity))
  t.is(st.limitOf(spammer.identity, log), 5, 'their log counts up to the moderator\'s cut')
  t.is(st.limitOf(spammer.identity, crypto.randomBytes(32)), 0, 'a log the moderator didn\'t hold counts for nothing')

  st = await s.apply(s.key, { type: 'role/set', identity: spammer.identity, role: 'member', cut: [] })
  t.absent(st.isMember(spammer.identity), 'a banned identity is not let back in by setRole')
  st = await s.apply(s.key, { type: 'member/remove', identity: spammer.identity, cut: [{ log, length: 9 }] })
  t.is(st.limitOf(spammer.identity, log), 5, 'a later decision never widens a cut')
})

test('losing the right to write through a role records a cut', async (t) => {
  const s = await space()
  const m = await s.member()
  const log = crypto.randomBytes(32)
  await s.apply(s.key, { type: 'role/define', name: 'reader', permissions: [] })
  let st = await s.apply(s.key, { type: 'role/set', identity: m.identity, role: 'reader', cut: [{ log, length: 3 }] })
  t.absent(st.canWrite(m.identity))
  t.is(st.limitOf(m.identity, log), 3)
  st = await s.apply(s.key, { type: 'role/set', identity: m.identity, role: 'member', cut: [] })
  t.ok(st.canWrite(m.identity), 'may write again')
  t.is(st.limitOf(m.identity, log), 3, 'the old log keeps its cut')
  t.is(st.limitOf(m.identity, crypto.randomBytes(32)), Infinity, 'a new log counts')
})

test('decisions apply in their order: a demoted moderator cannot ban afterwards', async (t) => {
  const s = await space()
  const mod = await s.member('moderator')
  const m = await s.member()
  const hidden = recordId()
  await s.apply(s.key, { type: 'role/define', name: 'editor', permissions: ['post', 'edit-pages'] })
  await s.apply(s.key, { type: 'role/set', identity: m.identity, role: 'editor', cut: [] })
  await s.apply(mod.writer, { type: 'moderate', action: 'hide', target: hidden, reason: '', cut: [] })
  await s.apply(s.key, { type: 'role/set', identity: mod.identity, role: 'member', cut: [] })
  const st = await s.apply(mod.writer, { type: 'moderate', action: 'ban', target: m.identity, reason: '', cut: [] })
  t.is(st.roleOf(m.identity), 'editor', 'the ban came after the demotion: ignored')
  t.ok(st.moderation(hidden).hidden, 'the hide came before: it stays')
})

test('unban: lifts the ban, keeps its cut; not by someone below who banned', async (t) => {
  const s = await space()
  const admin = await s.member('admin')
  const mod = await s.member('moderator')
  const m = await s.member()
  const log = crypto.randomBytes(32)
  let st = await s.apply(admin.writer, { type: 'moderate', action: 'ban', target: m.identity, reason: 'spam', cut: [{ log, length: 4 }] })
  t.ok(st.isBanned(m.identity))
  st = await s.apply(mod.writer, { type: 'moderate', action: 'unban', target: m.identity, reason: '', cut: [] })
  t.ok(st.isBanned(m.identity), 'a moderator can\'t lift an admin\'s ban')
  st = await s.apply(admin.writer, { type: 'moderate', action: 'unban', target: m.identity, reason: '', cut: [] })
  t.absent(st.isBanned(m.identity), 'the admin lifts it')
  t.absent(st.isMember(m.identity), 'unbanned is not let back in yet')
  t.is(st.limitOf(m.identity, log), 4, 'the ban\'s cut stays: what was written during the ban never counts')
  st = await s.apply(admin.writer, { type: 'member/add', identity: m.identity })
  t.ok(st.isMember(m.identity), 'an admin lets them back in')
  t.is(st.limitOf(m.identity, log), 4, 'the old log keeps its cut')
  t.is(st.limitOf(m.identity, crypto.randomBytes(32)), Infinity, 'a new log counts')
})

test('losing an app permission through a role records an edit cut (research.md A9)', async (t) => {
  const s = await space()
  const m = await s.member()
  const log = crypto.randomBytes(32)
  await s.apply(s.key, { type: 'role/define', name: 'editor', permissions: ['post', 'edit-pages'] })
  let st = await s.apply(s.key, { type: 'role/set', identity: m.identity, role: 'editor', cut: [{ log, length: 2 }] })
  t.is(st.editLimit(m.identity, 'edit-pages', log), Infinity, 'given it: no cut')
  st = await s.apply(s.key, { type: 'role/set', identity: m.identity, role: 'member', cut: [{ log, length: 6 }] })
  t.ok(st.canWrite(m.identity), 'still posts')
  t.is(st.limitOf(m.identity, log), Infinity, 'its posts are not cut')
  t.is(st.editLimit(m.identity, 'edit-pages', log), 6, 'its edits are, where the decider held the log')
  t.is(st.editLimit(m.identity, 'edit-pages', crypto.randomBytes(32)), 0, 'a log the cut does not name counts for nothing')
  st = await s.apply(s.key, { type: 'role/set', identity: m.identity, role: 'editor', cut: [{ log, length: 9 }] })
  t.is(st.editLimit(m.identity, 'edit-pages', log), 6, 'given back: the old log keeps its cut')
  t.is(st.editLimit(m.identity, 'edit-pages', crypto.randomBytes(32)), Infinity, 'a new log counts')
  st = await s.apply(s.key, { type: 'role/set', identity: m.identity, role: 'member', cut: [{ log, length: 12 }] })
  t.is(st.editLimit(m.identity, 'edit-pages', log), 6, 'a log\'s first cut stays')
})

test('a custom role never loses an app permission; hypergraph\'s own decision rights it may', async (t) => {
  const s = await space()
  let st = await s.apply(s.key, { type: 'role/define', name: 'editor', permissions: ['post', 'edit-pages', 'moderate'] })
  st = await s.apply(s.key, { type: 'role/define', name: 'editor', permissions: ['post', 'moderate'] })
  t.alike(st.permissionsOf('editor'), ['post', 'edit-pages', 'moderate'], 'dropping edit-pages is ignored')
  st = await s.apply(s.key, { type: 'role/define', name: 'editor', permissions: ['post', 'edit-pages'] })
  t.alike(st.permissionsOf('editor'), ['post', 'edit-pages'], 'dropping moderate works (decisions are ordered)')
  st = await s.apply(s.key, { type: 'role/define', name: 'editor', permissions: ['post', 'edit-pages', 'review'] })
  t.alike(st.permissionsOf('editor'), ['post', 'edit-pages', 'review'], 'gaining one works')
})

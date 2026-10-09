// The decision log (research R8): space/init and member/add|remove applied
// deterministically; a decision whose author may not make it is ignored; the
// same decisions in the same order give the same state.

const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const Corestore = require('corestore')
const crypto = require('hypercore-crypto')
const { Decisions } = require('../../../lib/decisions/log.js')
const { applyNodes, initProof } = require('../../../lib/decisions/apply.js')
const { State } = require('../../../lib/decisions/state.js')
const { Identity } = require('../../../lib/identity.js')
const enc = require('../../../lib/encodings.js')
const { tmpDir, eventually } = require('../helpers.js')

const hex = (b) => b4a.toString(b, 'hex')

// A Hyperbee-like view in memory.
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
const node = (writer, d) => ({ from: { key: writer }, value: c.encode(enc.decision, { stamp: 1, ...d }) })
const init = { type: 'space/init', name: 'F', parent: null, private: false, policy: 'auto', version: 1 }

test('the owner creates a space; members are added and removed; a reader agrees', async (t) => {
  const owner = await Identity.create({ device: crypto.keyPair() })
  const storeA = new Corestore(tmpDir(t, 'dec-a'))
  const storeB = new Corestore(tmpDir(t, 'dec-b'))
  t.teardown(async () => { await storeA.close(); await storeB.close() }, { order: 0 })

  const a = new Decisions(storeA, null, { identity: owner })
  t.teardown(() => a.close(), { order: -1 })
  await a.ready()
  await a.init({ name: 'Forum' })
  t.is(a.state.name, 'Forum')
  t.ok(a.state.isMember(owner.publicKey))
  t.is(a.state.roleOf(owner.publicKey), 'owner')

  const x = crypto.randomBytes(32)
  const y = crypto.randomBytes(32)
  await a.append({ type: 'member/add', identity: x })
  await a.append({ type: 'member/add', identity: y })
  await a.append({ type: 'member/remove', identity: y, cut: [] })
  t.ok(a.state.isMember(x))
  t.is(a.state.roleOf(x), 'member')
  t.absent(a.state.isMember(y))

  const s1 = storeA.replicate(true)
  const s2 = storeB.replicate(false)
  s1.pipe(s2).pipe(s1)
  const b = new Decisions(storeB, a.key, { identity: await Identity.create({ device: crypto.keyPair() }) })
  t.teardown(() => b.close(), { order: -1 })
  await b.ready()
  t.ok(await eventually(async () => { await b.update(); return b.state.isMember(x) }, 5000), 'the reader applied the same decisions')
  t.alike(b.state.toJSON(), a.state.toJSON(), 'identical state')
  t.absent(b.writable, 'members without decide are not writers')
})

test('decisions whose author may not make them are ignored', async (t) => {
  const owner = await Identity.create({ device: crypto.keyPair() })
  const space = crypto.randomBytes(32)
  const ownerWriter = space // the bootstrap writer
  const other = crypto.randomBytes(32)
  const x = crypto.randomBytes(32)

  const view = memoryView()
  await applyNodes([node(other, { ...init, proof: initProof(owner, other, space) })], view, null, { space })
  t.absent(State.from(view.map).owner, 'an init not from the first writer is ignored')
  await applyNodes([node(ownerWriter, { ...init, proof: crypto.randomBytes(100) })], view, null, { space })
  t.absent(State.from(view.map).owner, 'an init with a bad proof is ignored')
  await applyNodes([node(ownerWriter, { ...init, proof: initProof(owner, ownerWriter, space) })], view, null, { space })
  t.ok(State.from(view.map).owner, 'a valid init')
  await applyNodes([node(ownerWriter, { ...init, name: 'Second', proof: initProof(owner, ownerWriter, space) })], view, null, { space })
  t.is(State.from(view.map).name, 'F', 'a second init is ignored')

  await applyNodes([node(other, { type: 'member/add', identity: x })], view, null, { space })
  t.absent(State.from(view.map).isMember(x), 'an unknown writer adds no one')

  // A writer whose identity is only a member may not add members.
  const m = crypto.randomBytes(32)
  await view.put(`writer:${hex(other)}`, { identity: hex(m) })
  await view.put(`member:${hex(m)}`, { role: 'member', by: '', stamp: 0 })
  await applyNodes([node(other, { type: 'member/add', identity: x })], view, null, { space })
  t.absent(State.from(view.map).isMember(x), 'a member without the permission adds no one')
  await applyNodes([node(ownerWriter, { type: 'member/remove', identity: owner.publicKey, cut: [] })], view, null, { space })
  t.ok(State.from(view.map).isMember(owner.publicKey), 'the owner cannot be removed')
  await applyNodes([node(ownerWriter, { type: 'member/add', identity: x })], view, null, { space })
  t.ok(State.from(view.map).isMember(x), 'the owner adds members')
})

test('the same decisions give the same state; adds commute', async (t) => {
  const owner = await Identity.create({ device: crypto.keyPair() })
  const space = crypto.randomBytes(32)
  const first = node(space, { ...init, proof: initProof(owner, space, space) })
  const addX = node(space, { type: 'member/add', identity: crypto.randomBytes(32) })
  const addY = node(space, { type: 'member/add', identity: crypto.randomBytes(32) })

  const run = async (nodes) => { const v = memoryView(); await applyNodes(nodes, v, null, { space }); return v.dump() }
  t.is(await run([first, addX, addY]), await run([first, addX, addY]), 'replaying gives the same state')
  t.is(await run([first, addX, addY]), await run([first, addY, addX]), 'two orders of concurrent adds converge')
  const garbage = { from: { key: space }, value: b4a.from([99, 1, 2]) }
  t.is(await run([first, garbage, addX]), await run([first, addX]), 'a malformed decision is skipped, not thrown')
})

// Story 6 (FR-027): the space's storage policy, changed by who may decide.
test('settings/set changes the policy; only who may decide; only auto or everything', async (t) => {
  const owner = await Identity.create({ device: crypto.keyPair() })
  const space = crypto.randomBytes(32)
  const view = memoryView()
  await applyNodes([node(space, { ...init, proof: initProof(owner, space, space) })], view, null, { space })
  t.is(State.from(view.map).policy, 'auto')
  await applyNodes([node(space, { type: 'settings/set', policy: 'everything', writeLimit: null })], view, null, { space })
  t.is(State.from(view.map).policy, 'everything', 'the owner keeps everything')
  await applyNodes([node(space, { type: 'settings/set', policy: 'sometimes', writeLimit: null })], view, null, { space })
  t.is(State.from(view.map).policy, 'everything', 'an unknown policy is ignored')

  const other = crypto.randomBytes(32)
  const m = crypto.randomBytes(32)
  await view.put(`writer:${hex(other)}`, { identity: hex(m) })
  await view.put(`member:${hex(m)}`, { role: 'moderator', by: '', stamp: 0 })
  await applyNodes([node(other, { type: 'settings/set', policy: 'auto', writeLimit: null })], view, null, { space })
  t.is(State.from(view.map).policy, 'everything', 'a moderator may not change it')
})

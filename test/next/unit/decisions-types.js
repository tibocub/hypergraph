// Spec 015 (US1, data-model.md "Decision types/set"): a top space records its
// record types in its decision log. Apply-time: every member applies the same
// rule, so they agree on the types whatever app version they run.
//   applied only if: the writer may decide; the declaration parses and
//   declares; its version is the current one + 1; it only adds to the
//   current types (Types#checkCompatible); at most 32 KB.
//   then: view entry types:<version>, never overwritten; state.types and
//   state.typesVersion.

const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const { applyNodes, initProof } = require('../../../lib/decisions/apply.js')
const { State } = require('../../../lib/decisions/state.js')
const { Identity } = require('../../../lib/identity.js')
const { Types } = require('../../../lib/types.js')
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
const node = (writer, d) => ({ from: { key: writer }, value: c.encode(enc.decision, { stamp: 1, ...d }) })
const init = { type: 'space/init', name: 'F', parent: null, private: false, policy: 'auto', version: 1 }

const v1 = new Types({ post: { fields: { title: 'string' } } }).describe()
const v2 = new Types({ post: { fields: { title: 'string', text: 'text' } }, comment: { fields: { on: 'link' }, links: { on: ['post'] } } }).describe()
const set = (version, types) => ({ type: 'types/set', version, types: typeof types === 'string' ? types : JSON.stringify(types) })

async function space () {
  const owner = await Identity.create({ device: crypto.keyPair() })
  const key = crypto.randomBytes(32)
  const view = memoryView()
  await applyNodes([node(key, { ...init, proof: initProof(owner, key, key) })], view, null, { space: key })
  const apply = (writer, d) => applyNodes([node(writer, d)], view, null, { space: key })
  const state = () => State.from(view.map)
  return { key, view, apply, state }
}

test('the owner records the types: version 1, then 2; each kept', async (t) => {
  const s = await space()
  t.is(s.state().typesVersion, 0, 'none yet')
  t.is(s.state().types, null)
  await s.apply(s.key, set(1, v1))
  t.is(s.state().typesVersion, 1)
  t.alike(s.state().types, v1)
  await s.apply(s.key, set(2, v2))
  t.is(s.state().typesVersion, 2)
  t.alike(s.state().types, v2)
  t.ok(s.view.map.has('types:1') && s.view.map.has('types:2'), 'every version stays in the view')
  t.alike(JSON.parse(s.view.map.get('types:1')), v1, 'version 1 unchanged')
})

test('a version that is not the next one counts for nothing', async (t) => {
  const s = await space()
  await s.apply(s.key, set(2, v1))
  t.is(s.state().typesVersion, 0, 'skipping a version')
  await s.apply(s.key, set(1, v1))
  await s.apply(s.key, set(1, v2))
  t.is(s.state().typesVersion, 1, 'the same version again')
  t.alike(s.state().types, v1, 'never overwritten')
})

test('only who may decide records types', async (t) => {
  const s = await space()
  const other = crypto.randomBytes(32)
  const m = crypto.randomBytes(32)
  await s.view.put(`writer:${hex(other)}`, { identity: hex(m) })
  await s.view.put(`member:${hex(m)}`, { role: 'moderator', by: '', stamp: 0 })
  await s.apply(other, set(1, v1))
  t.is(s.state().typesVersion, 0, 'a moderator may not')
  await s.view.put(`member:${hex(m)}`, { role: 'admin', by: '', stamp: 0 })
  await s.apply(other, set(1, v1))
  t.is(s.state().typesVersion, 1, 'an admin may')
})

test('malformed, hypergraph\'s own names, too big, or breaking the current types: no effect', async (t) => {
  const s = await space()
  await s.apply(s.key, set(1, '{not json'))
  await s.apply(s.key, set(1, { 'hg/device': { fields: [['key', 'bytes']] } }))
  await s.apply(s.key, set(1, { post: { fields: [['title', 'nope']] } }))
  await s.apply(s.key, set(1, { post: { fields: [['title', 'string'], ['pad', 'text']], pad: 'x'.repeat(33 * 1024) } }))
  t.is(s.state().typesVersion, 0, 'none counted')
  await s.apply(s.key, set(1, v2))
  await s.apply(s.key, set(2, v1))
  t.is(s.state().typesVersion, 1, 'removing a type or a field counts for nothing')
  const changed = JSON.parse(JSON.stringify(v2))
  changed.post.fields[1][1] = 'string'
  await s.apply(s.key, set(2, changed))
  t.is(s.state().typesVersion, 1, 'changing a field\'s kind neither')
})

test('two decisions for the same next version: the second in the order counts for nothing, everywhere', async (t) => {
  const run = async (order) => {
    const s = await space()
    const admin = crypto.randomBytes(32)
    const a = crypto.randomBytes(32)
    await s.view.put(`writer:${hex(admin)}`, { identity: hex(a) })
    await s.view.put(`member:${hex(a)}`, { role: 'admin', by: '', stamp: 0 })
    const byOwner = [s.key, set(1, v1)]
    const byAdmin = [admin, set(1, v2)]
    for (const [w, d] of order === 'owner first' ? [byOwner, byAdmin] : [byAdmin, byOwner]) await s.apply(w, d)
    return s.state().types
  }
  t.alike(await run('owner first'), v1)
  t.alike(await run('admin first'), v2)
})

test('a sub-space never records types (it has its top space\'s)', async (t) => {
  const s = await space()
  const sub = crypto.randomBytes(32)
  await s.apply(s.key, { type: 'subspace/create', key: sub, name: 'S', private: false, writeRoles: [] })
  await s.apply(s.key, { type: 'scoped', space: sub, decision: c.encode(enc.decision, { stamp: 1, ...set(1, v1) }) })
  t.is(s.state().typesVersion, 0)
  t.absent([...s.view.map.keys()].some((k) => k.includes('types:')))
})

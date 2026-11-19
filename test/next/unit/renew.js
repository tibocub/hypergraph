// The decisions of a renew (space/renewed, space/moved) and of a
// trim (history/trim), applied deterministically; a re-posted record's `from`.

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
    async * createReadStream ({ gte, lt }) { for (const [key, value] of [...map].sort()) if (key >= gte && key < lt) yield { key, value } }
  }
}
const node = (writer, d) => ({ from: { key: writer }, value: c.encode(enc.decision, { stamp: 1, ...d }) })
const stateOf = (view) => State.from([...view.map].filter(([k]) => !k.startsWith('~')))

async function renewed (entries, { chunks = [entries] } = {}) {
  const renewer = await Identity.create({ device: crypto.keyPair() })
  const space = crypto.randomBytes(32) // the new space's key is its first writer's
  const view = memoryView()
  const from = crypto.randomBytes(32)
  const hash = crypto.randomBytes(32)
  await applyNodes([node(space, { type: 'space/init', name: 'New', parent: null, private: true, policy: 'auto', version: 1, proof: initProof(renewer, space, space) })], view, null, { space })
  for (let i = 0; i < chunks.length; i++) {
    await applyNodes([node(space, { type: 'space/renewed', from, hash, entries: JSON.stringify(chunks[i]), last: i === chunks.length - 1 })], view, null, { space })
  }
  return { view, space, renewer, from, hash }
}

test('space/renewed copies the old state in, never writer keys, then nothing more', async (t) => {
  const owner = hex(crypto.randomBytes(32))
  const member = hex(crypto.randomBytes(32))
  const entries = [
    ['meta', { name: 'Old', owner, policy: 'auto', private: true, version: 1 }],
    [`member:${owner}`, { role: 'owner', by: owner, stamp: 1, writer: 'aa', writerDevice: 'bb' }],
    [`member:${member}`, { role: 'member', by: owner, stamp: 2 }],
    [`writer:${'cc'.repeat(32)}`, { identity: owner, device: 'dd', indexer: true }],
    [`writers:${owner}`, { keys: ['cc'.repeat(32)] }],
    ['moved', { by: owner }],
    [`past:${'ee'.repeat(32)}`, { space: 'ff', top: 'ff', cut: 5, in: 'ab' }]
  ]
  const { view, space, renewer, from, hash } = await renewed(entries, { chunks: [entries.slice(0, 3), entries.slice(3)] })
  const st = stateOf(view)
  t.is(st.name, 'Old', 'the old name')
  t.is(st.owner, owner, 'the old owner')
  t.is(st.roleOf(member), 'member', 'members carried')
  t.alike(st.renewed, { from: hex(from), hash: hex(hash) }, 'marked renewed')
  t.absent(view.map.has(`writer:${'cc'.repeat(32)}`), 'no old writer key')
  t.alike(view.map.get(`member:${owner}`), { role: 'owner', by: owner, stamp: 1 }, 'members keep no writer key')
  t.ok(st.writer(space), 'the renewer\'s writer key is the only one')
  t.is(st.writer(space).identity, hex(renewer.publicKey))
  t.is(st.moved, null, 'not where the old one moved')
  t.alike(st.pasts.get('ee'.repeat(32)), { space: 'ff', top: 'ff', cut: 5, in: 'ab' }, 'history logs kept')

  await applyNodes([node(space, { type: 'space/renewed', from, hash, entries: JSON.stringify([[`member:${member}`, { role: 'admin', by: owner, stamp: 3 }]]), last: true })], view, null, { space })
  t.is(stateOf(view).roleOf(member), 'member', 'a chunk after the last counts for nothing')
})

test('space/moved: by who may decide, the first one only; history/trim never grows back', async (t) => {
  const owner = await Identity.create({ device: crypto.keyPair() })
  const space = crypto.randomBytes(32)
  const view = memoryView()
  await applyNodes([node(space, { type: 'space/init', name: 'S', parent: null, private: true, policy: 'auto', version: 1, proof: initProof(owner, space, space) })], view, null, { space })
  const boxes = [{ to: crypto.randomBytes(32), sealed: b4a.from('box') }]
  const first = crypto.randomBytes(32)
  await applyNodes([node(space, { type: 'space/moved', boxes, hash: first })], view, null, { space })
  await applyNodes([node(space, { type: 'space/moved', boxes: [], hash: crypto.randomBytes(32) })], view, null, { space })
  const st = stateOf(view)
  t.is(st.moved.hash, hex(first), 'the first wins')
  t.is(st.moved.boxes.length, 1)
  const stranger = crypto.randomBytes(32)
  await applyNodes([node(stranger, { type: 'history/trim', before: 5, logs: [{ log: space, length: 9 }] })], view, null, { space })
  t.absent(stateOf(view).trims.size, 'a stranger can\'t trim')
  const log = crypto.randomBytes(32)
  await applyNodes([node(space, { type: 'history/trim', before: 5, logs: [{ log, length: 9 }] })], view, null, { space })
  await applyNodes([node(space, { type: 'history/trim', before: 2, logs: [{ log, length: 4 }] })], view, null, { space })
  t.is(stateOf(view).trims.get(hex(log)), 9, 'a later, shorter trim doesn\'t bring records back')
})

test('a re-posted record carries its old id', (t) => {
  const from = enc.idBytes({ log: crypto.randomBytes(32), seq: 7 })
  const r = { kind: enc.PUT, type: 'post', stamp: 5, target: null, links: [], fields: b4a.from('x'), from }
  const back = enc.decodeRecord(enc.encodeRecord(r))
  t.alike(back.from, from)
  t.absent('from' in enc.decodeRecord(enc.encodeRecord({ ...r, from: null })), 'none on an ordinary record')
})

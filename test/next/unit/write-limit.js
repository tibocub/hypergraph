// The write limit of an open space (story 9, T071a; research.md A14): a log
// counts at most `records` records within any `periodMs`, judged the same by
// every member although deletes wipe earlier records.

const test = require('brittle')
const { judge, nextAllowed, validLimit } = require('../../../lib/limit.js')
const { WIPED } = require('../../../lib/activity.js')

const limit = { records: 3, periodMs: 1000 }
const log = (stamps) => async (i) => stamps[i] // block i's stamp (index 0: the header)

test('at most `records` records within any period', async (t) => {
  const stamps = [null, 0, 100, 200, 300, 1100, 1250, 1350]
  const at = log(stamps)
  t.is(await judge(1, 0, limit, at), 'ok')
  t.is(await judge(3, 200, limit, at), 'ok', 'the first three always count')
  t.is(await judge(4, 300, limit, at), 'over', 'a fourth within the period')
  t.is(await judge(5, 1100, limit, at), 'ok', 'a period after block 2')
  t.is(await judge(6, 1250, limit, at), 'ok', 'block 3 was at 200')
  t.is(await judge(7, 1350, limit, at), 'ok', 'block 4 was at 300 (whether it counted or not: positions count)')
  t.is(await judge(4, 300, null, at), 'ok', 'no limit')
})

test('a wiped block takes the stamp of the next readable one: deleting never frees room', async (t) => {
  // block 2 was deleted by its author: its stamp (100) is gone for whoever comes later
  const before = log([null, 0, 100, 900, 950, 1150])
  const after = log([null, 0, WIPED, 900, 950, 1150])
  t.is(await judge(5, 1150, limit, before), 'ok', 'while block 2 is readable: 1150 - 100')
  t.is(await judge(5, 1150, limit, after), 'over', 'once wiped: judged against block 3 (900), for every member alike')
  t.is(await judge(4, 950, limit, log([null, 0, WIPED, WIPED, 950])), 'over', 'nothing readable in the window: not counted')
})

test('a block the judgment needs that isn\'t here: wait', async (t) => {
  t.is(await judge(5, 2000, limit, log([null, 0, null, 300, 400])), 'wait')
})

test('when a log may write again', async (t) => {
  const at = log([null, 0, 100, 200])
  t.is(await nextAllowed(4, 300, limit, at), 1000, 'a period after block 1')
  t.is(await nextAllowed(4, 1200, limit, at), 0, 'now')
  t.is(await nextAllowed(2, 50, limit, at), 0)
})

test('a limit is whole numbers', (t) => {
  t.ok(validLimit({ records: 50, periodMs: 3600e3 }))
  t.absent(validLimit({ records: 0, periodMs: 1000 }))
  t.absent(validLimit({ records: 5, periodMs: 0.5 }))
  t.absent(validLimit(null))
})

// The decision (settings/set { writeLimit }): by who may decide; records 0
// lifts it; a sub-space has its own.
test('settings/set records the write limit; only who may decide; records 0 lifts it', async (t) => {
  const b4a = require('b4a')
  const c = require('compact-encoding')
  const crypto = require('hypercore-crypto')
  const enc = require('../../../lib/encodings.js')
  const { applyNodes, initProof } = require('../../../lib/decisions/apply.js')
  const { State } = require('../../../lib/decisions/state.js')
  const { Identity } = require('../../../lib/identity.js')
  const map = new Map()
  const view = { get: async (k) => (map.has(k) ? { key: k, value: map.get(k) } : null), put: async (k, v) => { map.set(k, v) }, del: async (k) => { map.delete(k) } }
  const node = (writer, d) => ({ from: { key: writer }, value: c.encode(enc.decision, { stamp: 1, ...d }) })
  const owner = await Identity.create({ device: crypto.keyPair() })
  const space = crypto.randomBytes(32)
  await applyNodes([node(space, { type: 'space/init', name: 'Open', parent: null, private: false, policy: 'auto', version: 1, proof: initProof(owner, space, space) })], view, null, { space })
  t.is(State.from(map).writeLimit, null, 'none at first')
  await applyNodes([node(space, { type: 'settings/set', policy: null, writeLimit: { records: 50, periodMs: 3600000 }, rules: null })], view, null, { space })
  t.alike(State.from(map).writeLimit, { records: 50, periodMs: 3600000 })
  t.is(State.from(map).policy, 'auto', 'the policy stays')

  const other = crypto.randomBytes(32)
  const m = crypto.randomBytes(32)
  await view.put(`writer:${b4a.toString(other, 'hex')}`, { identity: b4a.toString(m, 'hex') })
  await view.put(`member:${b4a.toString(m, 'hex')}`, { role: 'moderator', by: '', stamp: 0 })
  await applyNodes([node(other, { type: 'settings/set', policy: null, writeLimit: { records: 1, periodMs: 1 }, rules: null })], view, null, { space })
  t.alike(State.from(map).writeLimit, { records: 50, periodMs: 3600000 }, 'a moderator may not change it')

  await applyNodes([node(space, { type: 'settings/set', policy: null, writeLimit: { records: 0, periodMs: 0 }, rules: null })], view, null, { space })
  t.is(State.from(map).writeLimit, null, 'records 0: no limit')
})

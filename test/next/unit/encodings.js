// Compact encodings of everything that goes on the network (data-model.md):
// log header, records, decisions, invites, channel messages.

const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const enc = require('../../../lib/encodings.js')

const key = () => crypto.randomBytes(32)
const roundTrip = (t, codec, value, msg) => t.alike(c.decode(codec, c.encode(codec, value)), value, msg)

test('record ids: bytes, objects and z32 strings agree', (t) => {
  const log = key()
  const s = enc.idToString({ log, seq: 300 })
  t.is(typeof s, 'string')
  t.alike(enc.idParts(s), { log, seq: 300 })
  t.alike(enc.idToString(enc.idFromString(s)), s)
  t.exception(() => enc.idFromString('not an id'), /INVALID|id/i)
})

test('log header round trip', (t) => {
  roundTrip(t, enc.header, { version: 1, space: key(), decisions: key(), proof: crypto.randomBytes(180), admitted: null })
  // story 9: the code of the decision that let its author back in, trailing
  roundTrip(t, enc.header, { version: 1, space: key(), decisions: key(), proof: crypto.randomBytes(180), admitted: key() })
})

test('records of each kind round trip', (t) => {
  const target = enc.idFromString(enc.idToString({ log: key(), seq: 4 }))
  roundTrip(t, enc.record, { kind: enc.PUT, type: 'post', stamp: Date.now(), target: null, links: [], fields: b4a.from([1, 2]) }, 'put')
  roundTrip(t, enc.record, { kind: enc.PUT, type: 'comment', stamp: 5, target: null, links: [target], fields: b4a.from([1]) }, 'put with a link')
  roundTrip(t, enc.record, { kind: enc.EDIT, type: 'post', stamp: 6, target, links: [], fields: b4a.from([3]) }, 'edit')
  roundTrip(t, enc.record, { kind: enc.DELETE, type: 'post', stamp: 7, target, links: [], fields: b4a.alloc(0) }, 'delete')
})

test('a record over 64 KB is refused with INVALID_RECORD', (t) => {
  const big = { kind: enc.PUT, type: 'post', stamp: 1, target: null, links: [], fields: b4a.alloc(65 * 1024) }
  try { enc.encodeRecord(big); t.fail('should throw') } catch (err) { t.is(err.code, 'INVALID_RECORD') }
  const raw = c.encode(enc.record, big)
  try { enc.decodeRecord(raw); t.fail('should throw') } catch (err) { t.is(err.code, 'INVALID_RECORD') }
  t.ok(enc.decodeRecord(enc.encodeRecord({ ...big, fields: b4a.alloc(10) })))
})

test('malformed record bytes throw INVALID_RECORD', (t) => {
  try { enc.decodeRecord(b4a.from([9, 9, 9])); t.fail('should throw') } catch (err) { t.is(err.code, 'INVALID_RECORD') }
})

test('every decision of data-model.md round trips', (t) => {
  const id = enc.idFromString(enc.idToString({ log: key(), seq: 1 }))
  const all = [
    { type: 'space/init', stamp: 1, name: 'Forum', parent: null, private: false, policy: 'auto', version: 1, proof: crypto.randomBytes(150) },
    { type: 'space/init', stamp: 1, name: 'Sub', parent: key(), private: true, policy: 'everything', version: 1, proof: crypto.randomBytes(150) },
    { type: 'member/add', stamp: 2, identity: key() },
    { type: 'member/remove', stamp: 3, identity: key(), cut: [{ log: key(), length: 4 }] },
    { type: 'role/define', stamp: 4, name: 'editor', permissions: ['post', 'edit-pages'] },
    { type: 'role/set', stamp: 5, identity: key(), role: 'moderator', cut: [] },
    { type: 'moderate', stamp: 7, action: 'hide', target: id, reason: 'spam', cut: [], drop: null },
    { type: 'moderate', stamp: 8, action: 'ban', target: key(), reason: 'spam', cut: [{ log: key(), length: 12 }], drop: null },
    { type: 'moderate', stamp: 8, action: 'ban', target: key(), reason: '', cut: [], drop: 'all' }, // spec 014
    { type: 'invite/create', stamp: 9, invite: crypto.randomBytes(100) },
    { type: 'invite/revoke', stamp: 10, invite: crypto.randomBytes(100) },
    { type: 'invite/redeem', stamp: 11, redemption: crypto.randomBytes(300) },
    { type: 'key/rotate', stamp: 12, epoch: 1, commit: key() },
    { type: 'subspace/create', stamp: 13, key: key(), name: 'News', private: false, writeRoles: ['moderator'] },
    { type: 'settings/set', stamp: 14, policy: 'everything', writeLimit: null, rules: null, history: null, helpers: null },
    { type: 'settings/set', stamp: 15, policy: null, writeLimit: { records: 50, periodMs: 3600000 }, rules: ['title-length'], history: 'hidden', helpers: null },
    { type: 'settings/set', stamp: 18, policy: null, writeLimit: null, rules: null, history: null, helpers: [b4a.toString(key(), 'hex')] }, // spec 013
    { type: 'settings/set', stamp: 19, policy: null, writeLimit: null, rules: null, history: null, helpers: [] }, // cleared
    { type: 'logs/list', stamp: 20, logs: [{ space: key(), log: key() }] },
    { type: 'writer/add', stamp: 16, key: crypto.randomBytes(32), proof: crypto.randomBytes(140) },
    { type: 'device/remove', stamp: 17, device: crypto.randomBytes(32), cut: crypto.randomBytes(40), proof: crypto.randomBytes(140) }
  ]
  for (const d of all) roundTrip(t, enc.decision, d, d.type)
  t.exception(() => c.encode(enc.decision, { type: 'nope', stamp: 1 }))
})

test('a settings decision written before helpers existed decodes with none (spec 013)', (t) => {
  const old = { type: 'settings/set', stamp: 1, policy: 'auto', writeLimit: null, rules: ['r'], history: 'visible' }
  const bytes = c.encode(enc.decision, { ...old, helpers: null })
  t.is(c.decode(enc.decision, bytes.subarray(0, bytes.byteLength - 1)).helpers, null, 'no trailing field: null')
})

test('invites and redemptions round trip', (t) => {
  const invite = { space: key(), id: crypto.randomBytes(16), role: 'member', uses: 1, expires: 0, subspaces: [], maker: key(), proof: crypto.randomBytes(150) }
  roundTrip(t, enc.invite, invite)
  roundTrip(t, enc.redemption, { invite, identity: key(), writer: key(), proof: crypto.randomBytes(150) })
})

test('channel messages round trip', (t) => {
  roundTrip(t, enc.summary, { count: 3, digest: key(), records: 1234 }) // story 9: how many records the sender's logs hold
  t.is(c.decode(enc.summary, c.encode(enc.struct([['count', c.uint], ['digest', c.fixed32]]), { count: 3, digest: key() })).records, 0, 'from a sender without it: 0')
  roundTrip(t, enc.logs, [key(), key()])
  roundTrip(t, enc.logKey, key())
  roundTrip(t, enc.redeem, { redemption: crypto.randomBytes(200) })
})

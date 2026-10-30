// What goes on the network (data-model.md), as compact-encoding structs: the
// log header, records, decisions, invites and the space channel's messages.

const c = require('compact-encoding')
const b4a = require('b4a')
const z32 = require('z32')
const { HypergraphError } = require('./errors.js')

const MAX_RECORD = 64 * 1024
const VERSION = 1

// --- record ids: the log's key and the block number ---

const recordId = {
  preencode (state, id) { c.fixed32.preencode(state, id.log); c.uint.preencode(state, id.seq) },
  encode (state, id) { c.fixed32.encode(state, id.log); c.uint.encode(state, id.seq) },
  decode (state) { return { log: c.fixed32.decode(state), seq: c.uint.decode(state) } }
}

// An id as bytes, from bytes, { log, seq } or its z32 string.
function idBytes (id) {
  if (typeof id === 'string') return idFromString(id)
  if (b4a.isBuffer(id)) return id
  return c.encode(recordId, id)
}

function idToString (id) {
  return z32.encode(idBytes(id))
}

function idFromString (s) {
  let bytes = null
  try { bytes = z32.decode(s) } catch {}
  if (!bytes || bytes.byteLength < 33) throw new HypergraphError('NOT_FOUND', `Not a record id: ${s}`)
  try { c.decode(recordId, bytes) } catch { throw new HypergraphError('NOT_FOUND', `Not a record id: ${s}`) }
  return bytes
}

function idParts (id) {
  return c.decode(recordId, idBytes(id))
}

// --- the log header (block 0 of every device log) ---

// story 9: `admitted`, the code of the decision that let its author back in
// after a cut (a trailing field: null when absent).
const header = {
  preencode (state, h) {
    c.uint.preencode(state, h.version)
    c.fixed32.preencode(state, h.space)
    c.fixed32.preencode(state, h.decisions)
    c.buffer.preencode(state, h.proof)
    if (h.admitted) c.fixed32.preencode(state, h.admitted)
  },
  encode (state, h) {
    c.uint.encode(state, h.version)
    c.fixed32.encode(state, h.space)
    c.fixed32.encode(state, h.decisions)
    c.buffer.encode(state, h.proof)
    if (h.admitted) c.fixed32.encode(state, h.admitted)
  },
  decode (state) {
    const h = { version: c.uint.decode(state), space: c.fixed32.decode(state), decisions: c.fixed32.decode(state), proof: c.buffer.decode(state) }
    h.admitted = state.start < state.end ? c.fixed32.decode(state) : null
    return h
  }
}

// --- records (blocks 1.. of a device log) ---

const PUT = 0
const EDIT = 1
const DELETE = 2

const record = {
  preencode (state, r) {
    c.uint.preencode(state, r.kind)
    c.string.preencode(state, r.type)
    c.uint.preencode(state, r.stamp)
    c.uint.preencode(state, 0) // flags
    if (r.target) c.buffer.preencode(state, r.target)
    c.array(c.buffer).preencode(state, r.links)
    c.raw.preencode(state, r.fields)
  },
  encode (state, r) {
    c.uint.encode(state, r.kind)
    c.string.encode(state, r.type)
    c.uint.encode(state, r.stamp)
    c.uint.encode(state, (r.target ? 1 : 0) | (r.sealed ? 2 : 0)) // 2: fields and links sealed (a private space, story 8)
    if (r.target) c.buffer.encode(state, r.target)
    c.array(c.buffer).encode(state, r.links)
    c.raw.encode(state, r.fields)
  },
  decode (state) {
    const kind = c.uint.decode(state)
    if (kind > DELETE) throw new Error('Unknown record kind')
    const type = c.string.decode(state)
    const stamp = c.uint.decode(state)
    const flags = c.uint.decode(state)
    const target = (flags & 1) ? c.buffer.decode(state) : null
    const links = c.array(c.buffer).decode(state)
    const fields = c.raw.decode(state)
    return { kind, type, stamp, target, links, fields, ...((flags & 2) ? { sealed: true } : {}) }
  }
}

function encodeRecord (r) {
  const bytes = c.encode(record, r)
  if (bytes.byteLength > MAX_RECORD) throw new HypergraphError('INVALID_RECORD', `A record is at most 64 KB (this one is ${bytes.byteLength} B)`)
  return bytes
}

function decodeRecord (bytes) {
  if (!bytes || bytes.byteLength > MAX_RECORD) throw new HypergraphError('INVALID_RECORD', 'A record is at most 64 KB')
  try {
    const r = c.decode(record, bytes)
    if (r.target) c.decode(recordId, r.target)
    for (const l of r.links) c.decode(recordId, l)
    return r
  } catch (err) {
    throw new HypergraphError('INVALID_RECORD', `Malformed record: ${err.message}`)
  }
}

// --- decisions (the decision log, an Autobase per space) ---

const optFixed32 = {
  preencode (state, v) { c.bool.preencode(state, !!v); if (v) c.fixed32.preencode(state, v) },
  encode (state, v) { c.bool.encode(state, !!v); if (v) c.fixed32.encode(state, v) },
  decode (state) { return c.bool.decode(state) ? c.fixed32.decode(state) : null }
}

const optString = {
  preencode (state, v) { c.bool.preencode(state, v != null); if (v != null) c.string.preencode(state, v) },
  encode (state, v) { c.bool.encode(state, v != null); if (v != null) c.string.encode(state, v) },
  decode (state) { return c.bool.decode(state) ? c.string.decode(state) : null }
}

const listedLog = struct([['space', c.fixed32], ['log', c.fixed32]])
const cutEntry = struct([['log', c.fixed32], ['length', c.uint]])
const writeLimit = struct([['records', c.uint], ['periodMs', c.uint]])
const optWriteLimit = {
  preencode (state, v) { c.bool.preencode(state, !!v); if (v) writeLimit.preencode(state, v) },
  encode (state, v) { c.bool.encode(state, !!v); if (v) writeLimit.encode(state, v) },
  decode (state) { return c.bool.decode(state) ? writeLimit.decode(state) : null }
}

// A list of strings at the end of a decision, absent from entries written
// before it existed (decoded as null).
const optTrailingStrings = {
  preencode (state, v) { c.bool.preencode(state, !!v); if (v) c.array(c.string).preencode(state, v) },
  encode (state, v) { c.bool.encode(state, !!v); if (v) c.array(c.string).encode(state, v) },
  decode (state) { return state.start < state.end && c.bool.decode(state) ? c.array(c.string).decode(state) : null }
}

// A trailing optional string (A16: a private space's history setting).
const optTrailingString = {
  preencode (state, v) { c.bool.preencode(state, v != null); if (v != null) c.string.preencode(state, v) },
  encode (state, v) { c.bool.encode(state, v != null); if (v != null) c.string.encode(state, v) },
  decode (state) { return state.start < state.end && c.bool.decode(state) ? c.string.decode(state) : null }
}

// type → its fields after { type, stamp }
const DECISIONS = {
  'space/init': [['name', c.string], ['parent', optFixed32], ['private', c.bool], ['policy', c.string], ['version', c.uint], ['proof', c.buffer]],
  'member/add': [['identity', c.fixed32]],
  'member/remove': [['identity', c.fixed32], ['cut', c.array(cutEntry)]],
  'role/define': [['name', c.string], ['permissions', c.array(c.string)]],
  'role/set': [['identity', c.fixed32], ['role', c.string], ['cut', c.array(cutEntry)]],
  // spec 014 (F11): `drop` 'all' on a ban drops everything they wrote (trailing)
  moderate: [['action', c.string], ['target', c.buffer], ['reason', c.string], ['cut', c.array(cutEntry)], ['drop', optTrailingString]],
  'invite/create': [['invite', c.buffer]],
  'invite/revoke': [['invite', c.buffer]], // the encoded invite: its maker may revoke it
  'invite/redeem': [['redemption', c.buffer]],
  'key/rotate': [['epoch', c.uint], ['commit', c.fixed32]],
  'subspace/create': [['key', c.fixed32], ['name', c.string], ['private', c.bool], ['writeRoles', c.array(c.string)]],
  // rules (core follow-ups): the ids of the app rules the space runs
  // helpers (spec 013): the blind peers' keys (hex) keeping the space; [] clears
  'settings/set': [['policy', optString], ['writeLimit', optWriteLimit], ['rules', optTrailingStrings], ['history', optTrailingString], ['helpers', optTrailingStrings]],
  // story 4 (research.md A8): a device's claim of its writer key, and a
  // device removal signed by the identity key (the record's bytes)
  'writer/add': [['key', c.fixed32], ['proof', c.buffer]],
  'device/remove': [['device', c.fixed32], ['cut', c.buffer], ['proof', c.buffer]],
  // story 8 (research.md A13): a decision about a sub-space, kept in its
  // parent's decision log: the sub-space's key and the decision itself
  scoped: [['space', c.fixed32], ['decision', c.buffer]],
  // spec 013: logs a member who records decisions holds, so members find
  // them on a helper without meeting their authors
  'logs/list': [['logs', c.array(listedLog)]]
}
const DECISION_TYPES = Object.keys(DECISIONS)
const DECISION_BODIES = Object.fromEntries(DECISION_TYPES.map((t) => [t, struct(DECISIONS[t])]))

const decision = {
  preencode (state, d) {
    const body = bodyOf(d.type)
    c.uint.preencode(state, DECISION_TYPES.indexOf(d.type))
    c.uint.preencode(state, d.stamp)
    body.preencode(state, d)
  },
  encode (state, d) {
    const body = bodyOf(d.type)
    c.uint.encode(state, DECISION_TYPES.indexOf(d.type))
    c.uint.encode(state, d.stamp)
    body.encode(state, d)
  },
  decode (state) {
    const type = DECISION_TYPES[c.uint.decode(state)]
    if (!type) throw new Error('Unknown decision type')
    const stamp = c.uint.decode(state)
    return { type, stamp, ...DECISION_BODIES[type].decode(state) }
  }
}

function bodyOf (type) {
  const body = DECISION_BODIES[type]
  if (!body) throw new Error(`Unknown decision type: ${type}`)
  return body
}

// --- invites (spec 008's design, research R16) ---

const inviteBody = struct([
  ['space', c.fixed32], ['id', c.buffer], ['role', c.string], ['uses', c.uint], ['expires', c.uint],
  ['subspaces', c.array(c.fixed32)], ['maker', c.fixed32]
])
const invite = struct([...inviteBody.fields, ['proof', c.buffer]])
const redemption = struct([['invite', invite], ['identity', c.fixed32], ['writer', c.fixed32], ['proof', c.buffer]])

// --- the space channel (research R10) ---

// story 9: `records`, how many records the sender's logs hold (a trailing
// field: 0 from a sender without it)
const summary = {
  preencode (state, m) { c.uint.preencode(state, m.count); c.fixed32.preencode(state, m.digest); c.uint.preencode(state, m.records || 0) },
  encode (state, m) { c.uint.encode(state, m.count); c.fixed32.encode(state, m.digest); c.uint.encode(state, m.records || 0) },
  decode (state) {
    const count = c.uint.decode(state)
    const digest = c.fixed32.decode(state)
    return { count, digest, records: state.start < state.end ? c.uint.decode(state) : 0 }
  }
}
const logs = c.array(c.fixed32)
const logKey = c.fixed32
const redeem = struct([['redemption', c.buffer]])
const ask = struct([['decision', c.buffer]]) // a decision for a writer to record (research.md A8)

// A struct codec from [[name, codec], ...].
function struct (fields) {
  return {
    fields,
    preencode (state, v) { for (const [name, codec] of fields) codec.preencode(state, v[name]) },
    encode (state, v) { for (const [name, codec] of fields) codec.encode(state, v[name]) },
    decode (state) {
      const out = {}
      for (const [name, codec] of fields) out[name] = codec.decode(state)
      return out
    }
  }
}

module.exports = {
  VERSION,
  MAX_RECORD,
  PUT,
  EDIT,
  DELETE,
  recordId,
  idBytes,
  idToString,
  idFromString,
  idParts,
  header,
  record,
  encodeRecord,
  decodeRecord,
  decision,
  DECISION_TYPES,
  inviteBody,
  invite,
  redemption,
  summary,
  logs,
  logKey,
  redeem,
  ask,
  struct
}

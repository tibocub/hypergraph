// What goes on the network, as compact-encoding structs: the
// log header, records, decisions, invites and the space channel's messages.

const c = require('compact-encoding')
const b4a = require('b4a')
const z32 = require('z32')
const { HypergraphError } = require('./errors.js')

const MAX_RECORD = 64 * 1024
const VERSION = 1

/**
 * @typedef {{ log: Uint8Array, seq: number }} RecordId A record's place: its log's key and its block.
 * @typedef {string | Uint8Array | RecordId} IdLike A record id as z32 text, bytes or parts.
 * @typedef {{ version: number, space: Uint8Array, decisions: Uint8Array, proof: Uint8Array, admitted?: Uint8Array | null }} LogHeader
 * @typedef {{ kind: number, type: string, stamp: number, target: Uint8Array | null, from?: Uint8Array | null, links: Uint8Array[], fields: Uint8Array, sealed?: boolean }} WireRecord
 * @typedef {{ log: Uint8Array, length: number }} CutEntry
 * @typedef {{ space: Uint8Array, log: Uint8Array }} ListedLog
 * @typedef {{ to: Uint8Array, sealed: Uint8Array }} SealedBox
 * @typedef {import('./limit.js').WriteLimit} WriteLimit
 */

/**
 * A decision's own fields, by type (what members write to the decision log).
 * @typedef {{ type: 'space/init', name: string, parent?: Uint8Array | null, private: boolean, policy: string, version: number, proof: Uint8Array, circle?: boolean | null }
 *   | { type: 'member/add', identity: Uint8Array }
 *   | { type: 'member/remove', identity: Uint8Array, cut: CutEntry[] }
 *   | { type: 'role/define', name: string, permissions: string[] }
 *   | { type: 'role/set', identity: Uint8Array, role: string, cut: CutEntry[] }
 *   | { type: 'moderate', action: string, target: Uint8Array, reason: string, cut: CutEntry[], drop?: string | null }
 *   | { type: 'invite/create', invite: Uint8Array }
 *   | { type: 'invite/revoke', invite: Uint8Array }
 *   | { type: 'invite/redeem', redemption: Uint8Array }
 *   | { type: 'key/rotate', epoch: number, commit: Uint8Array }
 *   | { type: 'subspace/create', key: Uint8Array, name: string, private: boolean, writeRoles: string[] }
 *   | { type: 'settings/set', policy?: string | null, writeLimit?: WriteLimit | false | null, rules?: string[] | null, history?: string | null, helpers?: string[] | null, public?: boolean | null }
 *   | { type: 'writer/add', key: Uint8Array, proof: Uint8Array }
 *   | { type: 'device/remove', device: Uint8Array, cut: Uint8Array, proof: Uint8Array }
 *   | { type: 'scoped', space: Uint8Array, decision: Uint8Array }
 *   | { type: 'logs/list', logs: ListedLog[] }
 *   | { type: 'types/set', version: number, types: string }
 *   | { type: 'space/renewed', from: Uint8Array, hash: Uint8Array, entries: string, last: boolean }
 *   | { type: 'space/moved', boxes: SealedBox[], hash: Uint8Array }
 *   | { type: 'history/trim', before: number, logs: CutEntry[] }} DecisionBody
 * @typedef {DecisionBody & { stamp: number }} Decision
 * @typedef {Decision['type']} DecisionType
 */

/**
 * @template T
 * @typedef {{ preencode (state: c.State, v: T): void, encode (state: c.State, v: T): void, decode (state: c.State): T }} Codec
 */

/**
 * @typedef {Array<[string, Codec<any>]>} StructFields
 */

/**
 * @template T
 * @typedef {Codec<T> & { fields: StructFields }} StructCodec
 */


/** @type {Codec<RecordId>} */
const recordId = {
  /**
   * @param {c.State} state
   * @param {RecordId} id
   */
  preencode (state, id) { c.fixed32.preencode(state, id.log); c.uint.preencode(state, id.seq) },
  /**
   * @param {c.State} state
   * @param {RecordId} id
   */
  encode (state, id) { c.fixed32.encode(state, id.log); c.uint.encode(state, id.seq) },
  /**
   * @param {c.State} state
   */
  decode (state) { return { log: c.fixed32.decode(state), seq: c.uint.decode(state) } }
}

// An id as bytes, from bytes, { log, seq } or its z32 string.
/**
 * @param {IdLike} id
 * @returns {Uint8Array}
 */
function idBytes (id) {
  if (typeof id === 'string') return idFromString(id)
  if (b4a.isBuffer(id)) return id
  return c.encode(recordId, id)
}

/**
 * @param {IdLike} id
 * @returns {string}
 */
function idToString (id) {
  return z32.encode(idBytes(id))
}

/**
 * @param {string} s
 * @returns {Uint8Array}
 */
function idFromString (s) {
  let bytes = null
  try { bytes = z32.decode(s) } catch {}
  if (!bytes || bytes.byteLength < 33) throw new HypergraphError('NOT_FOUND', `Not a record id: ${s}`)
  try { c.decode(recordId, bytes) } catch { throw new HypergraphError('NOT_FOUND', `Not a record id: ${s}`) }
  return bytes
}

/**
 * @param {IdLike} id
 * @returns {RecordId}
 */
function idParts (id) {
  return c.decode(recordId, idBytes(id))
}


// `admitted`, the code of the decision that let its author back in
// after a cut (a trailing field: null when absent).
/** @type {Codec<LogHeader>} */
const header = {
  /**
   * @param {c.State} state
   * @param {LogHeader} h
   */
  preencode (state, h) {
    c.uint.preencode(state, h.version)
    c.fixed32.preencode(state, h.space)
    c.fixed32.preencode(state, h.decisions)
    c.buffer.preencode(state, h.proof)
    if (h.admitted) c.fixed32.preencode(state, h.admitted)
  },
  /**
   * @param {c.State} state
   * @param {LogHeader} h
   */
  encode (state, h) {
    c.uint.encode(state, h.version)
    c.fixed32.encode(state, h.space)
    c.fixed32.encode(state, h.decisions)
    c.buffer.encode(state, h.proof)
    if (h.admitted) c.fixed32.encode(state, h.admitted)
  },
  /**
   * @param {c.State} state
   */
  decode (state) {
    /** @type {LogHeader} */
    const h = { version: c.uint.decode(state), space: c.fixed32.decode(state), decisions: c.fixed32.decode(state), proof: c.buffer.decode(state) }
    h.admitted = state.start < state.end ? c.fixed32.decode(state) : null
    return h
  }
}


const PUT = 0
const EDIT = 1
const DELETE = 2

/** @type {Codec<WireRecord>} */
const record = {
  /**
   * @param {c.State} state
   * @param {WireRecord} r
   */
  preencode (state, r) {
    c.uint.preencode(state, r.kind)
    c.string.preencode(state, r.type)
    c.uint.preencode(state, r.stamp)
    c.uint.preencode(state, 0) // flags
    if (r.target) c.buffer.preencode(state, r.target)
    if (r.from) c.buffer.preencode(state, r.from)
    c.array(c.buffer).preencode(state, r.links)
    c.raw.preencode(state, r.fields)
  },
  /**
   * @param {c.State} state
   * @param {WireRecord} r
   */
  encode (state, r) {
    c.uint.encode(state, r.kind)
    c.string.encode(state, r.type)
    c.uint.encode(state, r.stamp)
    // 2: fields and links sealed (a private space); 4: re-posted after a renew, `from` its old id
    c.uint.encode(state, (r.target ? 1 : 0) | (r.sealed ? 2 : 0) | (r.from ? 4 : 0))
    if (r.target) c.buffer.encode(state, r.target)
    if (r.from) c.buffer.encode(state, r.from)
    c.array(c.buffer).encode(state, r.links)
    c.raw.encode(state, r.fields)
  },
  /**
   * @param {c.State} state
   */
  decode (state) {
    const kind = c.uint.decode(state)
    if (kind > DELETE) throw new Error('Unknown record kind')
    const type = c.string.decode(state)
    const stamp = c.uint.decode(state)
    const flags = c.uint.decode(state)
    const target = (flags & 1) ? c.buffer.decode(state) : null
    const from = (flags & 4) ? c.buffer.decode(state) : null
    const links = c.array(c.buffer).decode(state)
    const fields = c.raw.decode(state)
    return { kind, type, stamp, target, links, fields, ...((flags & 2) ? { sealed: true } : {}), ...(from ? { from } : {}) }
  }
}

/**
 * @param {WireRecord} r
 * @returns {Uint8Array}
 */
function encodeRecord (r) {
  const bytes = c.encode(record, r)
  if (bytes.byteLength > MAX_RECORD) throw new HypergraphError('INVALID_RECORD', `A record is at most 64 KB (this one is ${bytes.byteLength} B)`)
  return bytes
}

/**
 * @param {Uint8Array | null} bytes
 * @returns {WireRecord}
 */
function decodeRecord (bytes) {
  if (!bytes || bytes.byteLength > MAX_RECORD) throw new HypergraphError('INVALID_RECORD', 'A record is at most 64 KB')
  try {
    const r = c.decode(record, bytes)
    if (r.target) c.decode(recordId, r.target)
    if (r.from) c.decode(recordId, r.from)
    for (const l of r.links) c.decode(recordId, l)
    return r
  } catch (/** @type {any} */ err) { // anything thrown
    throw new HypergraphError('INVALID_RECORD', `Malformed record: ${err.message}`)
  }
}


const optFixed32 = {
  /**
   * @param {c.State} state
   * @param {Uint8Array | null | undefined} v
   */
  preencode (state, v) { c.bool.preencode(state, !!v); if (v) c.fixed32.preencode(state, v) },
  /**
   * @param {c.State} state
   * @param {Uint8Array | null | undefined} v
   */
  encode (state, v) { c.bool.encode(state, !!v); if (v) c.fixed32.encode(state, v) },
  /**
   * @param {c.State} state
   */
  decode (state) { return c.bool.decode(state) ? c.fixed32.decode(state) : null }
}

const optString = {
  /**
   * @param {c.State} state
   * @param {string | null | undefined} v
   */
  preencode (state, v) { c.bool.preencode(state, v != null); if (v != null) c.string.preencode(state, v) },
  /**
   * @param {c.State} state
   * @param {string | null | undefined} v
   */
  encode (state, v) { c.bool.encode(state, v != null); if (v != null) c.string.encode(state, v) },
  /**
   * @param {c.State} state
   */
  decode (state) { return c.bool.decode(state) ? c.string.decode(state) : null }
}

const listedLog = struct([['space', c.fixed32], ['log', c.fixed32]])
const cutEntry = struct([['log', c.fixed32], ['length', c.uint]])
/** @type {StructCodec<WriteLimit>} */
const writeLimit = struct([['records', c.uint], ['periodMs', c.uint]])
const optWriteLimit = {
  /**
   * @param {c.State} state
   * @param {WriteLimit | false | null | undefined} v
   */
  preencode (state, v) { c.bool.preencode(state, !!v); if (v) writeLimit.preencode(state, v) },
  /**
   * @param {c.State} state
   * @param {WriteLimit | false | null | undefined} v
   */
  encode (state, v) { c.bool.encode(state, !!v); if (v) writeLimit.encode(state, v) },
  /**
   * @param {c.State} state
   */
  decode (state) { return c.bool.decode(state) ? writeLimit.decode(state) : null }
}

// A list of strings at the end of a decision, absent from entries written
// before it existed (decoded as null).
const optTrailingStrings = {
  /**
   * @param {c.State} state
   * @param {string[] | null | undefined} v
   */
  preencode (state, v) { c.bool.preencode(state, !!v); if (v) c.array(c.string).preencode(state, v) },
  /**
   * @param {c.State} state
   * @param {string[] | null | undefined} v
   */
  encode (state, v) { c.bool.encode(state, !!v); if (v) c.array(c.string).encode(state, v) },
  /**
   * @param {c.State} state
   */
  decode (state) { return state.start < state.end && c.bool.decode(state) ? c.array(c.string).decode(state) : null }
}

const optTrailingString = {
  /**
   * @param {c.State} state
   * @param {string | null | undefined} v
   */
  preencode (state, v) { c.bool.preencode(state, v != null); if (v != null) c.string.preencode(state, v) },
  /**
   * @param {c.State} state
   * @param {string | null | undefined} v
   */
  encode (state, v) { c.bool.encode(state, v != null); if (v != null) c.string.encode(state, v) },
  /**
   * @param {c.State} state
   */
  decode (state) { return state.start < state.end && c.bool.decode(state) ? c.string.decode(state) : null }
}

const optTrailingBool = {
  /**
   * @param {c.State} state
   * @param {boolean | null | undefined} v
   */
  preencode (state, v) { c.bool.preencode(state, v != null); if (v != null) c.bool.preencode(state, v) },
  /**
   * @param {c.State} state
   * @param {boolean | null | undefined} v
   */
  encode (state, v) { c.bool.encode(state, v != null); if (v != null) c.bool.encode(state, v) },
  /**
   * @param {c.State} state
   */
  decode (state) { return state.start < state.end && c.bool.decode(state) ? c.bool.decode(state) : null }
}

/** @type {Record<string, StructFields>} */
const DECISIONS = {
  'space/init': [['name', c.string], ['parent', optFixed32], ['private', c.bool], ['policy', c.string], ['version', c.uint], ['proof', c.buffer], ['circle', optTrailingBool]],
  'member/add': [['identity', c.fixed32]],
  'member/remove': [['identity', c.fixed32], ['cut', c.array(cutEntry)]],
  'role/define': [['name', c.string], ['permissions', c.array(c.string)]],
  'role/set': [['identity', c.fixed32], ['role', c.string], ['cut', c.array(cutEntry)]],
  moderate: [['action', c.string], ['target', c.buffer], ['reason', c.string], ['cut', c.array(cutEntry)], ['drop', optTrailingString]],
  'invite/create': [['invite', c.buffer]],
  'invite/revoke': [['invite', c.buffer]], // the encoded invite: its maker may revoke it
  'invite/redeem': [['redemption', c.buffer]],
  'key/rotate': [['epoch', c.uint], ['commit', c.fixed32]],
  'subspace/create': [['key', c.fixed32], ['name', c.string], ['private', c.bool], ['writeRoles', c.array(c.string)]],
  // rules: the ids of the app rules the space runs
  // helpers: the blind peers' keys (hex) keeping the space; [] clears
  // public: true makes the scope public for good
  'settings/set': [['policy', optString], ['writeLimit', optWriteLimit], ['rules', optTrailingStrings], ['history', optTrailingString], ['helpers', optTrailingStrings], ['public', optTrailingBool]],
  // a device's claim of its writer key, and a
  // device removal signed by the identity key (the record's bytes)
  'writer/add': [['key', c.fixed32], ['proof', c.buffer]],
  'device/remove': [['device', c.fixed32], ['cut', c.buffer], ['proof', c.buffer]],
  // a decision about a sub-space, kept in its
  // parent's decision log: the sub-space's key and the decision itself
  scoped: [['space', c.fixed32], ['decision', c.buffer]],
  // logs a member who records decisions holds, so members find
  // them on a helper without meeting their authors
  'logs/list': [['logs', c.array(listedLog)]],
  // the space's record types (Types#describe() as compact JSON),
  // version n + 1 of n; a top space's only
  'types/set': [['version', c.uint], ['types', c.string]],
  // a renewed space's state, copied from the space it renews
  // (`entries`: JSON [[view key, value]], in chunks, `last` on the final one;
  // `hash`: of every chunk, which the old space's `space/moved` names too)
  'space/renewed': [['from', c.fixed32], ['hash', c.fixed32], ['entries', c.string], ['last', c.bool]],
  // the space moved: where to (the new key, its disk key and its
  // sub-spaces' new keys), sealed to each current device; `hash` as above
  'space/moved': [['boxes', c.array(struct([['to', c.fixed32], ['sealed', c.buffer]]))], ['hash', c.fixed32]],
  // records before `before` (a stamp) go: each log counts from
  // `length` on (its header stays)
  'history/trim': [['before', c.uint], ['logs', c.array(cutEntry)]]
}
/** @type {string[]} */
const DECISION_TYPES = Object.keys(DECISIONS)
/** @type {Record<string, StructCodec<any>>} */
const DECISION_BODIES = Object.fromEntries(DECISION_TYPES.map((t) => [t, struct(DECISIONS[t])]))

/** @type {Codec<Decision>} */
const decision = {
  /**
   * @param {c.State} state
   * @param {Decision} d
   */
  preencode (state, d) {
    const body = bodyOf(d.type)
    c.uint.preencode(state, DECISION_TYPES.indexOf(d.type))
    c.uint.preencode(state, d.stamp)
    body.preencode(state, d)
  },
  /**
   * @param {c.State} state
   * @param {Decision} d
   */
  encode (state, d) {
    const body = bodyOf(d.type)
    c.uint.encode(state, DECISION_TYPES.indexOf(d.type))
    c.uint.encode(state, d.stamp)
    body.encode(state, d)
  },
  /**
   * @param {c.State} state
   */
  decode (state) {
    const type = DECISION_TYPES[c.uint.decode(state)]
    if (!type) throw new Error('Unknown decision type')
    const stamp = c.uint.decode(state)
    return { type, stamp, ...DECISION_BODIES[type].decode(state) }
  }
}

/**
 * @param {string} type
 */
function bodyOf (type) {
  const body = DECISION_BODIES[type]
  if (!body) throw new Error(`Unknown decision type: ${type}`)
  return body
}


/**
 * @typedef {{ space: Uint8Array, id: Uint8Array, role: string, uses: number, expires: number, subspaces: Uint8Array[], maker: Uint8Array }} InviteBody
 * @typedef {InviteBody & { proof: Uint8Array }} Invite
 * @typedef {{ invite: Invite, identity: Uint8Array, writer: Uint8Array, proof: Uint8Array }} Redemption
 */
/** @type {StructCodec<InviteBody>} */
const inviteBody = struct([
  ['space', c.fixed32], ['id', c.buffer], ['role', c.string], ['uses', c.uint], ['expires', c.uint],
  ['subspaces', c.array(c.fixed32)], ['maker', c.fixed32]
])
/** @type {StructCodec<Invite>} */
const invite = struct([...inviteBody.fields, ['proof', c.buffer]])
/** @type {StructCodec<Redemption>} */
const redemption = struct([['invite', invite], ['identity', c.fixed32], ['writer', c.fixed32], ['proof', c.buffer]])


// `records`, how many records the sender's logs hold (a trailing
// field: 0 from a sender without it)
/** @type {Codec<{ count: number, digest: Uint8Array, records?: number }>} */
const summary = {
  /**
   * @param {c.State} state
   * @param {{ count: number, digest: Uint8Array, records?: number }} m
   */
  preencode (state, m) { c.uint.preencode(state, m.count); c.fixed32.preencode(state, m.digest); c.uint.preencode(state, m.records || 0) },
  /**
   * @param {c.State} state
   * @param {{ count: number, digest: Uint8Array, records?: number }} m
   */
  encode (state, m) { c.uint.encode(state, m.count); c.fixed32.encode(state, m.digest); c.uint.encode(state, m.records || 0) },
  /**
   * @param {c.State} state
   */
  decode (state) {
    const count = c.uint.decode(state)
    const digest = c.fixed32.decode(state)
    return { count, digest, records: state.start < state.end ? c.uint.decode(state) : 0 }
  }
}
/** @type {StructCodec<{ prefix: Uint8Array, bits: number, parts: { count: number, digest: Uint8Array }[] }>} */
const ranges = struct([['prefix', c.buffer], ['bits', c.uint], ['parts', c.array(struct([['count', c.uint], ['digest', c.fixed32]]))]])
/** @type {StructCodec<{ prefix: Uint8Array, bits: number, kind: number, keys: Uint8Array[], lengths: number[] }>} */
const keys = struct([['prefix', c.buffer], ['bits', c.uint], ['kind', c.uint], ['keys', c.array(c.fixed32)], ['lengths', c.array(c.uint)]])
const logKey = c.fixed32
/** @type {StructCodec<{ redemption: Uint8Array }>} */
const redeem = struct([['redemption', c.buffer]])
/** @type {StructCodec<{ decision: Uint8Array }>} */
const ask = struct([['decision', c.buffer]]) // a decision for a writer to record

/**
 * @param {StructFields} fields
 * @returns {StructCodec<any>} Each caller names its shape (the one `any`: a struct is built field by field).
 */
function struct (fields) {
  return {
    fields,
    /**
     * @param {c.State} state
     * @param {Record<string, unknown>} v
     */
    preencode (state, v) { for (const [name, codec] of fields) codec.preencode(state, v[name]) },
    /**
     * @param {c.State} state
     * @param {Record<string, unknown>} v
     */
    encode (state, v) { for (const [name, codec] of fields) codec.encode(state, v[name]) },
    /**
     * @param {c.State} state
     */
    decode (state) {
      /** @type {Record<string, unknown>} */
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
  ranges,
  keys,
  logKey,
  redeem,
  ask,
  struct
}

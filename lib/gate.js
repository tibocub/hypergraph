// Readers enforce: nothing of a log is kept, indexed or passed on before
// these checks: the log (its header's proof, its
// author may write, up to its cut), and each record (decodes, matches its
// type, links to allowed types, edits and deletes by allowed editors). App
// rules (brokenRule) are checked by the indexer and by the writer's own app.

const b4a = require('b4a')
const enc = require('./encodings.js')
const { readHeader } = require('./log.js')

// May this log be kept, and how much of it? { ok: true, identity, device,
// limit } (records below `limit` count; Infinity without a cut) | { ok:
// false, retry } (retry: valid but its author may not write yet; the decision
// may come). A log whose author was removed or banned later, or whose device
// was removed, is still kept up to its cut, by old members and newcomers
// alike. `limits`: limitOf(identity, device, log) and
// mayRetry(identity, device, log), and the space's decision log key
// (`decisions`: its own, or a sub-space's top space) (lib/space.js).
/**
 * @typedef {import('./types.js').Types} Types
 * @typedef {import('./decisions/state.js').AnyState} AnyState
 * @typedef {import('./encodings.js').WireRecord} WireRecord
 * @typedef {WireRecord & { unreadable?: boolean }} OpenRecord
 * @typedef {{ ok: false, retry: false, reason: string } | ({ ok: false, retry: boolean, reason: string } & import('./log.js').LogAuthor) | ({ ok: true, limit: number } & import('./log.js').LogAuthor)} LogCheck
 * @typedef {{ ok: false, reason: string, locked?: boolean } | { ok: true, record: OpenRecord, values: Record<string, any> | null }} RecordCheck `values`: as the type's fields decode (null: a type this app doesn't know).
 */

/**
 * What a rule gets: the record's fields, and its id, type, author, device (z32) and stamp.
 * @typedef {Record<string, any> & { id: string | null, type: string, author: string, device: string, stamp: number }} RuleRecord
 */

/**
 * An app rule: `validate(record, { space })` returning false or throwing rejects the record. It must be deterministic and look only at the record.
 * @typedef {{ id: string, validate (record: RuleRecord, ctx: { space: string }): boolean | void }} Rule
 * @typedef {Rule[]} Rules
 */

/**
 * @param {Uint8Array | null} headerBytes
 * @param {Uint8Array} logKey
 * @param {Uint8Array} space
 * @param {{ decisions?: Uint8Array, limitOf: (identity: Uint8Array, device: Uint8Array, log: Uint8Array, admitted: string | null) => number, mayRetry: (identity: Uint8Array, device: Uint8Array, log: Uint8Array) => boolean }} limits
 * @returns {LogCheck}
 */
function checkLog (headerBytes, logKey, space, limits) {
  const who = readHeader(headerBytes, logKey, space, limits.decisions || space)
  if (!who) return { ok: false, retry: false, reason: 'bad header' }
  const limit = limits.limitOf(who.identity, who.device, logKey, who.admitted)
  if (limit <= 1) return { ok: false, retry: limits.mayRetry(who.identity, who.device, logKey), reason: 'may not write', ...who }
  return { ok: true, limit, ...who }
}

// Decodes a record block and checks it against its type. Returns
// { ok, record, values } — values null for types this app doesn't know
// (another app version may: kept and indexed by type, not decoded), and
// hypergraph's own types this version doesn't know (a newer version's: kept
// the same way; apps can't write them).
// `unseal(record)` (a private space's): the record with its fields
// and links opened; null if its epoch's key isn't held here (locked); false if
// it must not count (a box that doesn't open, a change written in the clear);
// marked `unreadable` for a put written in the clear (shown as such, never as
// content).
/**
 * @param {Uint8Array} bytes
 * @param {Types} types
 * @param {((record: WireRecord) => OpenRecord | false | null) | null} [unseal]
 * @returns {RecordCheck}
 */
function checkRecord (bytes, types, unseal = null) {
  let record = null
  try { record = enc.decodeRecord(bytes) } catch { return { ok: false, reason: 'malformed' } }
  if ((record.kind === enc.PUT) === !!record.target) return { ok: false, reason: 'target on a put, or none on a change' }
  if (unseal) {
    const opened = unseal(record)
    if (!opened) return { ok: false, locked: opened === null, reason: opened === null ? 'locked' : 'does not open' }
    record = opened
    if (record.unreadable) return { ok: true, record, values: null }
  }
  if (!types.has(record.type)) return { ok: true, record, values: null }
  if (record.kind === enc.DELETE) return { ok: true, record, values: {} }
  let values = null
  try { values = types.decode(record.type, record.fields, record.links) } catch { return { ok: false, reason: 'fields do not decode' } }
  return { ok: true, record, values }
}

// Do the record's link fields point at allowed types? `typeOf(id)` gives the
// target's type when it is held, else null: a link to a record not held yet
// is accepted (it can arrive later). The writer's own app
// checks it before writing; readers never refuse a record for it, they judge
// each link when they read it (linkCounts).
/**
 * @param {Types} types
 * @param {string} type
 * @param {Record<string, unknown> | null} values
 * @param {(id: string) => Promise<string | null> | string | null} typeOf
 */
async function linksAllowed (types, type, values, typeOf) {
  if (!values || !types.has(type)) return true
  for (const f of types.get(type).fields) {
    if (f.kind !== 'link' || !values[f.name]) continue
    const target = await typeOf(/** @type {string} */ (values[f.name]))
    if (target && !types.linkAllowed(type, f.name, target)) return false
  }
  return true
}

// Does a record of `type` point at `target` (a record id string, held here
// with type `targetType`) through a link that counts? It
// counts unless every field of the record pointing at it doesn't allow
// targetType; a target not held (null type) counts as written. Records of
// a type this app doesn't know, and links through fields it doesn't know
// (a newer version's), count as written. `values` null: the record's fields
// aren't here (content dropped): null when they matter.
/**
 * @param {Types} types
 * @param {string} type
 * @param {Record<string, unknown> | null} values
 * @param {string} target
 * @param {string | null} targetType
 * @returns {boolean | null}
 */
function linkCounts (types, type, values, target, targetType) {
  if (!targetType || !types.has(type)) return true
  const fields = types.get(type).fields.filter((f) => f.kind === 'link')
  const allowing = fields.filter((f) => types.linkAllowed(type, f.name, targetType))
  if (allowing.length === fields.length) return true
  if (!values) return null
  const via = fields.filter((f) => values[f.name] === target)
  return !via.length || via.some((f) => allowing.includes(f))
}

// May a change (an edit or a delete: { kind, type, author, id }) apply to
// `target` (an indexed row)? A delete only by the target's author, whatever
// the type (moderators take records down by decision).
/**
 * @param {Types} types
 * @param {{ kind: number, type: string, author: Uint8Array, id: import('./encodings.js').IdLike | null }} change
 * @param {{ type: string, author: Uint8Array }} target
 * @param {AnyState} state
 */
function mayChange (types, change, target, state) {
  if (change.type !== target.type) return false
  if (change.kind === enc.DELETE) return b4a.equals(change.author, target.author)
  return mayEdit(types, change, target, state)
}

// May `who` ({ author, id }: a record by `author` at `id`, or id null for one
// about to be written) edit `target`, relate from it or tag it? Its author
// always; any member for 'members' (a record that reached here passed its
// log's limit, so its author could write then); for
// { permission }, an editor's record counts below the cut recorded when they
// lost it, and while they hold it if no cut names its log.
/**
 * @param {Types} types
 * @param {{ author: Uint8Array, id: import('./encodings.js').IdLike | null }} who
 * @param {{ type: string, author: Uint8Array }} target
 * @param {AnyState} state
 * @returns {boolean}
 */
function mayEdit (types, who, target, state) {
  if (b4a.equals(who.author, target.author)) return true
  /** @type {import('./types.js').Rule} */
  const editable = types.has(target.type) ? types.get(target.type).editable : { by: 'author' }
  if (editable.by === 'author') return false
  if (editable.by === 'members') return who.id ? true : state.canWrite(who.author)
  if (!who.id) return state.can(who.author, editable.permission)
  const { log, seq } = enc.idParts(who.id)
  return seq < state.editLimit(who.author, editable.permission, log)
}

// does a put of a type restricted to a permission count?
// Judged when read, like edits of a shared type: below the cut recorded when
// its author lost the permission, everything while they hold it (the owner
// always), nothing otherwise.
/**
 * @param {Types} types
 * @param {{ type: string, id: import('./encodings.js').IdLike, author: Uint8Array }} row
 * @param {AnyState} state
 */
function mayPut (types, row, state) {
  /** @type {import('./types.js').Rule | null} */
  const put = types.has(row.type) ? types.get(row.type).put : null
  if (!put || put.by !== 'permission') return true
  const { log, seq } = enc.idParts(row.id)
  return seq < state.editLimit(row.author, put.permission, log)
}

const MAX_DATA = 4096

// Hypergraph's graph records (hg/relation, hg/tag) are only puts, with what
// they need; other types are not concerned.
/**
 * @param {{ type: string, kind: number }} record
 * @param {import('./fields.js').DecodedFields | null} values
 */
function builtinValid (record, values) {
  if (record.type !== 'hg/relation' && record.type !== 'hg/tag') return true
  if (record.kind !== enc.PUT || !values) return false
  if (record.type === 'hg/tag') return !!values.on && typeof values.tag === 'string' && values.tag.length > 0
  if (!values.from || !values.to || typeof values.rel !== 'string' || !values.rel) return false
  if (values.value !== null && values.value !== undefined && !Number.isFinite(values.value)) return false
  return values.data === null || values.data === undefined || b4a.byteLength(values.data) <= MAX_DATA
}

// The app's rules (Hypergraph.open(dir, { rules })): [{ id, validate(record,
// ctx) }]. A rule rejects a record by returning false or throwing; it must be
// deterministic (every member runs it and must agree) and look only at the
// record. Returns the id of the first rule that rejects it, or null.
/**
 * @param {Rules} rules
 * @param {RuleRecord} record
 * @param {{ space: string }} ctx
 * @returns {string | null}
 */
function brokenRule (rules, record, ctx) {
  for (const rule of rules) {
    let ok = false
    try { ok = rule.validate(record, ctx) !== false } catch {}
    if (!ok) return rule.id
  }
  return null
}

/**
 * @param {Rules} rules
 * @returns {Rules}
 */
function declareRules (rules) {
  if (!Array.isArray(rules)) throw new TypeError('rules is a list of { id, validate (record, ctx) }')
  for (const rule of rules) {
    if (!rule || typeof rule.id !== 'string' || typeof rule.validate !== 'function') throw new TypeError('A rule is { id: string, validate (record, ctx) }')
  }
  return [...rules]
}

module.exports = { checkLog, checkRecord, linksAllowed, linkCounts, mayChange, mayEdit, mayPut, builtinValid, brokenRule, declareRules, MAX_DATA }

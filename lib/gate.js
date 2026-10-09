// Readers enforce (research R11): nothing of a log is kept, indexed or passed
// on before these checks. Story 1's part: the log (its header's proof, its
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
// alike (research.md A4, A7). `limits`: limitOf(identity, device, log) and
// mayRetry(identity, device, log) (lib/space.js).
function checkLog (headerBytes, logKey, space, limits) {
  const who = readHeader(headerBytes, logKey, space)
  if (!who) return { ok: false, retry: false, reason: 'bad header' }
  const limit = limits.limitOf(who.identity, who.device, logKey)
  if (limit <= 1) return { ok: false, retry: limits.mayRetry(who.identity, who.device, logKey), reason: 'may not write', ...who }
  return { ok: true, limit, ...who }
}

// Decodes a record block and checks it against its type. Returns
// { ok, record, values } — values null for types this app doesn't know
// (another app version may: kept and indexed by type, not decoded).
function checkRecord (bytes, types) {
  let record = null
  try { record = enc.decodeRecord(bytes) } catch { return { ok: false, reason: 'malformed' } }
  if ((record.kind === enc.PUT) === !!record.target) return { ok: false, reason: 'target on a put, or none on a change' }
  if (!types.has(record.type)) return { ok: !record.type.startsWith('hg/'), record, values: null }
  if (record.kind === enc.DELETE) return { ok: true, record, values: {} }
  let values = null
  try { values = types.decode(record.type, record.fields, record.links) } catch { return { ok: false, reason: 'fields do not decode' } }
  return { ok: true, record, values }
}

// Do the record's link fields point at allowed types? `typeOf(id)` gives the
// target's type when it is held, else null: a link to a record not held yet
// is accepted (it can arrive later; research.md A3).
async function linksAllowed (types, type, values, typeOf) {
  if (!values || !types.has(type)) return true
  for (const f of types.get(type).fields) {
    if (f.kind !== 'link' || !values[f.name]) continue
    const target = await typeOf(values[f.name])
    if (target && !types.linkAllowed(type, f.name, target)) return false
  }
  return true
}

// May `author` edit or delete `target` (an indexed row)?
function mayChange (types, change, target, state) {
  if (change.type !== target.type) return false
  const editable = types.has(target.type) ? types.get(target.type).editable : { by: 'author' }
  if (editable.by === 'author') return b4a.equals(change.author, target.author)
  // A change that reached here passed its log's limit: its author could write
  // when writing it (a removal later doesn't undo it: research.md A4).
  if (editable.by === 'members') return true
  return b4a.equals(change.author, target.author) || state.can(change.author, editable.permission)
}

// The app's rules (Hypergraph.open(dir, { rules })): [{ id, validate(record,
// ctx) }]. A rule rejects a record by returning false or throwing; it must be
// deterministic (every member runs it and must agree) and look only at the
// record. Returns the id of the first rule that rejects it, or null.
function brokenRule (rules, record, ctx) {
  for (const rule of rules) {
    let ok = false
    try { ok = rule.validate(record, ctx) !== false } catch {}
    if (!ok) return rule.id
  }
  return null
}

// Checks the rules' declaration at open.
function declareRules (rules) {
  if (!Array.isArray(rules)) throw new TypeError('rules is a list of { id, validate (record, ctx) }')
  for (const rule of rules) {
    if (!rule || typeof rule.id !== 'string' || typeof rule.validate !== 'function') throw new TypeError('A rule is { id: string, validate (record, ctx) }')
  }
  return [...rules]
}

module.exports = { checkLog, checkRecord, linksAllowed, mayChange, brokenRule, declareRules }

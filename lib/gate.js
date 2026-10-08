// Readers enforce (research R11): nothing of a log is kept, indexed or passed
// on before these checks. Story 1's part: the log (its header's proof, its
// author a member), and each record (decodes, matches its type, links to
// allowed types, edits and deletes by allowed editors). Cuts, app rules and
// moderation come with story 2.

const b4a = require('b4a')
const enc = require('./encodings.js')
const { readHeader } = require('./log.js')

// May this log be kept? { ok: true, identity, device } | { ok: false, retry }
// (retry: valid but its author isn't a member yet; the decision may come).
function checkLog (headerBytes, logKey, space, state) {
  const who = readHeader(headerBytes, logKey, space)
  if (!who) return { ok: false, retry: false, reason: 'bad header' }
  if (!state.isMember(who.identity)) return { ok: false, retry: true, reason: 'not a member', ...who }
  return { ok: true, ...who }
}

// Decodes a record block and checks it against its type. Returns
// { ok, record, values } — values null for types this app doesn't know
// (another app version may: kept and indexed by type, not decoded).
function checkRecord (bytes, types) {
  let record = null
  try { record = enc.decodeRecord(bytes) } catch { return { ok: false, reason: 'malformed' } }
  if ((record.kind === enc.PUT) === !!record.target) return { ok: false, reason: 'target on a put, or none on a change' }
  if (record.type.startsWith('hg/')) return { ok: false, reason: 'built-in types come later' }
  if (!types.has(record.type)) return { ok: true, record, values: null }
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
  if (editable.by === 'members') return state.isMember(change.author)
  return b4a.equals(change.author, target.author) || state.can(change.author, editable.permission)
}

module.exports = { checkLog, checkRecord, linksAllowed, mayChange }

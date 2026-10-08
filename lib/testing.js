// For hypergraph's own tests only, never for apps: ways around the API's own
// checks, to play a misbehaving peer (writing records the API would refuse)
// and to look at what a member holds.
//
//   const testing = require('hypergraph/lib/testing.js')

const b4a = require('b4a')
const z32 = require('z32')
const enc = require('./encodings.js')
const symbols = require('./symbols.js')
const { idOf } = require('./index/query.js')

const KINDS = { put: enc.PUT, edit: enc.EDIT, delete: enc.DELETE }
const hex = (b) => b4a.toString(b, 'hex')

// Appends a record to this device's log in `space`, bypassing every check.
async function writeRaw (space, { kind, type, target = null, fields = {} }) {
  const encoded = space.types.has(type) ? space.types.encode(type, fields) : { fields: b4a.alloc(0), links: [] }
  const seq = await space.own.append({ kind: KINDS[kind], type, stamp: space.hg._stamper.next(), target: target ? idOf(target) : null, links: encoded.links, fields: encoded.fields })
  return enc.idToString({ log: space.own.key, seq })
}

// Appends a decision to the space's decision log as this device, bypassing
// the API's own permission checks (record ids may be given as strings).
async function decide (space, decision) {
  const d = { ...decision }
  if (typeof d.target === 'string') d.target = idOf(d.target)
  await space.decisions.append(d)
}

// Does this member hold the block of record `id`?
async function holdsBlock (space, id) {
  const { log, seq } = enc.idParts(idOf(id))
  const held = space.directory.logs.get(hex(log))
  return held ? held.core.has(seq) : false
}

// The device logs in this member's directory of `space`.
function logs (space) {
  return space.directory.keys().map((k) => z32.encode(k))
}

// This device's log in `space`.
function ownLog (space) {
  return z32.encode(space.own.key)
}

// Opens a space by key without being let in (a stranger writing "into" it).
function openSpace (hg, key) {
  return hg[symbols.openSpace](key)
}

module.exports = { writeRaw, decide, holdsBlock, logs, ownLog, openSpace }

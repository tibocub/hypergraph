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

// Appends a record to this device's log in `space`, bypassing every check
// (`stamp`: a chosen one, e.g. to make two members' records tie).
async function writeRaw (space, { kind, type, target = null, fields = {}, stamp = null }) {
  const encoded = space.types.has(type) ? space.types.encode(type, fields) : { fields: b4a.alloc(0), links: [] }
  const seq = await space.own.append({ kind: KINDS[kind], type, stamp: stamp ?? space.hg._stamper.next(), target: target ? idOf(target) : null, links: encoded.links, fields: encoded.fields })
  return enc.idToString({ log: space.own.key, seq })
}

// Appends a decision to the space's decision log as this device, bypassing
// the API's own permission checks (record ids may be given as strings).
async function decide (space, decision) {
  const d = { ...decision }
  if (typeof d.target === 'string') d.target = idOf(d.target)
  await space.decisionLog.append(d)
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

// Opens a space by key without being let in (a stranger writing "into" it);
// `encryptionKey` for a personal space whose keys leaked (personalKeys).
function openSpace (hg, key, { encryptionKey = null } = {}) {
  return hg[symbols.openSpace](key, { encryptionKey })
}

// The personal space's encryption key (to play a stranger who got it).
function personalKeys (hg) {
  return { encryptionKey: hg.personal.encryptionKey }
}

// Tells every peer of `space` about this device's log there, as a peer
// pushing its log would, member or not.
function announce (space) {
  for (const ch of space.directory.channels) ch.messages[3].send(space.own.key)
}

// The block of record `id` as stored and sent: encrypted in a personal space.
async function rawBlock (space, id) {
  const { log, seq } = enc.idParts(idOf(id))
  const held = space.directory.logs.get(hex(log))
  return held ? held.core.get(seq, { wait: false, decrypt: false }) : null
}

// Runs this instance's clock `offset` ms ahead (or behind) for its stamps.
function setClock (hg, offset) {
  hg._stamper.now = () => Date.now() + offset
}

// Writes this device's heads to the personal space now.
function writeHeads (hg) {
  return hg._writeHeads()
}

// A device's last heads as `hg` sees them: [{ space, log, length }].
async function headsOf (hg, device) {
  const c = require('compact-encoding')
  const key = { space: hg.personal.keyBytes, type: 'hg/heads' }
  let last = null
  for (const row of await hg.db.find('@hg/by-type', { gte: key, lte: key }).toArray()) {
    if (b4a.equals(row.device, z32.decode(device))) last = hg._types.decode('hg/heads', row.fields, row.links)
  }
  if (!last) return []
  const list = c.array(enc.struct([['space', c.fixed32], ['log', c.fixed32], ['length', c.uint]]))
  return c.decode(list, last.heads).map((h) => ({ space: z32.encode(h.space), log: z32.encode(h.log), length: h.length }))
}

// Writes a removal of `device` signed with `recoveryPhrase` in every space
// of `hg`, skipping the API's check that the device is one of the account's.
async function removeDeviceAnyway (hg, device, recoveryPhrase) {
  const { Identity } = require('./identity.js')
  await hg._removeDevice(z32.decode(device), await Identity.secrets(recoveryPhrase))
}

// An invite link signed by this member, skipping the API's checks of who
// may invite to what (a modified app).
function inviteAnyway (space, { role = 'member', uses = 1, expires = 0 } = {}) {
  const invites = require('./invites.js')
  return invites.encodeLink(invites.makeInvite({ space: space.keyBytes, role, uses, expires, subspaces: [] }, space.hg._identity))
}

// How much of the decision log is settled (indexed by Autobase) here.
function settled (space) {
  return space.decisionLog.base.indexedLength
}

// The keys settling the decision order (Autobase's indexers), as this member sees them.
function settlers (space) {
  const lin = space.decisionLog.base.linearizer
  return lin ? lin.indexers.map((w) => z32.encode(w.core.key)) : []
}

// This device's key in the decision log of `space`.
function ownSettlerKey (space) {
  return z32.encode(space.decisionLog.localKey)
}

// Reclaims the disk space of dropped content now: the step an instance runs
// by itself after dropping a tenth of its budget, at most every 10 minutes
// (lib/index.js). RocksDB keeps recent writes in its write-ahead log, and
// cleared data in older files, until it compacts.
function compact (hg) {
  return hg._reclaimNow()
}

// The next instance opened "crashes" after `n` indexing batches: nothing
// commits after them, as if the process had died there.
function crashAfter (n) {
  const { WriteQueue } = require('./index/indexer.js')
  WriteQueue[symbols.crashAfter] = n
}

// Has `hg` crashed (crashAfter)?
function crashed (hg) {
  return hg._queue.crashed
}

// How many blocks this member indexed in `space` since opening.
function indexedBlocks (space) {
  return space.indexer.blocks
}

module.exports = { crashAfter, crashed, indexedBlocks, compact, inviteAnyway, settled, settlers, ownSettlerKey, removeDeviceAnyway, writeRaw, decide, holdsBlock, logs, ownLog, openSpace, personalKeys, announce, rawBlock, setClock, writeHeads, headsOf }

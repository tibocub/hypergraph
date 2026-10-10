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
// `encryptionKey` for a personal space whose keys leaked (personalKeys);
// `root`: a sub-space's top space (a relay holding a private sub-space).
function openSpace (hg, key, { encryptionKey = null, root = null } = {}) {
  return hg[symbols.openSpace](key, { encryptionKey, root })
}

// The epoch keys of a private space this member holds (to check none shows).
function epochKeys (space) {
  return space[symbols.epochKeys]()
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

// Makes this member ignore the log notices and activity entries (`notices`) and directory
// summaries (`summaries`) its peers send in `space`, as if they were lost.
// Returns restore(); restore.dropped lists the summaries dropped: [{ peer
// (device key), digest (as digestOf gives it) }].
function deafen (space, { notices = false, summaries = false } = {}) {
  const dir = space.directory
  const dropped = []
  dir[symbols.deaf] = { notices, summaries, dropped }
  const restore = () => { dir[symbols.deaf] = null }
  restore.dropped = dropped
  return restore
}

// The digest of this member's directory of `space` (what its summary says).
function digestOf (space) {
  return b4a.toString(space.directory.digest, 'hex')
}

// The block of record `id` as stored and sent: encrypted in a personal space.
async function rawBlock (space, id) {
  const { log, seq } = enc.idParts(idOf(id))
  const held = space.directory.logs.get(hex(log))
  return held ? held.core.get(seq, { wait: false, decrypt: false }) : null
}

// Runs this instance's clock `offset` ms ahead (or behind) for its stamps;
// `decisions`: for the decisions it records too (a space created in the past).
function setClock (hg, offset, { decisions = false } = {}) {
  hg._stamper.now = () => Date.now() + offset
  if (decisions) hg._clockOffset = offset
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

// A log a modified app prepares (e.g. during a ban): the next log this device
// would open in `space`, made now, with one record in it, announced to every
// peer. Returns { log (z32), announce() }.
async function prepareLog (space, { type = 'post', fields = {} } = {}) {
  const { OwnLog } = require('./log.js')
  const me = space.hg._identity
  const own = new OwnLog(space.store.get({ name: `log/${space.own.generation + 1}`, ...space._coreOpts }), { space: space.keyBytes, identity: me, decisions: space.top })
  await own.ready()
  const encoded = space.types.encode(type, fields)
  await own.append({ kind: enc.PUT, type, stamp: space.hg._stamper.next(), target: null, links: encoded.links, fields: encoded.fields })
  const announce = () => { for (const ch of space.directory.channels) ch.messages[3].send(own.key) }
  announce()
  return { log: z32.encode(own.key), announce }
}

// Makes `hg` look at the lists of logs its peers send `ms` late (a slow
// network), in the spaces it opens from now on.
function slowLists (hg, ms) {
  hg[symbols.slowLists] = ms
}

// --- story 9: activity lists and big spaces ---

// The activity entries this member keeps in `space` from period `from` on:
// [{ log (z32), period, start }].
async function activity (space, from = 0) {
  return (await space.activity.list(from)).map((r) => ({ log: z32.encode(r.log), period: r.period, start: r.start }))
}

// Sends activity entries ({ log (z32 or bytes), period, start }) to every
// peer of `space`, as a peer would (true or false, checked or not).
function sendActivity (space, entries) {
  for (const ch of space.directory.channels) {
    for (const e of entries) ch.messages[8].send({ log: typeof e.log === 'string' ? z32.decode(e.log) : e.log, period: e.period, start: e.start })
  }
}

// Records the activity entries this member receives in `space` from now on:
// returns the list, [{ peer (device key z32), log (z32), period, start }].
function listen (space) {
  const heard = []
  space.activity.listen = {
    push: (e) => heard.push({ peer: e.peer ? z32.encode(e.peer) : null, log: z32.encode(e.log), period: e.period, start: e.start })
  }
  return heard
}

// When a newcomer reads a space newest first (a peer holds more than
// `records` records) and by activity lists (more than `logs` logs): the
// switch-over points, lowered for tests. Returns restore().
function bigSpaces ({ logs, records }) {
  const { BIG } = require('./space.js')
  const before = { ...BIG }
  if (logs !== undefined) BIG.logs = logs
  if (records !== undefined) BIG.records = records
  return () => Object.assign(BIG, before)
}

// How this member reads `space`: { horizon (first period read, null:
// everything), byActivity, reachedFrom, undecided }.
function reading (space) {
  return space._readingState()
}

// The first block read here of each log of `space`: { log z32: from }.
function readFrom (space) {
  const out = {}
  for (const log of space.directory.logs.values()) out[z32.encode(log.key)] = log.from
  return out
}

module.exports = { slowLists, prepareLog, activity, sendActivity, listen, bigSpaces, reading, readFrom, epochKeys, deafen, digestOf, crashAfter, crashed, indexedBlocks, compact, inviteAnyway, settled, settlers, ownSettlerKey, removeDeviceAnyway, writeRaw, decide, holdsBlock, logs, ownLog, openSpace, personalKeys, announce, rawBlock, setClock, writeHeads, headsOf }

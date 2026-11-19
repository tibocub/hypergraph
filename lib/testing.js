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

/**
 * @typedef {import('./space.js').Space} Space
 * @typedef {import('./index.js').Hypergraph} Hypergraph
 */

/** @type {Record<string, number>} */
const KINDS = { put: enc.PUT, edit: enc.EDIT, delete: enc.DELETE }
/** @param {Uint8Array} b */
const hex = (b) => b4a.toString(b, 'hex')

// Appends a record to this device's log in `space`, bypassing every check
// (`stamp`: a chosen one, e.g. to make two members' records tie).
/**
 * @param {Space} space
 * @param {{ kind: 'put' | 'edit' | 'delete', type: string, target?: string | null, fields?: Record<string, unknown>, stamp?: number | null }} record
 * @returns {Promise<string>}
 */
async function writeRaw (space, { kind, type, target = null, fields = {}, stamp = null }) {
  const encoded = space._types.has(type) ? space._types.encode(type, fields) : { fields: b4a.alloc(0), links: [] }
  const own = await space[symbols.ownLog]() // made known at its first record, as the app does
  const seq = await own.append({ kind: KINDS[kind], type, stamp: stamp ?? space.hg._stamper.next(), target: target ? idOf(target) : null, links: encoded.links, fields: encoded.fields })
  return enc.idToString({ log: own.key, seq })
}

// Appends a decision to the space's decision log as this device, bypassing
// the API's own permission checks (record ids may be given as strings).
/**
 * @param {Space} space
 * @param {Record<string, any> & { type: string }} decision Any decision, record ids as strings or bytes.
 */
async function decide (space, decision) {
  const d = { ...decision }
  if (typeof d.target === 'string') d.target = idOf(d.target)
  await space.decisionLog.append(/** @type {import('./encodings.js').DecisionBody} */ (d))
}

/**
 * @param {Space} space
 * @param {string} id
 */
async function holdsBlock (space, id) {
  const { log, seq } = enc.idParts(idOf(id))
  const held = space.directory.logs.get(hex(log))
  return held ? space.directory.has(held, seq) : false
}

/**
 * @param {Space} space
 */
function logs (space) {
  return space.directory.keys().map((k) => z32.encode(k))
}

/**
 * @param {Space} space
 */
function ownLog (space) {
  return z32.encode(space.own.key)
}

// Opens a space by key without being let in (a stranger writing "into" it);
// `encryptionKey` for a personal space whose keys leaked (personalKeys);
// `root`: a sub-space's top space (a relay holding a private sub-space).
/**
 * @param {Hypergraph} hg
 * @param {Uint8Array} key
 * @param {{ encryptionKey?: Uint8Array | null, root?: Uint8Array | null }} [opts]
 */
function openSpace (hg, key, { encryptionKey = null, root = null } = {}) {
  return hg[symbols.openSpace](key, { encryptionKey, root })
}

/**
 * @param {Space} space
 */
function epochKeys (space) {
  return space[symbols.epochKeys]()
}

/**
 * @param {Hypergraph} hg
 */
function personalKeys (hg) {
  return { encryptionKey: hg.personal.encryptionKey }
}

// Tells every peer of `space` about this device's log there, as a peer
// pushing its log would, member or not.
/**
 * @param {Space} space
 */
function announce (space) {
  for (const ch of space.directory.channels) ch.messages[3].send(space.own.key)
}

// Makes this member ignore the log notices and activity entries (`notices`) and directory
// summaries (`summaries`) its peers send in `space`, as if they were lost.
// Returns restore(); restore.dropped lists the summaries dropped: [{ peer
// (device key), digest (as digestOf gives it) }].
/**
 * @param {Space} space
 * @param {{ notices?: boolean, summaries?: boolean }} [opts]
 */
function deafen (space, { notices = false, summaries = false } = {}) {
  /** @type {import('./directory.js').Directory & { [symbols.deaf]?: { notices: boolean, summaries: boolean, dropped: { peer: string | null, digest: string }[] } | null }} */
  const dir = space.directory
  /** @type {{ peer: string | null, digest: string }[]} */
  const dropped = []
  dir[symbols.deaf] = { notices, summaries, dropped }
  const restore = () => { dir[symbols.deaf] = null }
  restore.dropped = dropped
  return restore
}

/**
 * @param {Space} space
 */
function digestOf (space) {
  return b4a.toString(space.directory.digest, 'hex')
}

/**
 * @param {Space} space
 * @param {string} id
 */
async function rawBlock (space, id) {
  const { log, seq } = enc.idParts(idOf(id))
  const held = space.directory.logs.get(hex(log))
  return held ? space.directory.get(held, seq, { wait: false, decrypt: false }) : null
}

/**
 * @param {Space} space
 */
function diskKey (space) {
  return space.encryptionKey || null
}

/**
 * @param {Space} space
 * @returns {Promise<Uint8Array[]>}
 */
async function coreKeys (space) {
  /** @type {Map<string, Uint8Array>} */
  const keys = new Map()
  /** @param {Uint8Array} k */
  const add = (k) => keys.set(hex(k), k)
  const base = space.decisionLog.base
  add(base.key)
  add(base.local.key)
  for await (const { key } of base.system.list()) add(key)
  for (const v of base.views()) add(v.key)
  add(space.own.key)
  add(space._idcore.key)
  for (const log of space.directory.logs.values()) add(log.key)
  return [...keys.values()]
}

// Every block `store` holds of `keys`, read without any key, as a holder
// (a relay, a blind peer, a copied disk) reads them.
/**
 * @param {import('corestore')} store
 * @param {Uint8Array[]} keys
 * @returns {Promise<Uint8Array[]>}
 */
async function rawBlocks (store, keys) {
  /** @type {Uint8Array[]} */
  const out = []
  for (const key of keys) {
    const core = store.get({ key })
    await core.ready()
    for (let i = 0; i < core.length; i++) {
      const block = await core.get(i, { wait: false }).catch(() => null)
      if (block) out.push(block)
    }
    await core.close()
  }
  return out
}

/**
 * @param {Uint8Array[]} blocks
 * @param {string | Uint8Array} needle
 */
function inClear (blocks, needle) {
  const n = typeof needle === 'string' ? b4a.from(needle) : needle
  return blocks.some((b) => b4a.includes(b, n))
}

// Runs this instance's clock `offset` ms ahead (or behind) for its stamps;
// `decisions`: for the decisions it records too (a space created in the past).
/**
 * @param {Hypergraph} hg
 * @param {number} offset
 * @param {{ decisions?: boolean }} [opts]
 */
function setClock (hg, offset, { decisions = false } = {}) {
  hg._stamper.now = () => Date.now() + offset
  if (decisions) hg._clockOffset = offset
}

// Migration tests: this instance records no types in its spaces (as
// before types were recorded per space), and `oldLayout` leaves its index as
// a folder from then: the folder-wide types, none per space.
/**
 * @param {Hypergraph} hg
 */
function recordNoTypes (hg) {
  hg._recordNoTypes = true
}

/**
 * @param {Hypergraph} hg
 */
async function oldLayout (hg) {
  const rows = (await hg.db.find('@hg/meta', {}).toArray()).filter((row) => /^(types|space):/.test(row.name))
  await hg._queue.run(async (tx) => {
    for (const row of rows) await tx.delete('@hg/meta', row)
    await tx.insert('@hg/meta', { name: 'types', value: b4a.from(JSON.stringify(hg._types.describe())) })
  })
}

/**
 * @param {Hypergraph} hg
 */
function writeHeads (hg) {
  return hg._writeHeads()
}

/**
 * @param {Hypergraph} hg
 * @param {string} device
 */
async function headsOf (hg, device) {
  const c = require('compact-encoding')
  const key = { space: hg.personal.keyBytes, type: 'hg/heads' }
  /** @type {Record<string, any> | null} */
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
/**
 * @param {Hypergraph} hg
 * @param {string} device
 * @param {string} recoveryPhrase
 */
async function removeDeviceAnyway (hg, device, recoveryPhrase) {
  const { Identity } = require('./identity.js')
  await hg._removeDevice(z32.decode(device), /** @type {NonNullable<Awaited<ReturnType<typeof Identity.secrets>>>} */ (await Identity.secrets(recoveryPhrase)))
}

// An invite link signed by this member, skipping the API's checks of who
// may invite to what (a modified app).
/**
 * @param {Space} space
 * @param {{ role?: string, uses?: number, expires?: number }} [opts]
 */
function inviteAnyway (space, { role = 'member', uses = 1, expires = 0 } = {}) {
  const invites = require('./invites.js')
  return invites.encodeLink(invites.makeInvite({ space: space.keyBytes, role, uses, expires, subspaces: [] }, space.hg._identity))
}

/**
 * @param {Space} space
 */
function settled (space) {
  return space.decisionLog.base.indexedLength
}

/**
 * @param {Space} space
 * @returns {string[]}
 */
function settlers (space) {
  const lin = space.decisionLog.base.linearizer
  return lin ? lin.indexers.map((w) => z32.encode(w.core.key)) : []
}

/**
 * @param {Space} space
 */
function ownSettlerKey (space) {
  return z32.encode(space.decisionLog.localKey)
}

// Reclaims the disk space of dropped content now: the step an instance runs
// by itself after dropping a tenth of its budget, at most every 10 minutes
// (lib/index.js). RocksDB keeps recent writes in its write-ahead log, and
// cleared data in older files, until it compacts.
/**
 * @param {Hypergraph} hg
 */
function compact (hg) {
  return hg._reclaimNow()
}

// The next instance opened "crashes" after `n` indexing batches: nothing
// commits after them, as if the process had died there.
/**
 * @param {number} n
 */
function crashAfter (n) {
  const { WriteQueue } = /** @type {{ WriteQueue: typeof import('./index/indexer.js').WriteQueue & { [symbols.crashAfter]?: number | null } }} */ (require('./index/indexer.js'))
  WriteQueue[symbols.crashAfter] = n
}

// Has `hg` crashed (crashAfter)?
/**
 * @param {Hypergraph} hg
 */
function crashed (hg) {
  return hg._queue.crashed
}

/**
 * @param {Space} space
 */
function indexedBlocks (space) {
  return space.indexer.blocks
}

// The indexer looks at `log` (z32) from its start again, as if it had never
// seen it, within this run (a vote indexed twice once hid itself).
/**
 * @param {Space} space
 * @param {string} log
 */
function indexAgain (space, log) {
  const l = /** @type {import('./directory.js').HeldLog & { from: number }} */ (space.directory.logs.get(b4a.toString(z32.decode(log), 'hex')))
  l.scanned = l.indexed = l.from
  return space.indexer.index(l)
}

// A log a modified app prepares (e.g. during a ban): the next log this device
// would open in `space`, made now, with one record in it, announced to every
// peer. Returns { log (z32), announce() }.
/**
 * @param {Space} space
 * @param {{ type?: string, fields?: Record<string, unknown> }} [opts]
 */
async function prepareLog (space, { type = 'post', fields = {} } = {}) {
  const { OwnLog } = require('./log.js')
  const me = space.hg._identity
  const own = new OwnLog(space.store.get({ name: `log/${space.own.generation + 1}`, ...space._coreOpts }), { space: space.keyBytes, identity: me, decisions: space.top })
  await own.ready()
  const encoded = space._types.encode(type, fields)
  await own.append({ kind: enc.PUT, type, stamp: space.hg._stamper.next(), target: null, links: encoded.links, fields: encoded.fields })
  const announce = () => { for (const ch of space.directory.channels) ch.messages[3].send(own.key) }
  announce()
  return { log: z32.encode(own.key), announce }
}

// Makes `hg` look at the lists of logs its peers send `ms` late (a slow
// network), in the spaces it opens from now on.
/**
 * @param {Hypergraph} hg
 * @param {number} ms
 */
function slowLists (hg, ms) {
  /** @type {import('./space.js').Seams} */ (hg)[symbols.slowLists] = ms
}

// A held log unused this long (ms) closes, in the spaces `hg`
// opens from now on (30 s otherwise); `claims`: a longer length a peer
// claimed and nobody served is dropped after this long (60 s otherwise).
/**
 * @param {Hypergraph} hg
 * @param {number} ms
 * @param {{ claims?: number }} [opts]
 */
function idleLogs (hg, ms, { claims = 0 } = {}) {
  /** @type {import('./space.js').Seams} */ (hg)[symbols.idleLogs] = { idle: ms, claims }
}

// The held logs of `space` (not this device's) whose core is open (z32).
/**
 * @param {Space} space
 */
function openLogs (space) {
  return space.directory.openLogs().map((l) => z32.encode(l.key))
}

/**
 * @param {Hypergraph} hg
 * @param {number} ms
 */
function slowCommits (hg, ms) {
  /** @type {import('./index/indexer.js').WriteQueue & { slow?: number }} */ (hg._queue).slow = ms
}

// Logs this member is checking in `space` (fetching their header) and
// waiting to be checked: { running, waiting } (a flood of log keys).
/**
 * @param {Space} space
 */
function fetching (space) {
  const dir = space.directory
  return { running: dir.inflight.size, waiting: dir.some.length + dir.queue.size }
}


// The activity entries this member keeps in `space` from period `from` on:
// [{ log (z32), period, start }].
/**
 * @param {Space} space
 * @param {number} [from]
 */
async function activity (space, from = 0) {
  return (await space.activity.list(from)).map((r) => ({ log: z32.encode(r.log), period: r.period, start: r.start }))
}

// Sends activity entries ({ log (z32 or bytes), period, start }) to every
// peer of `space`, as a peer would (true or false, checked or not).
/**
 * @param {Space} space
 * @param {{ log: string | Uint8Array, period: number, start: number }[]} entries
 */
function sendActivity (space, entries) {
  for (const ch of space.directory.channels) {
    for (const e of entries) ch.messages[8].send({ log: typeof e.log === 'string' ? z32.decode(e.log) : e.log, period: e.period, start: e.start })
  }
}

// Records the activity entries this member receives in `space` from now on:
// returns the list, [{ peer (device key z32), log (z32), period, start }].
/**
 * @param {Space} space
 */
function listen (space) {
  /** @type {{ peer: string | null, log: string, period: number, start: number }[]} */
  const heard = []
  space.activity.listen = {
    /** @param {import('./activity.js').Entry & { peer: Uint8Array | null }} e */
    push: (e) => heard.push({ peer: e.peer ? z32.encode(e.peer) : null, log: z32.encode(e.log), period: e.period, start: e.start })
  }
  return heard
}

// When a newcomer reads a space newest first (a peer holds more than
// `records` records) and by activity lists (more than `logs` logs): the
// switch-over points, lowered for tests. Returns restore().
/**
 * @param {{ logs?: number, records?: number }} at
 */
function bigSpaces ({ logs, records }) {
  const { BIG } = require('./space.js')
  const before = { ...BIG }
  if (logs !== undefined) BIG.logs = logs
  if (records !== undefined) BIG.records = records
  return () => Object.assign(BIG, before)
}

// How this member reads `space`: { horizon (first period read, null:
// everything), byActivity, reachedFrom, undecided }.
/**
 * @param {Space} space
 */
function reading (space) {
  return space._readingState()
}

// The first block read here of each log of `space`: { log z32: from }.
/**
 * @param {Space} space
 */
function readFrom (space) {
  /** @type {Record<string, number | null>} */
  const out = {}
  for (const log of space.directory.logs.values()) out[z32.encode(log.key)] = log.from
  return out
}

// Lowers the 200 MB a member hands its holders (lib/circles.js).
/**
 * @param {Hypergraph} hg
 * @param {number} bytes
 */
function memberBytes (hg, bytes) {
  hg._circles.memberBytes = bytes
}

// The clock holding judges "unseen 7 days" by, moved `offset` ms.
// `online`: hours this device was online, as it would have marked them, the
// last ones up to that moved now.
/**
 * @param {Hypergraph} hg
 * @param {number} offset
 * @param {{ online?: number }} [opts]
 */
function holdingClock (hg, offset, { online = 0 } = {}) {
  const now = () => Date.now() + offset
  hg._circles.now = now
  const self = /** @type {Buffer} */ (hg._identity.device.publicKey).toString('hex')
  if (!hg._circles.hours.has(self)) hg._circles.hours.set(self, new Set())
  const H = 3600 * 1000
  for (let i = 0; i < online; i++) hg._circles.hours.get(self).add(Math.floor((now() - i * H) / H))
}

// `hg` asks `holder` to delete a core it holds (blind-peer's
// delete-core) -> true, false (refused) or null (no answer).
/**
 * @param {Hypergraph} hg
 * @param {Hypergraph} holder
 * @param {Uint8Array} key
 */
function askDelete (hg, holder, key) {
  return hg._circles.askDelete(/** @type {Buffer} */ (holder._identity.device.publicKey).toString('hex'), key)
}

// `hg` asks `holder` to clear a core's blocks before `below`
// (clear-core) -> true, false (refused) or null (no answer).
/**
 * @param {Hypergraph} hg
 * @param {Hypergraph} holder
 * @param {Uint8Array} key
 * @param {number} below
 */
function askClear (hg, holder, key, below) {
  return hg._circles.askClear(/** @type {Buffer} */ (holder._identity.device.publicKey).toString('hex'), key, below)
}

// What the engine does with spaces that moved, now (30 days after
// a move: left), with the clock as setClock moved it.
/**
 * @param {Hypergraph} hg
 */
function dropMoved (hg) {
  return hg._dropMoved()
}

// Writes as a device that hasn't heard of the move yet would (in
// the old space's log, sealed with its key): a late write.
/**
 * @param {Space} space
 * @param {string} type
 * @param {Record<string, unknown>} values
 */
async function writeAsIfNotMoved (space, type, values) {
  const st = space.decisionLog.state
  const moved = st.moved
  st.moved = null
  try {
    return await space.put(type, values)
  } finally {
    st.moved = moved
  }
}

module.exports = { dropMoved, writeAsIfNotMoved, askClear, memberBytes, holdingClock, askDelete, diskKey, coreKeys, rawBlocks, inClear, idleLogs, openLogs, recordNoTypes, oldLayout, fetching, slowCommits, slowLists, prepareLog, activity, sendActivity, listen, bigSpaces, reading, readFrom, epochKeys, deafen, digestOf, crashAfter, crashed, indexedBlocks, indexAgain, compact, inviteAnyway, settled, settlers, ownSettlerKey, removeDeviceAnyway, writeRaw, decide, holdsBlock, logs, ownLog, openSpace, personalKeys, announce, rawBlock, setClock, writeHeads, headsOf }

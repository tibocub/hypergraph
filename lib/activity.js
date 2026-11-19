// Activity entries.
// Records are grouped by period (an hour of stamps). An entry says "block
// `start` of this log is its first record stamped in `period` or later": a
// reader of big spaces opens only the logs active in the periods it reads,
// from there. Entries carry no signature: each is checked against the log
// itself (the block before `start` is the header or a record stamped before
// the period) and against "may this author write here" (the log passed the
// gate) before anyone keeps or passes it on.

const c = require('compact-encoding')
const b4a = require('b4a')
const safetyCatch = require('safety-catch')
const { decodeRecord } = require('./encodings.js')

/**
 * @typedef {{ log: Uint8Array, period: number, start: number }} Entry "Block `start` of `log` is its first record stamped in `period` or later."
 * @typedef {Entry & { space: Uint8Array }} ActivityRow An entry as the index keeps it (`@hg/activity`).
 * @typedef {import('./directory.js').SpaceChannel} SpaceChannel
 * @typedef {import('./directory.js').HeldLog} HeldLog
 * @typedef {import('./space.js').SpaceContext} SpaceContext
 */
const PERIOD_MS = 60 * 60 * 1000
const WIPED = -1 // a block known to be wiped (deleted by its author, or taken down): no stamp

/** @param {number} stamp */
const periodOf = (stamp) => Math.floor(stamp / PERIOD_MS)

// { log, period, start }: 32 B + two varints, ~40 B.
/** @type {import('./encodings.js').Codec<Entry>} */
const entry = {
  /**
   * @param {c.State} state
   * @param {Entry} e
   */
  preencode (state, e) { c.fixed32.preencode(state, e.log); c.uint.preencode(state, e.period); c.uint.preencode(state, e.start) },
  /**
   * @param {c.State} state
   * @param {Entry} e
   */
  encode (state, e) { c.fixed32.encode(state, e.log); c.uint.encode(state, e.period); c.uint.encode(state, e.start) },
  /**
   * @param {c.State} state
   */
  decode (state) { return { log: c.fixed32.decode(state), period: c.uint.decode(state), start: c.uint.decode(state) } }
}

// A log's entries from its blocks `from` to `end` (excluded), in order.
// `get(seq)`: the block's stamp, WIPED, or null when it isn't held (stops
// there). `last`: the last readable block before `from` (0: the header);
// `period`: its period (-1 for the header). A period starts right after the
// last readable block of an earlier period, so the block before an entry's
// start is never a wiped one (anyone can check it). Returns { entries:
// [{ period, start }], next, last, period } to continue from later.
/**
 * @param {(seq: number) => number | null | undefined} get
 * @param {{ from: number, end: number, last?: number, period?: number }} range
 * @returns {{ entries: { period: number, start: number }[], next: number, last: number, period: number }}
 */
function derive (get, { from, end, last = from - 1, period = -1 }) {
  /** @type {{ period: number, start: number }[]} */
  const entries = []
  let seq = from
  for (; seq < end; seq++) {
    const stamp = get(seq)
    if (stamp === null || stamp === undefined) break
    if (stamp === WIPED) continue
    const p = periodOf(stamp)
    if (p > period) {
      entries.push({ period: p, start: last + 1 })
      period = p
    }
    last = seq
  }
  return { entries, next: seq, last, period }
}

// Is { period, start } true of its log? `before`: the stamp of block start - 1
// (ignored for start 1: the header), `at`: the stamp of block start (checked
// when it is here); each WIPED or null when not available. `limit`: the log's cut (Infinity: none).
// 'ok' | 'false' | 'wait' (a block needed isn't available yet).
/**
 * @param {{ period: number, start: number }} e
 * @param {{ before: number | null | undefined, at: number | null | undefined, limit: number }} blocks
 * @returns {'ok' | 'false' | 'wait'}
 */
function checkEntry ({ period, start }, { before, at, limit }) {
  if (!(start >= 1) || start >= limit) return 'false'
  if (start > 1) {
    if (before === WIPED) return 'false'
    if (before === null || before === undefined) return 'wait'
    if (periodOf(before) >= period) return 'false'
  }
  // The block at `start` may be wiped, and a reader not holding the delete
  // can't tell: an entry starting too early only makes readers read more.
  if (at === WIPED || at === null || at === undefined) return 'ok'
  return periodOf(at) >= period ? 'ok' : 'false'
}

// Messages on the space channel (lib/directory.js): an entry (the notice
// itself: as short as a notice), a request for the entries from a period on,
// and a list in answer: `from` is the period from which the sender's list is
// complete (Infinity: it can't tell), `done` on its last part.
/** @type {import('./encodings.js').Codec<{ from: number }>} */
const want = {
  /**
   * @param {c.State} state
   * @param {{ from: number }} m
   */
  preencode (state, m) { c.uint.preencode(state, m.from) },
  /**
   * @param {c.State} state
   * @param {{ from: number }} m
   */
  encode (state, m) { c.uint.encode(state, m.from) },
  /**
   * @param {c.State} state
   */
  decode (state) { return { from: c.uint.decode(state) } }
}
/** @type {import('./encodings.js').Codec<{ from: number, entries: Entry[], done: boolean }>} */
const list = {
  /**
   * @param {c.State} state
   * @param {{ from: number, entries: Entry[], done: boolean }} m
   */
  preencode (state, m) { c.uint.preencode(state, m.from === Infinity ? 0 : m.from + 1); c.array(entry).preencode(state, m.entries); c.bool.preencode(state, m.done) },
  /**
   * @param {c.State} state
   * @param {{ from: number, entries: Entry[], done: boolean }} m
   */
  encode (state, m) { c.uint.encode(state, m.from === Infinity ? 0 : m.from + 1); c.array(entry).encode(state, m.entries); c.bool.encode(state, m.done) },
  /**
   * @param {c.State} state
   */
  decode (state) {
    const f = c.uint.decode(state)
    return { from: f === 0 ? Infinity : f - 1, entries: c.array(entry).decode(state), done: c.bool.decode(state) }
  }
}

const CHUNK = 1000 // entries per list message
const MAX_WAITING = 1000 // entries waiting for their check (their log's header, a block)
const CHECK_MS = 5000 // waiting for a block an entry's check needs
const RETRY_MS = 10000
const WAIT_MS = 60000 // an entry that can't be checked within this long is dropped

/** @param {Uint8Array} b */
const hex = (b) => b4a.toString(b, 'hex')

// One space's activity lists: entries kept in the index (`@hg/activity`),
// derived by the indexer from the logs read here, or received and checked;
// each new one is passed on to every peer once. `space`: key, db, queue,
// directory, indexer, entries(rows), coveredFrom(), progress() (lib/space.js).
class Activity {
  /**
   * @param {SpaceContext} space
   */
  constructor (space) {
    this.space = space
    /** @type {Map<string, { e: Entry, at: number }>} */
    this.waiting = new Map() // `${log hex}:${period}` -> an entry waiting for its check
    /** @type {Map<string, Entry>} */
    this.checking = new Map() // `${log hex}:${period}:${start}` -> an entry being checked
    this.reachedFrom = Infinity // the lowest period from which a peer's list was received whole
    /** @type {{ from: number, asked: Set<SpaceChannel> } | null} */
    this.asking = null // { from, asked: Set of channels }
    this.closed = false
    /** @type {{ push (e: Entry & { peer: Uint8Array | null }): unknown } | null} */
    this.listen = null // tests only (lib/testing.js listen): entries received, with their sender
    this.timer = setInterval(() => this.#retry(), RETRY_MS)
    if (this.timer.unref) this.timer.unref()
  }

  /**
   * @param {number} [from]
   * @returns {Promise<ActivityRow[]>}
   */
  list (from = 0) {
    const key = this.space.key
    return this.space.db.find('@hg/activity', { gte: { space: key, period: from }, lte: { space: key } }).toArray()
  }

  /**
   * @param {ActivityRow[]} rows
   * @param {SpaceChannel | null} [except]
   */
  kept (rows, except = null) {
    if (this.closed) return
    for (const ch of this.space.directory.channels) {
      if (ch === except) continue
      for (const r of rows) ch.messages[8].send(r)
    }
    this.space.entries(rows)
  }

  // An entry from a peer: kept and passed on once checked; dropped if false
  // or for a log that may not write here; waiting (bounded) while what its
  // check needs isn't here yet.
  /**
   * @param {Entry} e
   * @param {SpaceChannel | null} [ch]
   */
  async receive (e, ch = null) {
    if (this.closed) return
    if (this.listen && ch) this.listen.push({ peer: ch.peer, ...e })
    const k = hex(e.log) + ':' + e.period
    const ck = k + ':' + e.start
    if (this.checking.has(ck)) return
    const space = this.space
    const old = await space.db.get('@hg/activity', { space: space.key, period: e.period, log: e.log })
    if (old && old.start <= e.start) return
    const dir = space.directory
    const log = dir.logs.get(hex(e.log))
    if (!log) {
      if (dir.refused.has(hex(e.log))) return
      this.#wait(k, e)
      dir.considerSome(e.log)
      return
    }
    this.checking.set(ck, e)
    try {
      const before = e.start > 1 ? await this.#stamp(log, e.start - 1) : null
      const verdict = checkEntry(e, { before, at: await this.#stamp(log, e.start, false), limit: log.limit })
      if (verdict === 'wait') return this.#wait(k, e)
      if (verdict === 'ok' && !this.closed) {
        const row = { space: space.key, period: e.period, log: e.log, start: e.start }
        let fresh = false
        await space.queue.run(async (tx) => {
          const now = await tx.get('@hg/activity', row)
          if (now && now.start <= row.start) return
          await tx.insert('@hg/activity', row)
          fresh = true
        })
        if (fresh) this.kept([row], ch)
      }
      const w = this.waiting.get(k)
      if (w && (verdict === 'ok' ? w.e.start >= e.start : w.e.start === e.start)) this.waiting.delete(k)
    } finally {
      this.checking.delete(ck)
    }
  }

  /**
   * @param {string} k
   * @param {Entry} e
   */
  #wait (k, e) {
    const w = this.waiting.get(k)
    if (w ? e.start < w.e.start : this.waiting.size < MAX_WAITING) this.waiting.set(k, { e, at: Date.now() })
    else if (!w) this.reachedFrom = Infinity // dropped: the lists aren't known whole any more (asked again)
  }

  // A block's stamp, WIPED, or null if not here within CHECK_MS.
  // `fetch` false: only if held here.
  /**
   * @param {HeldLog} log
   * @param {number} seq
   * @param {boolean} [fetch]
   * @returns {Promise<number | null>}
   */
  async #stamp (log, seq, fetch = true) {
    let bytes = await this.space.directory.get(log, seq, { wait: false }).catch(() => null)
    if (!bytes && await this.space.indexer.isWiped(log, seq)) return WIPED
    if (!bytes && fetch && !this.closed) bytes = await this.space.directory.get(log, seq, { timeout: CHECK_MS }).catch(() => null)
    if (!bytes) return null
    try { return decodeRecord(bytes).stamp } catch { return WIPED }
  }

  /**
   * @param {Uint8Array} key
   */
  logAccepted (key) {
    for (const { e } of this.waiting.values()) if (b4a.equals(e.log, key)) this.receive(e).catch(safetyCatch)
  }

  /**
   * @param {Uint8Array} key
   */
  logRefused (key) {
    for (const [k, { e }] of this.waiting) if (b4a.equals(e.log, key)) this.waiting.delete(k)
  }

  /**
   * @param {number} period
   */
  waitingFrom (period) {
    for (const { e } of this.waiting.values()) if (e.period >= period) return true
    for (const e of this.checking.values()) if (e.period >= period) return true
    return false
  }

  #retry () {
    if (this.closed) return
    const dir = this.space.directory
    for (const [k, { e, at }] of this.waiting) {
      if (Date.now() - at > WAIT_MS) {
        this.waiting.delete(k) // nobody could show the blocks its check needs
        this.space.progress()
        continue
      }
      if (dir.logs.has(hex(e.log))) this.receive(e).catch(safetyCatch)
      else if (!dir.refused.has(hex(e.log))) dir.considerSome(e.log)
    }
    const h = this.space.horizon()
    if (h !== null && this.reachedFrom > h) this.ask(h)
    else if (this.asking) this.#askNext()
  }

  // Asks a peer for every entry from period `from` on: one member at a time
  // (its hello proved who it is), the next one if it can't tell that far
  // back. Only its answer counts: a stranger's list could say "whole" with
  // entries missing.
  /**
   * @param {number} from
   */
  ask (from) {
    if (this.closed || from >= this.reachedFrom) return
    if (!this.asking || this.asking.from > from) this.asking = { from, asked: new Set() }
    this.#askNext()
  }

  #askNext () {
    const a = this.asking
    if (!a || a.from >= this.reachedFrom) {
      this.asking = null
      return
    }
    for (const ch of this.space.directory.channels) {
      if (a.asked.has(ch) || !ch.identity || !this.space.state.isMember(ch.identity)) continue
      a.asked.add(ch)
      ch.messages[9].send({ from: a.from })
      return
    }
    a.asked.clear() // everyone was asked: again at the next retry
  }

  /** @type {(ch?: SpaceChannel) => void} */
  channelOpened () {
    if (this.asking) this.#askNext()
  }

  /**
   * @param {SpaceChannel} ch
   * @param {{ from: number }} m
   */
  async onWant (ch, { from }) {
    if (this.closed) return
    const covered = this.space.coveredFrom()
    const rows = covered === Infinity ? [] : await this.list(from)
    if (this.closed) return
    const entries = rows.map((r) => ({ log: r.log, period: r.period, start: r.start }))
    let i = 0
    do {
      ch.messages[10].send({ from: Math.max(from, covered), entries: entries.slice(i, i + CHUNK), done: i + CHUNK >= entries.length })
      i += CHUNK
    } while (i < entries.length)
  }

  /**
   * @param {SpaceChannel} ch
   * @param {{ from: number, entries: Entry[], done: boolean }} m
   */
  async onList (ch, { from, entries, done }) {
    if (this.closed) return
    await Promise.all(entries.map((e) => this.receive(e, ch).catch(safetyCatch)))
    const a = this.asking
    if (!done || this.closed || !a || !a.asked.has(ch)) return
    const reached = Math.max(from, a.from)
    if (reached < this.reachedFrom) {
      this.reachedFrom = reached
      this.space.progress()
    }
    if (a.from < this.reachedFrom) this.#askNext()
    else if (a === this.asking) this.asking = null
  }

  close () {
    this.closed = true
    clearInterval(this.timer)
  }
}

module.exports = { PERIOD_MS, WIPED, periodOf, entry, want, list, derive, checkEntry, Activity }

// Downloads: small spaces are held
// entirely, so every accepted log is downloaded live and indexed as blocks
// arrive. A log that knows of blocks not held and indexed yet makes answers
// incomplete. A download that makes no progress while peers are connected is
// restarted with a fresh range (ranges stalled after their peer left and
// came back). Content dropped to
// keep within a budget (lib/space.js, lib/storage.js) lies below where
// downloads start, so it is never fetched again unless read.
// A log is followed (listeners, download range) only while its
// core is open (`opened` / `closedLog`); a log behind (blocks to fetch or
// index, or a peer's claim) is kept open until it caught up, then handed to
// the helpers again if it grew, and closed by the directory once unused.

const safetyCatch = require('safety-catch')

const STALL_MS = 5000
const HEARD_MS = 2000 // a log nobody told this member the length of, this long after it was accepted

/**
 * @typedef {import('./directory.js').HeldLog} HeldLog
 * @typedef {import('./space.js').SpaceContext} SpaceContext
 * @typedef {HeldLog & { core: import('hypercore') }} OpenLog
 */
class Replicator {
  /**
   * @param {SpaceContext} space
   */
  constructor (space) {
    this.space = space
    /** @type {Set<HeldLog>} */
    this.logs = new Set()
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null
    this.closed = false
  }

  /**
   * @param {HeldLog} log
   */
  hold (log) {
    if (this.closed) return
    this.logs.add(log)
    if (log.core) this.opened(log)
    else this.check(log)
    if (!this.timer && !log.own) {
      this.timer = setInterval(() => this.#watch(), STALL_MS)
      if (this.timer.unref) this.timer.unref()
    }
  }

  /**
   * @param {HeldLog} log
   */
  opened (log) {
    if (this.closed || !this.logs.has(log)) return
    const core = /** @type {import('hypercore')} */ (log.core) // open: called once it is
    const onmore = () => {
      log.lastProgress = Date.now()
      this.space.indexer.index(log).then(() => {
        this.space.progress()
        this.check(log)
      }, safetyCatch)
    }
    core.on('append', onmore)
    core.on('download', (seq) => {
      if (seq >= log.limit) return void core.clear(seq, seq + 1).catch(safetyCatch) // past a cut: not kept
      this.space.indexer.arrived(log, seq)
      onmore()
    })
    log.lastProgress = Date.now()
    if (!log.own) this.#download(log)
    onmore()
  }

  /**
   * @param {HeldLog} log
   */
  closedLog (log) {
    if (log.range) log.range.destroy()
    log.range = null
  }

  /**
   * @param {HeldLog} log
   */
  check (log) {
    if (this.closed || !this.logs.has(log) || log.own) return
    const want = behind(log) > 0 || (!!log.core && peersAhead(/** @type {OpenLog} */ (log)) > 0)
    if (want && !log.busy) {
      log.busy = true
      this.space.directory.open(log).catch((err) => {
        safetyCatch(err)
        log.busy = false
      })
    } else if (!want && log.busy) {
      log.busy = false
      if (log.length > log.handed) this.space.helpers.hold(log)
      this.space.directory.release(log)
    }
  }

  // From where indexing stands: blocks below it are done, and the ones this
  // member wiped (deleted records) must not be fetched again. Up to the
  // log's cut, if it has one.
  // From the first block read here (`from`; null: none yet, a big
  // space's log outside the periods read).
  /**
   * @param {HeldLog} log
   */
  #download (log) {
    if (log.range) log.range.destroy()
    log.range = null
    if (log.from === null || !log.core) return
    log.range = log.core.download({ start: Math.max(log.indexed, log.from), end: log.limit === Infinity ? -1 : log.limit })
    log.range.done().catch(safetyCatch)
  }

  // Content was dropped from the log: downloads start again where
  // indexing stands, past it, so it is never fetched again unless read.
  /**
   * @param {HeldLog} log
   */
  restart (log) {
    if ((log.range || log.from !== null) && !log.own && this.logs.has(log) && !this.closed) this.#download(log)
  }

  /**
   * @param {HeldLog} log
   */
  async cut (log) {
    if (log.range) this.#download(log)
    if (log.length > log.limit && !(this.space.pastOf && this.space.pastOf(log.key))) await this.space.directory.use(log, (core) => clearBlocks(core, Math.max(log.limit, 1), core.length)).catch(safetyCatch)
  }

  /**
   * @param {HeldLog} log
   */
  drop (log) {
    this.logs.delete(log)
    if (log.range) log.range.destroy()
    log.range = null
    if (log.busy) {
      log.busy = false
      this.space.directory.release(log)
    }
  }

  #watch () {
    const now = Date.now()
    for (const log of this.logs) {
      if (log.own) continue
      if (log.claim && log.core && this.space.directory.expire(log, now)) this.check(log)
      if (!log.core || !missing(log)) continue
      if (now - /** @type {number} */ (log.lastProgress) > STALL_MS && log.core.peers.length > 0) {
        log.lastProgress = now
        this.#download(log)
      }
      this.check(log)
    }
  }

  // Blocks known to exist but not held and indexed yet, over all held logs
  // (holes this member knows were wiped don't count); closed logs: 1 each
  // while a peer's summary isn't settled.
  missing () {
    const settled = this.space.directory.settled()
    let n = 0
    for (const log of this.logs) n += missing(log, settled)
    return n
  }

  close () {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    for (const log of this.logs) if (log.range) log.range.destroy()
  }
}

/**
 * @param {HeldLog} log
 * @param {boolean} [settled]
 * @returns {number}
 */
function missing (log, settled = true) {
  if (log.from === null) return 0
  return behind(log) + unheard(log, settled)
}

// Blocks to fetch or index that this member knows of without asking peers:
// holes, blocks not looked at yet, a peer's claim beyond its length (even
// the header alone, below where indexing starts), a batch not committed.
/**
 * @param {HeldLog} log
 * @returns {number}
 */
function behind (log) {
  if (log.from === null) return 0
  const claimed = Math.max(0, Math.min(log.claim, log.limit) - log.length)
  return log.holes.size + Math.max(0, Math.min(log.length, log.limit) - log.scanned) + claimed + (log.uncommitted ? 1 : 0)
}

// A log this member may not know the length of yet: a peer of it hasn't told
// its length, or none did since it was accepted (for HEARD_MS). A newcomer was
// otherwise "complete" with a log's newest blocks not even announced to it
// (found by bench/next/first-page.js). Then: the blocks a
// peer says it has beyond the length verified here.
// A closed log is heard only when every peer's summary was settled
// (`settled`: lib/directory.js settled()).
/**
 * @param {HeldLog} log
 * @param {boolean} [settled]
 * @returns {number}
 */
function unheard (log, settled = true) {
  if (log.own) return 0
  if (!log.core) return settled ? 0 : 1
  for (const peer of log.core.peers || []) {
    if (!peer.remoteSynced) return 1
    log.heard = true
  }
  if (!log.heard && Date.now() - (log.acceptedAt || 0) < HEARD_MS) return 1
  return peersAhead(/** @type {OpenLog} */ (log))
}

/**
 * @param {OpenLog} log
 * @returns {number}
 */
function peersAhead (log) {
  let top = 0
  for (const peer of log.core.peers || []) {
    if (peer.remoteSynced && peer.remoteFork === log.core.fork && peer.remoteLength > top) top = peer.remoteLength
  }
  return Math.max(0, Math.min(top, log.limit) - log.core.length)
}

// Clears blocks [start, end) of a log this member holds, so it neither keeps
// nor serves them. Hypercore 11 tells peers "I hold 0..n" as a contiguous
// length, and a "dropped block k" sets that length to k on the peer, which
// then forgets that we still hold the blocks after k; a peer that already
// sent us a "want" never asks again (test/next/unit/clear-blocks.js). So the
// held blocks after the cleared ones
// are announced again.
/**
 * @param {import('hypercore')} core
 * @param {number} start
 * @param {number} end
 */
async function clearBlocks (core, start, end) {
  await core.clear(start, end)
  if (!core.replicator || core.closing) return
  let run = -1
  for (let i = end; i <= core.length; i++) {
    const held = i < core.length && await core.has(i)
    if (held && run === -1) run = i
    if (!held && run !== -1) {
      core.replicator.onhave(run, i - run)
      run = -1
    }
  }
}

module.exports = { Replicator, clearBlocks, unheard, behind }

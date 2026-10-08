// Downloads (research R13, R14; story 1's part): small spaces are held
// entirely, so every accepted log is downloaded live and indexed as blocks
// arrive. A log that knows of blocks not held and indexed yet makes answers
// incomplete. A download that makes no progress while peers are connected is
// restarted with a fresh range (src/v2/replication.js found ranges that
// stalled after their peer left and came back). Budgets, eviction and
// policies come with story 6.

const safetyCatch = require('safety-catch')

const STALL_MS = 5000

class Replicator {
  // space: indexer, progress()
  constructor (space) {
    this.space = space
    this.logs = new Set()
    this.timer = null
    this.closed = false
  }

  hold (log) {
    if (this.closed) return
    this.logs.add(log)
    const onmore = () => {
      log.lastProgress = Date.now()
      this.space.indexer.index(log).then(() => this.space.progress(), safetyCatch)
    }
    log.core.on('append', onmore)
    log.core.on('download', (seq) => {
      this.space.indexer.arrived(log, seq)
      onmore()
    })
    log.lastProgress = Date.now()
    if (!log.own) this.#download(log)
    onmore()
    if (!this.timer && !log.own) {
      this.timer = setInterval(() => this.#watch(), STALL_MS)
      if (this.timer.unref) this.timer.unref()
    }
  }

  // From where indexing stands: blocks below it are done, and the ones this
  // member wiped (deleted records) must not be fetched again. Up to the
  // log's cut, if it has one.
  #download (log) {
    if (log.range) log.range.destroy()
    log.range = log.core.download({ start: log.indexed, end: log.limit === Infinity ? -1 : log.limit })
    log.range.done().catch(safetyCatch)
  }

  #watch () {
    const now = Date.now()
    for (const log of this.logs) {
      if (log.own || !missing(log)) continue
      if (now - log.lastProgress > STALL_MS && log.core.peers.length > 0) {
        log.lastProgress = now
        this.#download(log)
      }
    }
  }

  // Blocks known to exist but not held and indexed yet, over all held logs
  // (holes this member knows were wiped don't count).
  missing () {
    let n = 0
    for (const log of this.logs) n += missing(log)
    return n
  }

  close () {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    for (const log of this.logs) if (log.range) log.range.destroy()
  }
}

function missing (log) {
  return log.holes.size + Math.max(0, Math.min(log.core.length, log.limit) - log.scanned)
}

module.exports = { Replicator }

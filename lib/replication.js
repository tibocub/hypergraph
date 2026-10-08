// Downloads (research R13, R14; story 1's part): small spaces are held
// entirely, so every accepted log is downloaded live and indexed as blocks
// arrive. A log that knows more blocks than are indexed makes answers
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
    log.core.on('download', onmore)
    log.lastProgress = Date.now()
    if (!log.own) this.#download(log)
    onmore()
    if (!this.timer && !log.own) {
      this.timer = setInterval(() => this.#watch(), STALL_MS)
      if (this.timer.unref) this.timer.unref()
    }
  }

  #download (log) {
    if (log.range) log.range.destroy()
    log.range = log.core.download({ start: 0, end: -1 })
    log.range.done().catch(safetyCatch)
  }

  #watch () {
    const now = Date.now()
    for (const log of this.logs) {
      if (log.own || log.indexed >= log.core.length) continue
      if (now - log.lastProgress > STALL_MS && log.core.peers.length > 0) {
        log.lastProgress = now
        this.#download(log)
      }
    }
  }

  // Blocks known to exist but not indexed yet, over all held logs.
  missing () {
    let n = 0
    for (const log of this.logs) if (log.core.length > log.indexed) n += log.core.length - log.indexed
    return n
  }

  close () {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    for (const log of this.logs) if (log.range) log.range.destroy()
  }
}

module.exports = { Replicator }

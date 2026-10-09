// Downloads (research R13, R14; story 1's part): small spaces are held
// entirely, so every accepted log is downloaded live and indexed as blocks
// arrive. A log that knows of blocks not held and indexed yet makes answers
// incomplete. A download that makes no progress while peers are connected is
// restarted with a fresh range (src/v2/replication.js found ranges that
// stalled after their peer left and came back). Story 6: content dropped to
// keep within a budget (lib/space.js, lib/storage.js) lies below where
// downloads start, so it is never fetched again unless read.

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
      if (seq >= log.limit) return void log.core.clear(seq, seq + 1).catch(safetyCatch) // past a cut: not kept
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

  // Content was dropped from the log (story 6): downloads start again where
  // indexing stands, past it, so it is never fetched again unless read.
  restart (log) {
    if (log.range && !this.closed) this.#download(log)
  }

  // The log was cut: download up to the cut only, and drop what is past it.
  async cut (log) {
    if (log.range) this.#download(log)
    if (log.core.length > log.limit) await clearBlocks(log.core, Math.max(log.limit, 1), log.core.length).catch(safetyCatch)
  }

  // Nothing in the log counts: stop holding it.
  drop (log) {
    this.logs.delete(log)
    if (log.range) log.range.destroy()
    log.range = null
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

// Clears blocks [start, end) of a log this member holds, so it neither keeps
// nor serves them. Hypercore 11 tells peers "I hold 0..n" as a contiguous
// length, and a "dropped block k" sets that length to k on the peer, which
// then forgets that we still hold the blocks after k and never asks for them
// (test/next/unit/clear-blocks.js). So the held blocks after the cleared
// ones are announced again.
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

module.exports = { Replicator, clearBlocks }

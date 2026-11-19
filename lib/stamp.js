// "Latest wins": a record's stamp
// is the later of the device's clock, one more than the newest record of the
// same identity the device has seen, and, for an edit or delete, one more than
// the stamp of the version it replaces. Readers order by these raw stamps,
// ties to the lower device key, so every member settles on the same version.
// A stamp far ahead of the reader's clock is only flagged (futureStamp), never
// reordered: capping it at "now + 10 min" would differ between members.

const b4a = require('b4a')

const FUTURE_MS = 10 * 60 * 1000

class Stamper {
  /** @param {{ now?: () => number }} [opts] */
  constructor ({ now = Date.now } = {}) {
    this.now = now
    this.newest = 0
  }

  /**
   * @param {number} stamp
   */
  seen (stamp) {
    if (stamp > this.newest) this.newest = stamp
  }

  /** @param {{ replaces?: number }} [opts] */
  next ({ replaces = 0 } = {}) {
    const stamp = Math.max(this.now(), this.newest + 1, replaces + 1)
    this.newest = stamp
    return stamp
  }
}

// > 0 when a wins over b ({ stamp, device }); never 0 for different devices.
/**
 * @typedef {{ stamp: number, device: Uint8Array }} Stamped
 */

/**
 * @param {Stamped} a
 * @param {Stamped} b
 */
function compare (a, b) {
  if (a.stamp !== b.stamp) return a.stamp - b.stamp
  return b4a.compare(b.device, a.device)
}

/**
 * @template {Stamped} T
 * @param {Iterable<T>} versions
 * @returns {T | null}
 */
function latest (versions) {
  let best = null
  for (const v of versions) if (!best || compare(v, best) > 0) best = v
  return best
}

/**
 * @param {number} stamp
 */
function isFuture (stamp, now = Date.now()) {
  return stamp > now + FUTURE_MS
}

module.exports = { Stamper, compare, latest, isFuture, FUTURE_MS }

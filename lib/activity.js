// Activity entries (story 9, research.md A14; design brief, experiment 1).
// Records are grouped by period (an hour of stamps). An entry says "block
// `start` of this log is its first record stamped in `period` or later": a
// reader of big spaces opens only the logs active in the periods it reads,
// from there. Entries carry no signature: each is checked against the log
// itself (the block before `start` is the header or a record stamped before
// the period) and against "may this author write here" (the log passed the
// gate) before anyone keeps or passes it on.

const c = require('compact-encoding')

const PERIOD_MS = 60 * 60 * 1000
const WIPED = -1 // a block known to be wiped (deleted by its author, or taken down): no stamp

const periodOf = (stamp) => Math.floor(stamp / PERIOD_MS)

// { log, period, start }: 32 B + two varints, ~40 B.
const entry = {
  preencode (state, e) { c.fixed32.preencode(state, e.log); c.uint.preencode(state, e.period); c.uint.preencode(state, e.start) },
  encode (state, e) { c.fixed32.encode(state, e.log); c.uint.encode(state, e.period); c.uint.encode(state, e.start) },
  decode (state) { return { log: c.fixed32.decode(state), period: c.uint.decode(state), start: c.uint.decode(state) } }
}

// A log's entries from its blocks `from` to `end` (excluded), in order.
// `get(seq)`: the block's stamp, WIPED, or null when it isn't held (stops
// there). `last`: the last readable block before `from` (0: the header);
// `period`: its period (-1 for the header). A period starts right after the
// last readable block of an earlier period, so the block before an entry's
// start is never a wiped one (anyone can check it). Returns { entries:
// [{ period, start }], next, last, period } to continue from later.
function derive (get, { from, end, last = from - 1, period = -1 }) {
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
// (ignored for start 1: the header), `at`: the stamp of block start; each
// WIPED or null when not available. `limit`: the log's cut (Infinity: none).
// 'ok' | 'false' | 'wait' (a block needed isn't available yet).
function checkEntry ({ period, start }, { before, at, limit }) {
  if (!(start >= 1) || start >= limit) return 'false'
  if (start > 1) {
    if (before === WIPED) return 'false'
    if (before === null || before === undefined) return 'wait'
    if (periodOf(before) >= period) return 'false'
  }
  if (at === WIPED) return 'ok'
  if (at === null || at === undefined) return 'wait'
  return periodOf(at) >= period ? 'ok' : 'false'
}

module.exports = { PERIOD_MS, WIPED, periodOf, entry, derive, checkEntry }

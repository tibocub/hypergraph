// "Latest wins" stamps (research R7 and its amendment): stamp = the later of
// the device's clock, one more than the newest own record seen, and one more
// than the version an edit replaces. Order by raw stamps, ties to the lower
// device key, so every member orders the same way; a stamp far ahead of the
// reader's clock is only flagged.

const test = require('brittle')
const b4a = require('b4a')
const { Stamper, compare, latest, isFuture, FUTURE_MS } = require('../../../lib/stamp.js')

const low = b4a.alloc(32, 1)
const high = b4a.alloc(32, 2)

test('a stamp is the later of the clock and one more than the newest own seen', (t) => {
  let now = 1000
  const s = new Stamper({ now: () => now })
  t.is(s.next(), 1000)
  t.is(s.next(), 1001, 'never twice the same, even within one ms')
  s.seen(5000)
  t.is(s.next(), 5001, 'after seeing a newer own record')
  now = 9000
  t.is(s.next(), 9000)
  s.seen(10) // older: changes nothing
  t.is(s.next(), 9001)
})

test('an edit is stamped above the version it replaces', (t) => {
  const s = new Stamper({ now: () => 1000 })
  t.is(s.next({ replaces: 50000 }), 50001)
  t.is(s.next({ replaces: 10 }), 50002, 'and above everything seen before')
})

test('ties go to the lower device key, the same both ways', (t) => {
  const a = { stamp: 7, device: low }
  const b = { stamp: 7, device: high }
  t.ok(compare(a, b) > 0, 'a (lower key) wins')
  t.ok(compare(b, a) < 0)
  t.is(latest([b, a]), a)
  t.is(latest([a, b]), a)
  t.is(latest([{ stamp: 8, device: high }, a]).stamp, 8, 'a later stamp wins whatever the key')
})

test('a stamp far ahead of the reader\'s clock is flagged, never reordered', (t) => {
  const now = 1_000_000_000
  t.absent(isFuture(now + FUTURE_MS, now))
  t.ok(isFuture(now + FUTURE_MS + 1, now))
  t.is(FUTURE_MS, 10 * 60 * 1000)
})

test('a version stamped a day ahead loses to an edit made after seeing it, on every member', (t) => {
  const day = 24 * 3600 * 1000
  const realNow = 1_700_000_000_000
  // A device whose clock is a day ahead writes a version.
  const ahead = { stamp: realNow + day, device: low }
  // An allowed member's device, clock right, sees it and edits.
  const editor = new Stamper({ now: () => realNow + 60000 })
  const edit = { stamp: editor.next({ replaces: ahead.stamp }), device: high }
  // Members compare at different times of their own clocks: same winner.
  for (const readerNow of [realNow, realNow + 3600e3, realNow + 2 * day]) {
    t.is(latest([ahead, edit]), edit, `reader at +${(readerNow - realNow) / 3600e3} h`)
    t.is(latest([edit, ahead]), edit)
  }
  t.ok(isFuture(ahead.stamp, realNow), 'the day-ahead version is flagged for display')
})

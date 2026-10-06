// v2 prototype: time segments (spec 007, research R4).

const test = require('brittle')
const { segmentOf, segmentStart, isFuture, FUTURE_MS } = require('../../../src/v2/segments')

test('v2 segments: a time belongs to exactly one segment; a boundary belongs to the later one', (t) => {
  const ms = 3600000
  t.is(segmentOf(0, ms), 0)
  t.is(segmentOf(ms - 1, ms), 0)
  t.is(segmentOf(ms, ms), 1)
  t.is(segmentOf(5 * ms + 7, ms), 5)
  t.is(segmentStart(5, ms), 5 * ms)
})

test('v2 segments: a time claimed more than 5 minutes ahead is in the future', (t) => {
  const now = 1791000000000
  t.is(FUTURE_MS, 5 * 60 * 1000)
  t.absent(isFuture(now + FUTURE_MS, now))
  t.ok(isFuture(now + FUTURE_MS + 1, now))
  t.absent(isFuture(now - 1, now))
})

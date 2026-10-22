// Activity entries (story 9, research.md A14; design brief, experiment 1):
// "block `start` of this log is its first record stamped in `period` or
// later". No signature: checked against the log itself (the block before is
// the header or stamped before the period) and against "may this author
// write here" (by whoever keeps it: lib/directory.js).

const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const { PERIOD_MS, WIPED, periodOf, derive, checkEntry, entry, Activity } = require('../../../lib/activity.js')

const H = PERIOD_MS
const at = (period, ms = 0) => period * H + ms

test('a period is an hour of record stamps', (t) => {
  t.is(periodOf(0), 0)
  t.is(periodOf(H - 1), 0)
  t.is(periodOf(H), 1)
  t.is(periodOf(at(480000, 1234)), 480000)
})

test('an entry for the first record of each period', (t) => {
  // blocks 1..6: two in period 10, one in 11, three in 13
  const stamps = [null, at(10, 1), at(10, 2), at(11), at(13), at(13, 5), at(13, 9)]
  const got = derive((seq) => stamps[seq], { from: 1, end: 7 })
  t.alike(got.entries, [{ period: 10, start: 1 }, { period: 11, start: 3 }, { period: 13, start: 4 }])
  t.is(got.next, 7, 'every block looked at')
  // continuing later from where it stopped gives the next ones only
  stamps.push(at(13, 20), at(14))
  const more = derive((seq) => stamps[seq], { from: got.next, end: 9, last: got.last, period: got.period })
  t.alike(more.entries, [{ period: 14, start: 8 }])
})

test('a wiped block is skipped: the start follows the last readable block', (t) => {
  // block 3 (period 11) was deleted: nobody can read its stamp
  const stamps = [null, at(10), at(10, 1), WIPED, at(11, 5), at(12)]
  const got = derive((seq) => stamps[seq], { from: 1, end: 6 })
  t.alike(got.entries, [{ period: 10, start: 1 }, { period: 11, start: 3 }, { period: 12, start: 5 }], 'period 11 starts right after block 2, the wiped block included')
})

test('a block not held stops the derivation there', (t) => {
  const stamps = [null, at(10), undefined, at(11)]
  const got = derive((seq) => stamps[seq] ?? null, { from: 1, end: 4 })
  t.alike(got.entries, [{ period: 10, start: 1 }])
  t.is(got.next, 2, 'resumes at the missing block')
})

test('checking an entry against the log', (t) => {
  const limit = Infinity
  t.is(checkEntry({ period: 10, start: 1 }, { before: null, at: at(10), limit }), 'ok', 'the first record: the block before is the header')
  t.is(checkEntry({ period: 11, start: 3 }, { before: at(10, 1), at: at(11), limit }), 'ok')
  t.is(checkEntry({ period: 11, start: 3 }, { before: at(11), at: at(11, 1), limit }), 'false', 'a start too late (the block before is in the period already)')
  t.is(checkEntry({ period: 11, start: 3 }, { before: at(9), at: at(10), limit }), 'false', 'the block at start is before the period')
  t.is(checkEntry({ period: 11, start: 3 }, { before: WIPED, at: at(11), limit }), 'false', 'nobody starts an entry after a wiped block')
  t.is(checkEntry({ period: 11, start: 3 }, { before: at(10), at: WIPED, limit }), 'ok', 'the block at start may be a wiped one')
  t.is(checkEntry({ period: 11, start: 3 }, { before: null, at: at(11), limit }), 'wait', 'the block before not available yet')
  t.is(checkEntry({ period: 11, start: 3 }, { before: at(10), at: null, limit }), 'ok', 'the block at start not here: maybe wiped, and starting early is harmless')
  t.is(checkEntry({ period: 11, start: 3 }, { before: at(10), at: at(11), limit: 3 }), 'false', 'past the log\'s cut')
  t.is(checkEntry({ period: 11, start: 0 }, { before: null, at: null, limit }), 'false', 'block 0 is the header')
})

test('an entry is about 40 bytes', (t) => {
  const bytes = c.encode(entry, { log: b4a.alloc(32, 7), period: periodOf(Date.now()), start: 123456 })
  t.ok(bytes.byteLength <= 42, `${bytes.byteLength} B`)
  t.alike(c.decode(entry, bytes).start, 123456)
})

// Audit 3: a newcomer believes the activity lists from a period are whole
// once a peer's list says `done`. Only a list it asked for, of a member,
// counts; a stranger's `done` list must not make a page "complete".
test('only a list asked of a member makes the lists whole', async (t) => {
  const member = b4a.alloc(32, 1)
  const peer = (identity) => {
    const sent = []
    return { identity, sent, messages: { 9: { send: (m) => sent.push(m) } } }
  }
  const m = peer(member)
  const stranger = peer(b4a.alloc(32, 2))
  const unproven = peer(null) // its hello hasn't come yet
  const space = {
    progress () {},
    state: { isMember: (id) => b4a.equals(id, member) },
    directory: { channels: new Set([stranger, unproven, m]) }
  }
  const a = new Activity(space)
  t.teardown(() => a.close())

  await a.onList(stranger, { from: 0, entries: [], done: true })
  t.is(a.reachedFrom, Infinity, 'a list nobody asked for counts for nothing')

  a.ask(5)
  t.alike([stranger.sent, unproven.sent, m.sent], [[], [], [{ from: 5 }]], 'only the member is asked')
  await a.onList(stranger, { from: 0, entries: [], done: true })
  t.is(a.reachedFrom, Infinity, 'nor does a stranger\'s answer to a question it wasn\'t asked')
  await a.onList(m, { from: 5, entries: [], done: true })
  t.is(a.reachedFrom, 5, 'the member\'s answer does')
})

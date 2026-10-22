// Activity lists between members (story 9, US9 #2 and #3, SC-006; research.md
// A14): an author's first record in a period gives an entry every member keeps
// and passes on (the ~40-byte entry is the notice); false entries and entries
// for logs that may not write here are neither kept nor passed on, and
// throwaway keys cost nothing lasting.

const test = require('brittle')
const z32 = require('z32')
const crypto = require('hypercore-crypto')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { periodOf } = require('../../../lib/activity.js')
const { account, threeMembers } = require('../forum/_setup.js')
const { eventually, sleep } = require('../helpers.js')

const has = (list, log, period, start) => list.some((e) => e.log === log && e.period === period && (start === undefined || e.start === start))

test('an author\'s first record in a period: every member keeps its entry, passed on once per connection', async (t) => {
  const { fa, fb, fc } = await threeMembers(t)
  const heard = testing.listen(fc)
  const p = await forum.post(fa, 'first of the hour', '')
  const period = periodOf(p.stamp)
  const log = testing.ownLog(fa)
  for (const f of [fa, fb, fc]) {
    t.ok(await eventually(async () => has(await testing.activity(f), log, period), 3000), 'kept by every member')
  }
  const copies = () => heard.filter((e) => e.log === log && e.period === period).length
  t.ok(copies() >= 1 && copies() <= 2, `c received the entry once per connection at most (${copies()})`)

  const q = await forum.post(fa, 'second of the hour', '')
  t.is(periodOf(q.stamp), period, 'same period (the test runs within an hour boundary)')
  t.ok(await eventually(async () => (await forum.latest(fc)).some((x) => x.id === q.id), 3000), 'c has the second post')
  await sleep(300)
  t.is(heard.filter((e) => e.log === log).length, copies(), 'no new entry for a second record in the same period')
})

test('false entries and entries for a log that may not write here are dropped, not passed on', async (t) => {
  const { fa, fb, fc } = await threeMembers(t)
  const p1 = await forum.post(fb, 'b one', '')
  const p2 = await forum.post(fb, 'b two', '')
  const period = periodOf(p1.stamp)
  t.is(periodOf(p2.stamp), period)
  const bLog = testing.ownLog(fb)
  t.ok(await eventually(async () => has(await testing.activity(fa), bLog, period, 1) && has(await testing.activity(fc), bLog, period, 1), 3000), 'the true entry everywhere')

  const e = await account(t, 'stranger')
  const fe = await testing.openSpace(e, fa.key)
  await testing.writeRaw(fe, { kind: 'put', type: 'post', fields: { title: 'spam', text: 'buy now' } })
  const eLog = testing.ownLog(fe)
  t.ok(await eventually(() => fe.directory.channels.size >= 3, 10000), 'the stranger is connected to a, b and c')
  const heard = testing.listen(fc)
  testing.sendActivity(fe, [
    { log: bLog, period, start: 2 }, // too late: block 1 is in the period already
    { log: bLog, period: period + 5, start: 1 }, // a period b never wrote in (block 1 is earlier)
    { log: eLog, period, start: 1 } // a non-member's log
  ])
  await sleep(2000) // time for the entries to be checked (and refused)
  for (const f of [fa, fb, fc]) {
    const kept = await testing.activity(f)
    t.absent(kept.some((x) => x.log === bLog && x.start === 2), 'the late start is not kept')
    t.absent(has(kept, bLog, period + 5), 'nor the period b never wrote in')
    t.absent(kept.some((x) => x.log === eLog), 'nor the stranger\'s log')
    t.absent(testing.logs(f).includes(eLog), 'whose log is not in the directory')
  }
  const fromMembers = heard.filter((x) => x.peer !== e.device.publicKey)
  t.absent(fromMembers.some((x) => (x.log === bLog && (x.start === 2 || x.period === period + 5)) || x.log === eLog), 'no member passed any of them on to c')
})

test('10,000 throwaway-key entries add nothing to a member\'s lists or index, and go no further', async (t) => {
  const { fa, fb, fc } = await threeMembers(t)
  await forum.post(fb, 'a real post', '')
  t.ok(await eventually(async () => (await testing.activity(fa)).length >= 1 && (await forum.latest(fa)).length === 1, 3000), 'a holds the real entries')
  const before = { entries: (await testing.activity(fa)).length, logs: testing.logs(fa).length, records: JSON.stringify((await fa.inspect()).records) }

  const e = await account(t, 'spammer')
  const fe = await testing.openSpace(e, fa.key)
  t.ok(await eventually(() => fe.directory.channels.size >= 1, 10000), 'the spammer is connected')
  const listeners = [testing.listen(fb), testing.listen(fc)]
  const period = periodOf(Date.now())
  const spam = []
  for (let i = 0; i < 10000; i++) spam.push({ log: crypto.randomBytes(32), period, start: 1 })
  const keys = new Set(spam.map((x) => z32.encode(x.log)))
  testing.sendActivity(fe, spam)
  await sleep(3000) // time for a to receive and drop them
  t.is((await testing.activity(fa)).length, before.entries, 'no entry kept')
  t.is(testing.logs(fa).length, before.logs, 'no log added')
  t.is(JSON.stringify((await fa.inspect()).records), before.records, 'no index row added')
  for (const heard of listeners) {
    t.absent(heard.some((x) => keys.has(x.log) && x.peer !== e.device.publicKey), 'no member passed any on')
  }
  // the space still works
  const p = await forum.post(fc, 'after the spam', '')
  t.ok(await eventually(async () => (await forum.latest(fa)).some((x) => x.id === p.id), 3000), 'a still gets c\'s new post')
})

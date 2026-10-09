// Story 6 (ROADMAP 2026-10-09): space.inspect(), the read-only diagnostics
// snapshot behind the inspector tool — logs, the decision log, records by
// type, storage, peers, complete. Its shape is documented in contracts/api.md
// ("Diagnostics"); it writes nothing and fetches nothing.

const test = require('brittle')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const { account, threeMembers } = require('./_setup.js')
const { eventually } = require('../helpers.js')

test('inspect(): logs, decisions, records by type, storage, peers, complete', async (t) => {
  const { a, b, c, fa, fb, fc } = await threeMembers(t)
  const p = await forum.post(fa, 'Hello', 'world')
  await forum.comment(fb, p, 'hi')
  await forum.vote(fc, p, 1)
  t.ok(await eventually(async () => (await forum.score(fb, p)) === 1 && (await forum.comments(fb, p)).length === 1, 30000))

  // Under load, blocks and peers arrive late: wait for what is checked below
  // (every log held and indexed, complete, a peer), never for a fixed time.
  const ready = (s) => s.complete && s.peers >= 1 && s.logs.length === 3 && s.logs.every((l) => l.length >= 2 && l.held === l.length && l.indexed === l.length)
  const snap = await eventually(async () => {
    const s = await fb.inspect()
    return ready(s) ? s : null
  }, 30000)
  t.ok(snap, 'every log held and indexed, complete')
  t.is(snap.key, fb.key)
  t.is(snap.name, 'Hypergraph fans')
  t.is(snap.personal, false)
  t.is(snap.complete, true)
  t.ok(snap.peers >= 1, 'peers')

  const byIdentity = (id) => snap.logs.filter((l) => l.identity === id)
  for (const who of [a, b, c]) t.is(byIdentity(who.identity.publicKey).length, 1, 'one log per member')
  const mine = byIdentity(b.identity.publicKey)[0]
  t.is(mine.key, testing.ownLog(fb))
  t.is(mine.device, b.device.publicKey)
  t.is(mine.own, true)
  for (const log of snap.logs) {
    t.ok(log.length >= 2 && log.held === log.length && log.indexed === log.length, `log of ${log.identity.slice(0, 6)}: length ${log.length}, all held and indexed`)
    t.is(log.cut, null)
    t.is(log.refused, false)
  }

  t.ok(snap.decisions.length >= 3, 'the decision log: init and two redemptions at least')
  t.ok(snap.decisions.settled <= snap.decisions.length)
  t.is(snap.decisions.settlers.length, 1, 'the owner settles')
  t.ok(snap.decisions.writers.some((w) => w.identity === a.identity.publicKey && w.settler))

  t.alike(snap.records, { post: 1, comment: 1, vote: 1 }, 'records by type (the app\'s and hypergraph\'s)')
  t.is(snap.storage.policy, 'auto')
  t.is(snap.storage.held, 'all')
  t.is(snap.storage.belowPolicy, false)
  t.ok(snap.storage.stored > 0)
  t.is(snap.storage.budget, null)
  t.ok(snap.storage.share === null || snap.storage.share > 0)
  t.ok(Array.isArray(snap.warnings))

  // A snapshot changes nothing.
  const before = testing.logs(fb).length
  await fb.inspect()
  t.is(testing.logs(fb).length, before, 'nothing fetched or written')
})

test('inspect(): a banned member\'s log shows its cut; a stranger\'s log is listed as refused', async (t) => {
  const { c, fa, fb, fc } = await threeMembers(t)
  await forum.post(fc, 'fine', '')
  const spam = await forum.post(fc, 'spam', '')
  t.ok(await eventually(async () => (await fa.get(spam.id)).record, 30000))
  await forum.ban(fa, c.identity.publicKey, { from: spam })
  const cLog = testing.ownLog(fc)
  t.ok(await eventually(async () => {
    const log = (await fb.inspect()).logs.find((l) => l.key === cLog)
    return log && log.cut === 2
  }, 30000), 'c\'s log shows its cut (its header and first post count)')

  // Banned from its very first record: nothing in d's log counts, refused.
  const d = await account(t, 'd')
  const fd = await forum.join(d, await forum.invite(fa))
  const first = await forum.post(fd, 'spam from the start', '')
  t.ok(await eventually(async () => (await fa.get(first.id)).record, 30000))
  await forum.ban(fa, d.identity.publicKey, { from: first })
  t.ok(await eventually(async () => (await fb.inspect()).logs.some((l) => l.key === testing.ownLog(fd) && l.refused && l.identity === d.identity.publicKey), 30000), 'd\'s log is listed as refused')

  // A stranger's log: not kept, waiting in case it becomes a member.
  const { open } = require('../helpers.js')
  const stranger = await open(t, { label: 'stranger', types: forum.types })
  await stranger.connectToSwarm()
  const intruder = await testing.openSpace(stranger, fa.key)
  await testing.writeRaw(intruder, { kind: 'put', type: 'post', fields: { title: 'let me in', text: '' } })
  t.ok(await eventually(() => intruder.status().peers > 0, 30000), 'the stranger reached a member')
  testing.announce(intruder)
  const waiting = async (f) => (await f.inspect()).logs.some((l) => l.key === testing.ownLog(intruder) && l.waiting && !l.held)
  t.ok(await eventually(async () => {
    for (const f of [fa, fb, fc, fd]) if (await waiting(f)) return true
    return false
  }, 30000), 'a stranger\'s log is listed as waiting, nothing held (by a member it reached)')
})

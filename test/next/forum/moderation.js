// Story 2 #1-4, #6: a moderator hides, reveals, takes down and bans; every
// member applies it the same way, including one who was offline during all
// of it; a demoted moderator's later decisions are ignored, earlier ones
// kept; two admins deciding conflicting things at once end the same
// everywhere.

const test = require('brittle')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const { account } = require('./_setup.js')
const { eventually, sleep, open } = require('../helpers.js')

// a owns the forum, b moderates, c writes, d is a member who goes offline.
async function community (t) {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const c = await account(t, 'c')
  const d = await account(t, 'd')
  const fa = await forum.createForum(a, 'Moderated')
  const fb = await forum.join(b, await forum.invite(fa))
  const fc = await forum.join(c, await forum.invite(fa))
  const fd = await forum.join(d, await forum.invite(fa))
  await forum.giveRole(fa, b.identity.publicKey, 'moderator')
  t.ok(await eventually(async () => (await forum.roleOf(fb, b.identity.publicKey)) === 'moderator', 5000), 'b is a moderator')
  return { a, b, c, d, fa, fb, fc, fd }
}

const ids = (records) => records.map((r) => r.id).sort().join()
const agree = (spaces, fn, expected, ms = 10000) => eventually(async () => {
  for (const f of spaces) if ((await fn(f)) !== expected) return false
  return true
}, ms)

// d comes back, in its own folder, and must show what the others show.
async function back (t, d, fd) {
  const d2 = await account(t, 'd-back', { dir: d.dir })
  return d2.space(fd.key)
}

test('hide, reveal, flag: everyone agrees, a member offline meanwhile too', async (t) => {
  const { d, fa, fb, fc, fd } = await community(t)
  const p = await forum.post(fa, 'Welcome', '')
  const rude = await forum.comment(fc, p, 'rude')
  const kind = await forum.comment(fc, p, 'kind')
  const comments = (f) => forum.comments(f, p).then(ids)
  t.ok(await agree([fa, fb, fc, fd], comments, ids([rude, kind])), 'everyone shows both comments')
  await d.close()

  await forum.hide(fb, rude, 'rude')
  t.ok(await agree([fa, fb, fc], comments, kind.id, 3000), 'hidden: every member stops showing it')
  const { record } = await fa.get(rude.id)
  t.ok(record && record.hidden, 'get() still finds it, marked hidden')
  await forum.reveal(fb, rude)
  t.ok(await agree([fa, fb, fc], comments, ids([rude, kind]), 3000), 'revealed: shown again')
  await forum.hide(fb, rude, 'rude after all')
  await forum.flag(fb, p, 'check the rules')
  t.ok(await agree([fa, fb, fc], comments, kind.id, 3000))

  const fd2 = await back(t, d, fd)
  t.ok(await agree([fd2], comments, kind.id), 'd, offline during all of it, shows the same')
  t.ok(await eventually(async () => (await fd2.get(p.id)).record.flagged, 5000), 'and sees the flag')
})

test('a hide that arrives before the record: it never shows', async (t) => {
  const { c, fa, fb, fc } = await community(t)
  const p = await forum.post(fa, 'Welcome', '')
  await eventually(async () => (await forum.latest(fc)).length === 1, 5000)
  await c.close()
  // c writes while away; b hides that comment by its id before anyone holds it.
  const c2 = await open(t, { dir: c.dir, types: forum.types, rules: forum.rules })
  const late = await forum.comment(c2.space(fc.key), p, 'written offline')
  await forum.hide(fb, late, 'pre-emptive')
  await c2.connectToSwarm()
  t.ok(await eventually(async () => (await fa.get(late.id)).record, 10000), 'a holds the comment')
  t.ok((await fa.get(late.id)).record.hidden, 'hidden from the start')
  t.is((await forum.comments(fa, p)).length, 0, 'never shown')
})

test('taking down is for good: gone everywhere, blocks cleared, never revealed', async (t) => {
  const { fa, fb, fc, fd } = await community(t)
  const p = await forum.post(fa, 'Welcome', '')
  const bad = await forum.comment(fc, p, 'illegal')
  const all = [fa, fb, fc, fd]
  const comments = (f) => forum.comments(f, p).then(ids)
  t.ok(await agree(all, comments, bad.id))
  await forum.takeDown(fb, bad, 'illegal')
  t.ok(await agree(all, comments, '', 3000), 'gone everywhere')
  for (const f of all) t.ok(await eventually(async () => !(await testing.holdsBlock(f, bad.id)), 3000), 'its block is cleared')
  t.is((await fa.get(bad.id)).record, null)
  await forum.reveal(fb, bad)
  await sleep(500)
  t.is((await forum.comments(fa, p)).length, 0, 'a reveal does not bring it back')
})

test('a ban: earlier votes count, the spam goes, nothing after is kept; an offline member agrees', async (t) => {
  const { c, d, fa, fb, fc, fd } = await community(t)
  const who = c.identity.publicKey
  const p = await forum.post(fa, 'Vote', '')
  await forum.vote(fc, p, 1)
  const fine = await forum.post(fc, 'A fine post', '')
  const score = (f) => forum.score(f, p)
  t.ok(await agree([fa, fb, fd], score, 1))
  await d.close()
  await sleep(20) // the spam comes later than the fine post
  const spam = []
  for (let i = 0; i < 5; i++) spam.push(await forum.post(fc, `BUY NOW ${i}`, ''))
  const titles = (f) => forum.latest(f).then((xs) => xs.map((x) => x.title).sort().join())
  t.ok(await agree([fb], titles, ['A fine post', 'Vote', ...spam.map((x) => x.title)].sort().join()), 'b sees the spam')

  await forum.ban(fb, who, { reason: 'spam', since: spam[0].stamp })
  t.ok(await eventually(async () => (await forum.roleOf(fc, who)) === null, 5000), 'c is out')
  await testing.writeRaw(fc, { kind: 'put', type: 'post', fields: { title: 'still spamming', text: '' } })
  await testing.writeRaw(fc, { kind: 'put', type: 'vote', fields: { on: p.id, value: -1 } })

  const expected = ['A fine post', 'Vote'].join()
  t.ok(await agree([fa, fb], titles, expected), 'the spam is gone; what c writes after the ban is never kept')
  t.ok(await agree([fa, fb], score, 1), 'c\'s earlier vote still counts')
  const fd2 = await back(t, d, fd)
  t.ok(await agree([fd2], titles, expected), 'd, offline meanwhile, shows the same')
  t.ok(await agree([fd2], score, 1))
  await t.exception(forum.join(c, await forum.invite(fa), { timeout: 3000 }), /INVITE|let you in/, 'a banned member is not let back in')
  t.ok(fine)
})

test('a demoted moderator: later decisions ignored, earlier ones kept', async (t) => {
  const { b, fa, fb, fc, fd } = await community(t)
  const p = await forum.post(fa, 'Welcome', '')
  const one = await forum.comment(fc, p, 'one')
  const two = await forum.comment(fc, p, 'two')
  const comments = (f) => forum.comments(f, p).then(ids)
  await forum.hide(fb, one)
  t.ok(await agree([fa, fc, fd], comments, two.id))

  await forum.giveRole(fa, b.identity.publicKey, 'member')
  t.ok(await eventually(async () => (await forum.roleOf(fb, b.identity.publicKey)) === 'member', 5000))
  try { await forum.hide(fb, two); t.fail('should be refused') } catch (err) { t.is(err.code, 'NOT_ALLOWED', 'b\'s app refuses') }
  await testing.decide(fb, { type: 'moderate', action: 'hide', target: two.id, reason: '', cut: [] }) // written anyway
  await sleep(1000)
  t.ok(await agree([fa, fc, fd], comments, two.id, 3000), 'ignored by everyone; the earlier hide stays')
})

test('two admins deciding conflicting things at once end the same everywhere', async (t) => {
  const { b, c, fa, fb, fc, fd } = await community(t)
  const who = c.identity.publicKey
  await forum.giveRole(fa, b.identity.publicKey, 'admin')
  t.ok(await eventually(async () => {
    try { await forum.addRole(fb, 'helper', ['post']); return true } catch { return false }
  }, 10000), 'b records decisions')

  // b, offline, takes c out; a, meanwhile, makes c a moderator.
  await b.close()
  const b2 = await open(t, { dir: b.dir, types: forum.types, rules: forum.rules })
  const fb2 = b2.space(fb.key)
  await forum.removeMember(fb2, who)
  await forum.giveRole(fa, who, 'moderator')
  await b2.connectToSwarm()

  const roles = async (f) => String(await forum.roleOf(f, who))
  t.ok(await eventually(async () => {
    const all = await Promise.all([fa, fb2, fc, fd].map(roles))
    return all.every((r) => r === all[0])
  }, 10000), 'every member settles on the same role for c')
  await sleep(1000)
  const settled = await Promise.all([fa, fb2, fc, fd].map(roles))
  t.ok(settled.every((r) => r === settled[0]), `and stays there (${settled[0]})`)
})

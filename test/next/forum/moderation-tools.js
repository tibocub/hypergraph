// Spec 014 (the forum's requests F10-F13): a theme only the owner and admins
// set; members report to the moderators, privately; moderators list what
// they hid or flagged however old; a ban that drops everything the person
// wrote, every device, every sub-forum, in one decision.

const test = require('brittle')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const { account, device, threeMembers } = require('./_setup.js')
const { eventually, codeOf } = require('../helpers.js')

const agree = (spaces, fn, expected, ms = 10000) => eventually(async () => {
  for (const f of spaces) if ((await fn(f)) !== expected) return false
  return true
}, ms)
const themes = (f) => f.query('theme').latest(10).then(({ items }) => items.map((x) => x.css).sort().join())
const opened = (hg, key, ms = 10000) => eventually(() => { try { return hg.space(key) } catch { return null } }, ms)
// Does this member know `who` as a moderator (reports are sealed to the
// moderators' devices it knows)?
const knows = (f, who) => eventually(async () => (await forum.roleOf(f, who)) === 'moderator', 10000)

test('F13: only the owner and admins set the theme; a forced one counts for nobody', async (t) => {
  const { b, fa, fb, fc, all } = await threeMembers(t)
  await forum.giveRole(fa, b.identity.publicKey, 'admin')
  t.ok(await eventually(async () => (await forum.roleOf(fb, b.identity.publicKey)) === 'admin', 5000))
  await forum.setTheme(fa, 'green')
  await forum.setTheme(fb, 'blue')
  t.is(await codeOf(forum.setTheme(fc, 'mine')), 'NOT_ALLOWED', 'a member is refused by their own app')
  const forced = await testing.writeRaw(fc, { kind: 'put', type: 'theme', fields: { css: 'forced' } })
  t.ok(await agree(all, themes, 'blue,green'), 'everyone shows the owner\'s and the admin\'s, not the forced one')
  t.is((await fa.get(forced)).record, null, 'get() gives nothing for it')

  // Made a member again: what b set as admin stays; what b forces after doesn't.
  await forum.giveRole(fa, b.identity.publicKey, 'member')
  t.ok(await eventually(async () => (await forum.roleOf(fb, b.identity.publicKey)) === 'member', 5000))
  t.is(await codeOf(forum.setTheme(fb, 'again')), 'NOT_ALLOWED')
  await testing.writeRaw(fb, { kind: 'put', type: 'theme', fields: { css: 'late' } })
  const late = await account(t, 'late')
  const fl = await forum.join(late, await forum.invite(fa))
  t.ok(await agree([...all, fl], themes, 'blue,green'), 'the earlier theme stays, for a newcomer too; the late one counts for nobody')
})

test('F12: members report to the moderators; nobody else reads who or why', async (t) => {
  const { b, c, fa, fb, fc } = await threeMembers(t)
  const d = await account(t, 'd')
  const fd = await forum.join(d, await forum.invite(fa))
  await forum.giveRole(fa, b.identity.publicKey, 'moderator')
  t.ok(await knows(fc, b.identity.publicKey) && await knows(fd, b.identity.publicKey), 'the reporters know the moderator\'s device')
  const p = await forum.post(fa, 'Buy cheap watches', '')
  t.ok(await eventually(async () => !!(await fc.get(p.id)).record && !!(await fd.get(p.id)).record, 5000))

  await forum.report(fc, p, 'spam')
  const second = await forum.report(fc, p, 'really spam')
  const byD = await forum.report(fd, p, 'rude')
  const reported = async (f) => {
    const g = (await forum.reports(f)).find((x) => x.on === p.id)
    return g ? `${g.count}:${g.reports.map((r) => r.reason).sort().join()}` : ''
  }
  t.ok(await agree([fb, fa], reported, '2:really spam,rude'), 'the moderator and the owner see it, one per member, the latest reason')
  const g = (await forum.reports(fb)).find((x) => x.on === p.id)
  t.ok(g.reports.some((r) => r.id === second.id && r.by === c.identity.publicKey), 'with who reported it')

  t.is(await codeOf(forum.reports(fd)), 'NOT_ALLOWED', 'a member can\'t list reports')
  const seen = await eventually(async () => (await fd.get(second.id)).record, 5000)
  t.ok(seen, 'd holds c\'s report record')
  t.absent(JSON.stringify(seen).includes(p.id) || JSON.stringify(seen).includes('spam'), 'but reads neither what was reported nor why')

  await forum.takeDown(fb, byD)
  t.ok(await agree([fb, fa], reported, '1:really spam'), 'dismissed: gone from every moderator\'s list')
})

test('F10: moderators list what they hid or flagged, however old, paged', async (t) => {
  const { fa, fb, fc } = await threeMembers(t)
  const posts = []
  for (let i = 0; i < 60; i++) posts.push(await forum.post(fc, `post ${i}`, ''))
  const hidden = posts.slice(0, 5)
  for (const p of hidden) await forum.hide(fa, p, 'old spam')
  for (const p of posts.slice(10, 13)) await forum.flag(fa, p, 'check')
  await forum.hide(fa, posts[20], 'oops')
  await forum.reveal(fa, posts[20])

  const newestFirst = (xs) => xs.slice().reverse().map((x) => x.id).join()
  const list = (state) => (f) => forum.moderated(f, state).then((xs) => xs.map((x) => x.id).join())
  t.ok(await agree([fa, fb], list('hidden'), newestFirst(hidden)), 'the 5 oldest hidden posts, newest first; the revealed one isn\'t there')
  t.ok(await agree([fa, fb], list('flagged'), newestFirst(posts.slice(10, 13))), 'the flagged ones')
  t.ok((await forum.moderated(fb, 'hidden')).every((x) => x.hidden), 'marked hidden')
  t.absent((await forum.latest(fb, 100)).some((x) => hidden.some((h) => h.id === x.id)), 'still out of the ordinary lists')

  const first = (await fb.query('post').moderated('hidden').latest(2)).items
  const next = (await fb.query('post').moderated('hidden').latest(2, { after: first.at(-1) })).items
  t.is([...first, ...next].map((x) => x.id).join(), newestFirst(hidden).split(',').slice(0, 4).join(), 'pages with { after }')
  t.exception.all(() => fb.query('post').moderated('spam'), /hidden/, 'only hidden or flagged')
})

test('F11: a ban drops everything they wrote: two devices, a sub-forum, newcomers too, one decision', async (t) => {
  const { b, c, fa, fb, fc } = await threeMembers(t)
  const board = await forum.createSubforum(fa, 'Board')
  const { code } = await forum.addDevice(c)
  const phone = await device(t, 'c-phone', code)
  const fp = await opened(phone, fa.key)
  const bc = await opened(c, board.key)
  const p = await forum.post(fa, 'Welcome', '')
  await forum.post(fc, 'spam 1', '')
  t.ok(await eventually(async () => {
    try { return !!(await forum.comment(fp, p, 'spam from the phone')) } catch { return false }
  }, 10000), 'the phone writes too')
  t.ok(await eventually(async () => !!(await fc.get(p.id)).record, 5000))
  await forum.vote(fc, p, 1)
  await forum.post(bc, 'spam in the board', '')
  const bb = await opened(b, board.key)
  const counts = async (f, bf) => `${(await forum.latest(f)).length}:${(await forum.comments(f, p)).length}:${await forum.score(f, p)}:${(await forum.latest(bf)).length}`
  t.ok(await eventually(async () => (await counts(fa, board)) === '2:1:1:1' && (await counts(fb, bb)) === '2:1:1:1', 10000), 'everyone shows c\'s posts, comment, vote and board post')

  const before = (await forum.modLog(fa, 500)).length
  await forum.ban(fa, c.identity.publicKey, { reason: 'spammer', dropAll: true })
  t.ok(await eventually(async () => (await counts(fa, board)) === '1:0:0:0' && (await counts(fb, bb)) === '1:0:0:0', 10000), 'all of it is gone, on every member')
  t.is((await forum.modLog(fa, 500)).length, before + 1, 'one decision')
  const e = await account(t, 'e')
  const fe = await forum.join(e, await forum.invite(fa))
  const be = await opened(e, board.key)
  t.ok(await eventually(async () => (await counts(fe, be)) === '1:0:0:0', 10000), 'a newcomer never sees it')
})

test('F14: once a ban with dropAll returns, the banning member lists none of it, forum and board', async (t) => {
  const { c, fa, fc } = await threeMembers(t)
  const board = await forum.createSubforum(fa, 'Board')
  const bc = await opened(c, board.key)
  const p = await forum.post(fa, 'Welcome', '')
  await forum.post(fc, 'spam 1', '')
  await forum.post(fc, 'spam 2', '')
  t.ok(await eventually(async () => !!(await fc.get(p.id)).record, 5000))
  await forum.comment(fc, p, 'spam comment')
  await forum.vote(fc, p, 1)
  await forum.post(bc, 'spam in the board', '')
  const counts = async () => `${(await forum.latest(fa)).length}:${(await forum.comments(fa, p)).length}:${await forum.score(fa, p)}:${(await forum.latest(board)).length}`
  t.ok(await eventually(async () => (await counts()) === '3:1:1:1', 10000), 'the moderator shows all of c\'s writing')
  await forum.ban(fa, c.identity.publicKey, { reason: 'spammer', dropAll: true })
  t.is(await counts(), '1:0:0:0', 'gone the moment the ban returns')
})

test('F11: someone banned before: banning again with dropAll drops what was kept; unbanned, they write again', async (t) => {
  const { c, fa, fb, fc } = await threeMembers(t)
  const p = await forum.post(fc, 'kept at first', '')
  t.ok(await eventually(async () => !!(await fa.get(p.id)).record, 5000))
  await forum.ban(fa, c.identity.publicKey, { reason: 'spam' })
  const titles = (f) => forum.latest(f).then((xs) => xs.map((x) => x.title).join())
  t.ok(await agree([fa, fb], titles, 'kept at first'), 'a plain ban keeps it')
  await forum.ban(fa, c.identity.publicKey, { dropAll: true })
  t.ok(await agree([fa, fb], titles, ''), 'banned again with dropAll: gone')

  await forum.unban(fa, c.identity.publicKey)
  await forum.giveRole(fa, c.identity.publicKey, 'member')
  t.ok(await eventually(async () => {
    try { return !!(await forum.post(fc, 'back', '')) } catch { return false }
  }, 10000))
  t.ok(await agree([fa, fb], titles, 'back'), 'they write again; what was dropped stays dropped')
})

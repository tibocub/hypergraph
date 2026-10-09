// Story 5 #4, FR-003: shared editing. A page type editable by members with
// the 'edit-pages' permission: the latest allowed edit wins everywhere; an
// edit without the permission is ignored; only the author and moderators
// delete (Tibo, 2026-10-09: a blanked page is restored by the next edit); an
// editor who loses the permission is cut (research.md A4, A9): edits before
// the cut stay, edits after count for no one, whoever indexed them first.

const test = require('brittle')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const { account } = require('./_setup.js')
const { eventually, codeOf, open, sleep } = require('../helpers.js')

// a owns the forum (and moderates); b and c are editors; d is a member.
async function wiki (t) {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const c = await account(t, 'c')
  const d = await account(t, 'd')
  const fa = await forum.createForum(a, 'Wiki')
  const fb = await forum.join(b, await forum.invite(fa))
  const fc = await forum.join(c, await forum.invite(fa))
  const fd = await forum.join(d, await forum.invite(fa))
  await forum.makeEditor(fa, b.identity.publicKey)
  await forum.makeEditor(fa, c.identity.publicKey)
  t.ok(await eventually(async () => (await forum.roleOf(fb, b.identity.publicKey)) === 'editor' && (await forum.roleOf(fc, c.identity.publicKey)) === 'editor', 10000), 'b and c are editors')
  return { a, b, c, d, fa, fb, fc, fd, all: [fa, fb, fc, fd] }
}

const bodyOf = (id) => async (f) => {
  const page = await forum.readPage(f, id)
  return page ? page.body : null
}
const agree = (spaces, fn, expected, ms = 10000) => eventually(async () => {
  for (const f of spaces) if ((await fn(f)) !== expected) return false
  return true
}, ms)

test('three editors edit one page: every member shows the latest', async (t) => {
  const { fa, fb, fc, all } = await wiki(t)
  const page = await forum.writePage(fb, 'Rules', 'be kind')
  t.ok(await agree(all, bodyOf(page.id), 'be kind'))
  await forum.edit(fc, page, { body: 'be kind, mostly' })
  t.ok(await agree(all, bodyOf(page.id), 'be kind, mostly'), 'an editor\'s edit')
  await forum.edit(fa, page, { body: 'be kind. Really.' })
  t.ok(await agree(all, bodyOf(page.id), 'be kind. Really.'), 'the owner\'s edit')
  const shown = await forum.readPage(fb, page.id)
  t.is(shown.title, 'Rules', 'fields not given are kept')
  t.is(shown.author, fb.hg.identity.publicKey, 'the author stays the page\'s')
  t.ok(shown.edited)

  // Two editors at once: one wins, the same everywhere.
  await Promise.all([forum.edit(fb, page, { body: 'b at once' }), forum.edit(fc, page, { body: 'c at once' })])
  t.ok(await eventually(async () => {
    const bodies = await Promise.all(all.map((f) => bodyOf(page.id)(f)))
    return bodies.every((x) => x === bodies[0]) && bodies[0].endsWith('at once')
  }, 10000), 'concurrent edits settle on one version everywhere')
})

test('without the permission: refused here, ignored everywhere', async (t) => {
  const { fb, fd, all } = await wiki(t)
  const page = await forum.writePage(fb, 'FAQ', 'ask')
  t.ok(await agree(all, bodyOf(page.id), 'ask'))
  t.is(await codeOf(forum.edit(fd, page, { body: 'vandalized' })), 'NOT_ALLOWED', 'd\'s app refuses')
  await testing.writeRaw(fd, { kind: 'edit', type: 'page', target: page.id, fields: { title: 'FAQ', body: 'vandalized' } })
  const marker = await forum.post(fd, 'marker', '')
  t.ok(await agree(all, async (f) => !!(await f.get(marker.id)).record, true), 'd\'s later post arrived')
  for (const f of all) t.is(await bodyOf(page.id)(f), 'ask', 'the page is unchanged')
})

test('only the author and moderators delete; a blanked page comes back with the next edit', async (t) => {
  const { fa, fb, fc, fd, all } = await wiki(t)
  const page = await forum.writePage(fb, 'Guide', 'step 1')
  t.ok(await agree(all, bodyOf(page.id), 'step 1'))
  t.is(await codeOf(forum.remove(fc, page)), 'NOT_ALLOWED', 'an editor can\'t delete')
  t.is(await codeOf(forum.remove(fd, page)), 'NOT_ALLOWED', 'nor a member')
  await testing.writeRaw(fc, { kind: 'delete', type: 'page', target: page.id })

  await forum.edit(fc, page, { body: '' })
  t.ok(await agree(all, bodyOf(page.id), ''), 'blanked by an editor')
  await forum.edit(fb, page, { body: 'step 1' })
  t.ok(await agree(all, bodyOf(page.id), 'step 1'), 'restored by the next edit; the raw delete counted for nothing')

  await forum.remove(fa, page)
  t.ok(await agree(all, bodyOf(page.id), null), 'a moderator takes it down, everywhere')
})

test('an editor who loses the permission: before the cut stays, after counts for no one, early member and newcomer alike', async (t) => {
  const { a, c, fa, fb, fc, fd } = await wiki(t)
  const page = await forum.writePage(fb, 'Home', 'welcome')
  await forum.edit(fc, page, { body: 'welcome, by c' })
  t.ok(await agree([fa, fb, fc, fd], bodyOf(page.id), 'welcome, by c'), 'c\'s edit, everywhere')

  // a goes offline; c edits again; b and d show it.
  await a.close()
  await sleep(20)
  await forum.edit(fc, page, { body: 'late, by c' })
  t.ok(await agree([fb, fd], bodyOf(page.id), 'late, by c'), 'b and d show c\'s late edit')

  // a, offline, takes the permission away: the cut is where a holds c's log.
  const a2 = await open(t, { dir: a.dir, types: forum.types, rules: forum.rules })
  const fa2 = a2.space(fa.key)
  await forum.giveRole(fa2, c.identity.publicKey, 'member')
  await a2.connectToSwarm()
  t.ok(await agree([fa2, fb, fc, fd], bodyOf(page.id), 'welcome, by c'), 'the late edit is undone for those who showed it')
  await testing.writeRaw(fc, { kind: 'edit', type: 'page', target: page.id, fields: { title: 'Home', body: 'after, by c' } })
  t.is(await codeOf(forum.edit(fc, page, { body: 'after, by c' })), 'NOT_ALLOWED', 'c\'s app refuses now')

  const n = await account(t, 'newcomer')
  const fn = await forum.join(n, await forum.invite(fa2))
  t.ok(await agree([fn], bodyOf(page.id), 'welcome, by c'), 'a newcomer shows the same')
  await sleep(500)
  for (const f of [fa2, fb, fd, fn]) t.is(await bodyOf(page.id)(f), 'welcome, by c', 'and it stays')

  // Given it back, c edits again (in a new log).
  await forum.makeEditor(fa2, c.identity.publicKey)
  t.ok(await eventually(async () => {
    try { return !!(await forum.edit(fc, page, { body: 'back, by c' })) } catch { return false }
  }, 10000), 'c edits again once its app sees the role')
  t.ok(await agree([fa2, fb, fd, fn], bodyOf(page.id), 'back, by c'), 'and everyone shows it')
})

test('a type any member edits', async (t) => {
  const { fb, fd, all } = await wiki(t)
  const note = await forum.pin(fb, 'meeting at 5')
  await forum.edit(fd, note, { text: 'meeting at 6' })
  t.ok(await agree(all, async (f) => (await f.get(note.id)).record?.text, 'meeting at 6'), 'a plain member\'s edit counts')
  t.is(await codeOf(forum.remove(fd, note)), 'NOT_ALLOWED', 'but only the author deletes it')
})

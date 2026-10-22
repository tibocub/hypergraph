// Story 1 #5-6: the author edits (everyone shows the latest version) and
// deletes (everyone stops showing it, and clears its blocks); an edit or a
// delete by someone else is refused locally and, written anyway through a
// raw log, ignored by every member.

const test = require('brittle')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const { threeMembers } = require('./_setup.js')
const { eventually, sleep } = require('../helpers.js')

const shownEverywhere = (all, check) => eventually(async () => {
  for (const f of all) if (!(await check(f))) return false
  return true
}, 1000)

const textOf = async (f, id) => {
  const { record } = await f.get(id)
  return record && record.text
}

test('the author edits: every member shows the latest version, same id', async (t) => {
  const { fa, fb, fc, all } = await threeMembers(t)
  const p = await forum.post(fa, 'Typo', 'helo')
  await eventually(async () => (await textOf(fb, p.id)) && (await textOf(fc, p.id)), 3000)
  const edited = await forum.edit(fa, p, { text: 'hello' })
  t.is(edited.id, p.id, 'an edited record keeps its id')
  t.is(edited.title, 'Typo', 'fields not given are kept')
  t.ok(await shownEverywhere(all, async (f) => (await textOf(f, p.id)) === 'hello'), 'everyone shows the edit within 1 s')
  const [first] = await forum.latest(fb)
  t.is(first.text, 'hello')
  t.ok(first.edited, 'marked edited')
  t.is((await forum.latest(fb)).length, 1, 'still one post')
})

test('the author deletes: every member stops showing it and clears its blocks', async (t) => {
  const { fa, fb, fc, all } = await threeMembers(t)
  const p = await forum.post(fa, 'Oops', 'secret')
  await forum.edit(fa, p, { text: 'still secret' })
  await eventually(async () => (await textOf(fb, p.id)) === 'still secret' && (await textOf(fc, p.id)) === 'still secret', 3000)
  await forum.remove(fa, p)
  t.ok(await shownEverywhere(all, async (f) => (await forum.latest(f)).length === 0 && (await f.get(p.id)).record === null), 'gone everywhere within 1 s')
  for (const f of all) {
    t.ok(await eventually(async () => !(await testing.holdsBlock(f, p.id)), 2000), 'the post\'s block is cleared')
  }
  // Live downloads must not fetch it again, even as the logs grow.
  const later = await forum.post(fa, 'later', '')
  await shownEverywhere(all, async (f) => (await forum.latest(f)).length === 1)
  t.ok(later)
  await sleep(1500)
  for (const f of all) t.absent(await testing.holdsBlock(f, p.id), 'and stays cleared')
})

test('someone else\'s edit or delete is refused locally and ignored everywhere', async (t) => {
  const { fa, fb, all } = await threeMembers(t)
  const p = await forum.post(fa, 'Mine', 'by a')
  await eventually(async () => (await textOf(fb, p.id)) === 'by a', 3000)

  await t.exception(forum.edit(fb, p, { text: 'by b' }), /NOT_ALLOWED|author/, 'edit refused locally')
  try { await forum.edit(fb, p, { text: 'by b' }) } catch (err) { t.is(err.code, 'NOT_ALLOWED') }
  try { await forum.remove(fb, p) } catch (err) { t.is(err.code, 'NOT_ALLOWED') }

  // b writes them anyway, bypassing the API, then a post everyone must see.
  await testing.writeRaw(fb, { kind: 'edit', type: 'post', target: p.id, fields: { title: 'Mine', text: 'by b' } })
  await testing.writeRaw(fb, { kind: 'delete', type: 'post', target: p.id, fields: {} })
  const marker = await forum.post(fb, 'after', 'the raw writes')
  t.ok(await shownEverywhere(all, async (f) => (await forum.latest(f)).some((x) => x.id === marker.id)), 'b\'s later post arrived everywhere')
  for (const f of all) t.is(await textOf(f, p.id), 'by a', 'the post is unchanged and still shown')
})

// An open forum with a write limit (story 9, T071a, FR-023; research.md A14):
// a public link lets anyone in, and each device posts at most so much per
// hour. Records beyond it count for nobody — the same for a member who was
// there and a newcomer — and deleting never frees room.

const test = require('brittle')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const { account } = require('./_setup.js')
const { eventually, codeOf } = require('../helpers.js')

const titles = async (f) => (await forum.latest(f, 50)).map((p) => p.title).sort()

test('an open forum: three posts an hour per device; the rest counts for nobody', async (t) => {
  const a = await account(t, 'a')
  const fa = await forum.createForum(a, 'Open')
  const link = await forum.openLink(fa, { perHour: 3 })
  t.is(await codeOf(account(t, 'x').then((x) => forum.join(x, link)).then((fx) => fx.setWriteLimit({ records: 1, periodMs: 1000 }))), 'NOT_ALLOWED', 'only who may decide sets the limit')
  const b = await account(t, 'b')
  const fb = await forum.join(b, link)
  const c = await account(t, 'c')
  const fc = await forum.join(c, link)

  const p1 = await forum.post(fb, 'one', '')
  await forum.post(fb, 'two', '')
  await forum.post(fb, 'three', '')
  t.is(await codeOf(forum.post(fb, 'four', '')), 'NOT_ALLOWED', 'a fourth post within the hour is refused by b\'s own app')
  await testing.writeRaw(fb, { kind: 'put', type: 'post', fields: { title: 'forced', text: 'spam' } }) // a modified app
  const marker = await forum.post(fc, 'from c', '')
  for (const f of [fa, fc]) {
    t.ok(await eventually(async () => (await forum.latest(f)).some((p) => p.id === marker.id), 5000))
  }
  t.alike(await titles(fa), ['from c', 'one', 'three', 'two'], 'a counts b\'s first three only')
  t.alike(await titles(fc), await titles(fa), 'c too')

  await forum.remove(fb, p1) // deleting is always allowed...
  t.is(await codeOf(forum.post(fb, 'again', '')), 'NOT_ALLOWED', '...and never frees room')

  const d = await account(t, 'd')
  const fd = await forum.join(d, link)
  t.ok(await eventually(async () => (await titles(fd)).length === 3, 5000), 'a newcomer gets the posts')
  t.alike(await titles(fd), ['from c', 'three', 'two'], 'and counts the same as the members who were there')
  t.alike(await titles(fa), await titles(fd))

  await fa.setWriteLimit({ records: 10, periodMs: 3600e3 })
  for (const f of [fa, fc, fd]) {
    t.ok(await eventually(async () => (await titles(f)).includes('forced'), 10000), 'a raised limit: the forced post counts now, for everyone')
  }
  await forum.post(fb, 'five', '')
  await fa.setWriteLimit(null)
  t.ok(await eventually(async () => (await titles(fd)).includes('five'), 5000), 'no limit')
})

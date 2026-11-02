// Spec 015 (US2): a member in many forums. Only some stay open (bookmarked,
// own, recently visited); visiting another opens it, leaving it idle closes
// it again, and what was posted meanwhile shows at the next visit. The app
// does nothing for this: a forum opens when it is read or written.

const test = require('brittle')
const forum = require('./forum.js')
const { account, device } = require('./_setup.js')
const { eventually } = require('../helpers.js')

const small = { maxOpen: 3, maxAnnounced: 1, idleMs: 400 }

test('a member in many forums: visits open one, idle ones close, bookmarks stay online', async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b', small)
  const forums = []
  for (let i = 0; i < 5; i++) {
    const fa = await forum.createForum(a, 'Forum ' + i)
    await forum.post(fa, 'Welcome to ' + i, '')
    await forum.join(b, await forum.invite(fa))
    forums.push(fa)
  }
  t.is(forum.forums(b).length, 5, 'b is in five forums')
  t.ok(await eventually(() => forum.forums(b).filter((f) => f.opened).length <= 3, 5000), 'at most three open')

  const visit = b.space(forums[0].key)
  t.ok(await eventually(async () => (await forum.latest(visit)).length === 1, 10000), 'visiting the first forum reads it')
  await forum.post(visit, 'from b', '')
  t.ok(await eventually(() => !visit.opened, 5000), 'left idle, it closes')

  const meanwhile = await forum.post(forums[0], 'while b was away', '')
  t.ok(await eventually(async () => (await forum.latest(visit)).some((p) => p.id === meanwhile.id), 10000), 'the next visit shows what was posted meanwhile')
  t.ok(await eventually(async () => (await forum.latest(forums[0])).some((p) => p.title === 'from b'), 10000), 'and a has b\'s post')

  const kept = b.space(forums[1].key)
  await forum.bookmark(b, kept)
  t.alike(forum.bookmarks(b), [kept.key])
  t.ok(kept.opened, 'a bookmarked forum opens')
  await new Promise((resolve) => setTimeout(resolve, 1200))
  t.ok(kept.opened, 'and stays open')
  const live = await forum.post(forums[1], 'b is online here', '')
  t.ok(await eventually(async () => (await kept.query('post').latest(5)).items.some((p) => p.id === live.id), 10000), 'it keeps receiving')

  const { code } = await forum.addDevice(b)
  const phone = await device(t, 'b-phone', code, small)
  t.ok(await eventually(() => forum.bookmarks(phone).includes(kept.key), 20000), 'b\'s other device has the bookmark')
  t.ok(await eventually(() => forum.forums(phone).length === 5, 20000), 'and every forum, most of them closed')
  await forum.unbookmark(b, kept)
  t.alike(forum.bookmarks(b), [])
})

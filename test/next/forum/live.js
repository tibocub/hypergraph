// Story 1 #4, FR-010: a live list of the latest posts updates on a new post
// without the app asking again, and is not recomputed when only comments or
// votes arrive.

const test = require('brittle')
const forum = require('./forum.js')
const { threeMembers } = require('./_setup.js')
const { eventually } = require('../helpers.js')

test('a live latest-posts list follows posts, not comments or votes', async (t) => {
  const { fa, fb, fc } = await threeMembers(t)
  let runs = 0
  let posts = []
  const stop = forum.liveLatest(fa, (items) => { runs++; posts = items })
  t.teardown(stop)
  t.ok(await eventually(() => runs >= 1, 2000), 'called once at the start')

  const p = await forum.post(fb, 'Live', 'from b')
  t.ok(await eventually(() => posts.some((x) => x.id === p.id), 1000), 'b\'s post shows up within 1 s')

  await eventually(async () => (await forum.latest(fc)).length === 1, 3000)
  const before = runs
  await forum.comment(fc, p, 'nice')
  await forum.vote(fc, p, 1)
  await forum.vote(fb, p, 1)
  t.ok(await eventually(async () => (await fa.count('comment', { on: p })).value === 1 && (await forum.score(fa, p)) === 2, 3000), 'a indexed the comment and votes')
  t.is(runs, before, 'the posts list was not recomputed')

  await forum.edit(fb, p, { title: 'Live, edited' })
  t.ok(await eventually(() => posts.some((x) => x.title === 'Live, edited'), 3000), 'b\'s edit shows up (spec 012: edits fire change)')

  stop()
  const stopped = runs
  await forum.post(fb, 'After stop', '')
  await eventually(async () => (await forum.latest(fa)).length === 2, 3000)
  t.is(runs, stopped, 'stopped lists stay stopped')
})

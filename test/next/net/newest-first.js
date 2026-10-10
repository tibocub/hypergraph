// A newcomer to a big space reads it newest first (story 9, US9 #1, T071b;
// research.md A14): its first page is complete after downloading only the
// newest periods; a page further back widens what it reads; in the background
// the rest arrives while the space fits its share, and never beyond it.
// Principle I: what it shows once complete is what a member holding
// everything shows.

const test = require('brittle')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { PERIOD_MS } = require('../../../lib/activity.js')
const { account } = require('../forum/_setup.js')
const { eventually } = require('../helpers.js')

const HOURS = 150
const PER_HOUR = 4
const N = HOURS * PER_HOUR

// A forum created HOURS ago by a, with N posts spread over those hours (the
// newest now), then today's activity on the newest posts.
async function archive (t) {
  t.teardown(testing.bigSpaces({ records: 200 })) // a "big" space for this test: more than 200 records
  const a = await account(t, 'a')
  const start = Date.now() - HOURS * PERIOD_MS
  testing.setClock(a, start - Date.now() - 1000, { decisions: true })
  const fa = await forum.createForum(a, 'Archive')
  testing.setClock(a, 0, { decisions: true })
  const ids = []
  for (let i = 0; i < N; i++) {
    ids.push(await testing.writeRaw(fa, { kind: 'put', type: 'post', stamp: start + Math.floor(i * PERIOD_MS / PER_HOUR), fields: { title: `post ${i}`, text: 'an archived post, about a hundred bytes long, as forum posts often are; ' + i } }))
  }
  t.ok(await eventually(async () => (await fa.query('post').latest(1)).items[0]?.title === `post ${N - 1}`, 20000), 'a indexed its archive')
  const newest = async (k) => (await fa.get(ids[N - 1 - k])).record
  await forum.edit(fa, await newest(0), { title: 'post edited today' })
  await forum.remove(fa, await newest(1))
  await forum.hide(fa, await newest(2), 'off topic')
  await forum.vote(fa, await newest(3), 1)
  await forum.comment(fa, await newest(3), 'a comment today')
  return { a, fa, ids }
}

const view = (items) => items.map((p) => [p.id, p.title, p.edited])

test('a newcomer\'s first page is complete after the newest periods only; it equals a full member\'s', async (t) => {
  const { fa, ids } = await archive(t)
  const d = await account(t, 'd')
  const fd = await forum.join(d, await forum.invite(fa))
  const first = await fd.query('post').latest(20)
  t.ok(first.complete, 'the first page is complete')
  t.alike(view(first.items), view((await fa.query('post').latest(20)).items), 'the same page as a\'s')
  t.ok(testing.reading(fd).horizon !== null, 'd reads from a horizon')
  const aLog = testing.ownLog(fa)
  const from = testing.readFrom(fd)[aLog]
  t.ok(from > N / 2, `d read a's log from block ${from} of ${N}, not from the start`)
  const target = (await fa.get(ids[N - 4])).record
  t.is(await forum.score(fd, target), await forum.score(fa, target), 'the same score for a post of the first page')
  const comments = await fd.linked(target, 'comment')
  t.ok(comments.complete && comments.items.length === 1, 'its comment, complete')

  // further back: a page 60 hours old
  let after = first.items.at(-1)
  let page = null
  let theirs = null
  for (let i = 0; i < 12; i++) {
    page = await fd.query('post').latest(20, { after })
    theirs = await fa.query('post').latest(20, { after })
    after = page.items.at(-1)
  }
  t.ok(page.complete, 'a page 60 hours back is complete')
  t.alike(view(page.items), view(theirs.items), 'and the same as a\'s')
})

test('in the background the rest arrives while it fits; a restart keeps where it stands', async (t) => {
  const { fa } = await archive(t)
  const d = await account(t, 'd')
  const fd = await forum.join(d, await forum.invite(fa))
  await fd.query('post').latest(20)
  t.ok(await eventually(() => testing.reading(fd).horizon === null, 30000), 'd reads everything in the end (the default budget fits it)')
  t.ok(fd.isComplete(), 'complete')
  t.is(testing.readFrom(fd)[testing.ownLog(fa)], 1, 'a\'s log read from its first record')
  const all = await fd.query('post').latest(N)
  t.ok(all.complete)
  t.alike(view(all.items), view((await fa.query('post').latest(N)).items), 'every post, as a has them')
})

test('a newcomer whose share is smaller than the space holds the newest part only', async (t) => {
  const { fa } = await archive(t)
  const d = await account(t, 'd')
  await forum.setAppBudget(d, 700e3) // the archive needs about 0.8 MB here
  const fd = await forum.join(d, await forum.invite(fa))
  t.ok((await fd.query('post').latest(20)).complete, 'its first page is complete')
  const aLog = testing.ownLog(fa)
  await eventually(() => fd.status().share !== null, 5000)
  const settled = await eventually(async () => {
    const before = testing.reading(fd).horizon
    await new Promise((resolve) => setTimeout(resolve, 1500))
    return testing.reading(fd).horizon === before
  }, 30000)
  t.ok(settled, 'it stops widening')
  t.ok(testing.reading(fd).horizon !== null, 'and doesn\'t read everything')
  t.ok(testing.readFrom(fd)[aLog] > 1, `a's log read from block ${testing.readFrom(fd)[aLog]} only`)
  t.is(fd.status().held, 'part', 'status says it holds part')
  t.ok(fd.status().stored <= fd.status().share * 1.1, `within its share (${fd.status().stored} of ${fd.status().share} B)`)

  const horizon = testing.reading(fd).horizon
  const dir = d.dir
  await d.close()
  const d2 = await account(t, 'd2', { dir })
  const fd2 = d2.space(fa.key)
  t.is(testing.reading(fd2).horizon, horizon, 'a restart keeps the horizon')
  t.ok(testing.readFrom(fd2)[aLog] > 1, 'and where each log is read from')
})

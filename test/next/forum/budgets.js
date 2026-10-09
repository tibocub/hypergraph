// Story 6 #2, #3, FR-027, SC-011: holding part of a space, within budgets.
// A reader gives the app a small budget and one forum its own; both forums
// grow past them. The reader keeps the newest posts and drops the oldest
// posts' content first, stays within each limit (disk measured, +10%), and
// shows the same lists, counts and scores as a member holding everything:
// dropped content is fetched again when read (and kept), never otherwise.
// Its own records, decision logs and the personal space are never dropped.

const test = require('brittle')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const { account } = require('./_setup.js')
const { eventually, diskUse, sleep } = require('../helpers.js')

const MB = 1e6
const POSTS = 150
const text = (i) => `post ${i} `.padEnd(8000, 'lorem ipsum ') // ~8 KB each

async function grown (t) {
  const a = await account(t, 'author')
  const b = await account(t, 'reader')
  const own = await forum.createForum(a, 'Own budget')
  const shared = await forum.createForum(a, 'Shared budget')
  const bOwn = await forum.join(b, await forum.invite(own))
  const bShared = await forum.join(b, await forum.invite(shared))
  await forum.setSetting(b, 'theme', 'dark')
  await forum.setAppBudget(b, 3 * MB)
  await forum.setForumBudget(bOwn, 1 * MB)

  const posts = { own: [], shared: [] }
  for (let i = 0; i < POSTS; i++) {
    posts.own.push(await forum.post(own, `own ${i}`, text(i)))
    posts.shared.push(await forum.post(shared, `shared ${i}`, text(i)))
  }
  // Old posts with a few comments and votes (small records, never dropped).
  await forum.comment(own, posts.own[0], 'first!')
  await forum.vote(own, posts.own[0], 1)
  await forum.comment(shared, posts.shared[1], 'first!')
  await forum.vote(shared, posts.shared[1], 1)
  const settled = await eventually(async () => {
    const s1 = bOwn.status()
    const s2 = bShared.status()
    const latest = await forum.latest(bShared, 1)
    return latest.length && latest[0].id === posts.shared.at(-1).id && s1.held === 'part' && s2.held === 'part' && s1.stored <= s1.share * 1.1 && s2.stored <= s2.share * 1.1
  }, 30000)
  t.ok(settled, 'the reader holds part of both forums, within their shares')
  return { a, b, own, shared, bOwn, bShared, posts }
}

test('a forum with its own budget keeps within it; the other within the rest; disk within the app budget', async (t) => {
  const { b, bOwn, bShared } = await grown(t)
  const s1 = bOwn.status()
  const s2 = bShared.status()
  t.is(s1.budget, 1 * MB, 'its own budget')
  t.ok(s1.stored <= 1.1 * MB, `the forum with its own budget: ${s1.stored} B stored`)
  t.is(s2.budget, null, 'the other shares the app budget')
  t.ok(s2.share < 2 * MB && s2.stored <= s2.share * 1.1, `the other: ${s2.stored} B of its ${Math.round(s2.share)} B share`)
  const { budget, used } = await forum.storage(b)
  t.is(budget, 3 * MB)
  t.ok(used <= 3.3 * MB, `the app's estimate: ${used} B`)

  await testing.compact(b) // what the app does by itself after dropping a tenth of its budget (at most every 10 min)
  const disk = diskUse(b.dir)
  t.ok(disk <= 3.3 * MB, `measured on disk: ${disk} B (app budget 3 MB +10%)`)

  await forum.setForumBudget(bOwn, null)
  t.is(bOwn.status().budget, null, 'given back to the shared budget')
})

test('the newest part is held, the oldest content dropped first; the reader shows what a full member shows', async (t) => {
  const { own, shared, bOwn, bShared, posts } = await grown(t)
  // "Settled" allows 10% over the share: the drop that brings it under may
  // still be on its way (a budget pass runs shortly after the last change).
  t.ok(await eventually(async () => !(await testing.holdsBlock(bShared, posts.shared[0].id)), 15000), 'the oldest post\'s content is dropped')
  t.ok(await testing.holdsBlock(bShared, posts.shared.at(-1).id), 'the newest is held')

  const page = await bShared.query('post').latest(20)
  t.ok(page.complete, 'the latest page is complete')
  t.alike(page.items.map((p) => p.title), posts.shared.slice(-20).reverse().map((p) => p.title))
  t.ok(page.items.every((p) => p.text.length > 7000), 'with its content')

  for (const [full, reader, p] of [[own, bOwn, posts.own[0]], [shared, bShared, posts.shared[1]]]) {
    t.is(await forum.score(reader, p), await forum.score(full, p), 'the same score as a full member')
    const n = await reader.count('comment', { on: p })
    t.is(n.value, 1, 'the same count of comments')
    t.ok(n.complete)
  }
})

test('dropped content is fetched when read, and kept; never fetched otherwise', async (t) => {
  const { bShared, posts } = await grown(t)
  const oldest = posts.shared[0]
  await sleep(2000)
  t.absent(await testing.holdsBlock(bShared, oldest.id), 'not fetched again while nobody reads it')

  // Paging back to the oldest posts: fetched within the bound.
  const last = posts.shared[20]
  const page = await bShared.query('post').latest(20, { after: last })
  t.ok(page.complete, 'the old page is complete: fetched within the bound')
  t.alike(page.items.map((p) => p.title), posts.shared.slice(0, 20).reverse().map((p) => p.title))
  t.ok(page.items.every((p) => p.text.length > 7000), 'with its content')
  t.ok(await testing.holdsBlock(bShared, oldest.id), 'what was read is kept')
  const { record } = await bShared.get(oldest.id)
  t.is(record.text, oldest.text, 'get() shows it too')
  const s = bShared.status()
  t.ok(await eventually(() => bShared.status().stored <= s.share * 1.1, 10000), 'still within its share (newer unread content went instead)')
})

test('the author keeps all its own records over its budget, and is told', async (t) => {
  const { a, b, own, bOwn, posts } = await grown(t)
  await forum.setAppBudget(a, 1 * MB)
  t.ok(await eventually(() => own.status().warnings.some((w) => w.code === 'OVER_BUDGET'), 10000), 'warned: over budget with records it may not drop')
  for (const p of [posts.own[0], posts.own.at(-1)]) t.ok(await testing.holdsBlock(own, p.id), 'its own posts stay')
  t.ok(own.status().held === 'all')

  // The reader's decision log and personal space are never dropped.
  t.is(await forum.setting(b, 'theme'), 'dark', 'the reader\'s settings')
  t.is(await forum.roleOf(bOwn, b.identity.publicKey), 'member', 'and the decisions')
})

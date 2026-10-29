// Spec 012 US5 (CLAUDE.md rule 3): the forum's screens show what this device
// holds at once, say when more is on its way (`complete`), and update
// themselves: a newcomer, members offline, a thread edited elsewhere, the
// members list, the forums list. No polling in the app: `eventually` here
// only waits for the screen to show what the test expects.

const test = require('brittle')
const forum = require('./forum.js')
const { account, threeMembers } = require('./_setup.js')
const { eventually } = require('../helpers.js')

// What a screen showed last, and whether it ever showed "still syncing".
function screen () {
  const s = { items: null, complete: null, syncing: false, updates: 0 }
  s.show = (items, complete) => {
    Object.assign(s, { items, complete, updates: s.updates + 1 })
    if (complete === false) s.syncing = true
  }
  return s
}

test('a newcomer\'s front page: what it holds at once, then the latest 20, complete', { timeout: 90000 }, async (t) => {
  const a = await account(t, 'a')
  const fa = await forum.createForum(a, 'Busy')
  const posts = []
  for (let i = 0; i < 50; i++) posts.push(await forum.post(fa, `post ${i}`, ''))
  const n = await account(t, 'newcomer')
  const fn = await forum.join(n, await forum.invite(fa))
  const front = screen()
  t.teardown(forum.liveLatest(fn, front.show))
  t.ok(await eventually(() => front.complete === true, 20000), 'complete, by itself')
  t.alike(front.items.map((p) => p.title), posts.slice(-20).reverse().map((p) => p.title), 'the latest 20')
})

test('everyone else offline: the front page shows what is here, still syncing, at once', { timeout: 90000 }, async (t) => {
  const { a, b, c, fa, fb } = await threeMembers(t)
  const p = await forum.post(fb, 'from b', '')
  t.ok(await eventually(async () => (await forum.latest(fa)).some((x) => x.id === p.id), 10000), 'a holds b\'s post')
  await b.close()
  await c.close()
  await a.close()
  const a2 = await account(t, 'a2', { dir: a.dir })
  const front = screen()
  const t0 = Date.now()
  t.teardown(forum.liveLatest(a2.space(fa.key), front.show))
  t.ok(await eventually(() => front.updates > 0, 1000), 'shown')
  t.ok(Date.now() - t0 < 1000, 'at once')
  t.is(front.complete, false, 'still syncing (nobody here to ask)')
  t.ok(front.items.some((x) => x.id === p.id), 'with what a holds')
})

test('a live thread follows a reply edited and one deleted on another member\'s app', { timeout: 90000 }, async (t) => {
  const { fa, fb, fc } = await threeMembers(t)
  const p = await forum.post(fa, 'Thread', '')
  const r1 = await forum.comment(fb, p, 'first')
  const r2 = await forum.comment(fc, p, 'second')
  const thread = screen()
  t.teardown(forum.liveThread(fa, p, thread.show))
  t.ok(await eventually(() => thread.items?.length === 2, 10000), 'both replies')
  await forum.edit(fb, r1, { text: 'first, edited' })
  t.ok(await eventually(() => thread.items.some((r) => r.text === 'first, edited'), 10000), 'the edit shows')
  await forum.remove(fc, r2)
  t.ok(await eventually(() => thread.items.length === 1 && thread.items[0].id === r1.id, 10000), 'the deleted reply goes')
})

test('the members list and the forums list update themselves', { timeout: 90000 }, async (t) => {
  const { b, fa, fb } = await threeMembers(t)
  const people = screen()
  t.teardown(forum.liveMembers(fb, (members) => people.show(members)))
  const c = (await forum.people(fa)).find((m) => m.role === 'member' && m.identity !== b.identity.publicKey)
  await forum.giveRole(fa, c.identity, 'moderator')
  t.ok(await eventually(() => people.items?.some((m) => m.identity === c.identity && m.role === 'moderator'), 10000), 'b\'s members list shows the new moderator')

  const list = screen()
  t.teardown(forum.liveForums(b, (forums) => list.show(forums)))
  const sub = await forum.createSubforum(fa, 'News')
  t.ok(await eventually(() => list.items.some((f) => f.key === sub.key && f.name === 'News'), 10000), 'b\'s forums list shows the new sub-forum, named')
})

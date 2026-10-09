// Bounded reads (research R13, FR-011, SC-007): a read whose data's only
// holder is offline returns within its bound marked incomplete; once the
// holder is back, the same read is complete.

const test = require('brittle')
const forum = require('../forum/forum.js')
const { account } = require('../forum/_setup.js')
const { eventually } = require('../helpers.js')

test('a lone member\'s reads are complete at once', async (t) => {
  const a = await account(t, 'alone')
  const fa = await forum.createForum(a, 'Solo')
  await forum.post(fa, 'hi', '')
  const t0 = Date.now()
  const { items, complete } = await fa.query('post').latest(20)
  t.ok(complete)
  t.is(items.length, 1)
  t.ok(Date.now() - t0 < 500, 'no waiting')
})

test('the only holder offline: incomplete within the bound; back online: complete', async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Bounded')
  const fb = await forum.join(b, await forum.invite(fa))
  const p1 = await forum.post(fb, 'one', '')
  t.ok(await eventually(async () => (await forum.latest(fa)).length === 1, 3000))
  await a.close()
  await b.close()

  const b2 = await account(t, 'b2', { dir: b.dir })
  const p2 = await forum.post(b2.space(fa.key), 'two, written while a was away', '')
  await b2.close()

  const a2 = await account(t, 'a2', { dir: a.dir })
  const t0 = Date.now()
  const offline = await a2.space(fa.key).query('post').latest(20, { timeout: 1000 })
  const took = Date.now() - t0
  t.ok(took < 1500, `returned within the bound (${took} ms)`)
  t.is(offline.complete, false, 'marked incomplete')
  t.alike(offline.items.map((x) => x.id), [p1.id], 'with what a holds')

  await account(t, 'b3', { dir: b.dir })
  const back = await eventually(async () => {
    const r = await a2.space(fa.key).query('post').latest(20, { timeout: 1000 })
    return r.complete && r.items.length === 2 ? r : null
  }, 20000)
  t.ok(back, 'complete once b is back')
  t.alike(back && back.items.map((x) => x.id), [p2.id, p1.id])
})

// "Complete" = everything this member knows of is held, and it reached at
// least one other member since starting (research.md A4). A member nobody has
// heard from (here: let in while away, never online since) doesn't make
// answers incomplete forever.
test('a member whose log nobody holds does not make answers incomplete', async (t) => {
  const crypto = require('hypercore-crypto')
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Quiet member')
  const fb = await forum.join(b, await forum.invite(fa))
  await fa.decisions.append({ type: 'member/add', identity: crypto.randomBytes(32) }) // someone who never comes
  const p = await forum.post(fb, 'hello', '')
  const r = await eventually(async () => {
    const res = await fa.query('post').latest(20, { timeout: 500 })
    return res.items.some((x) => x.id === p.id) ? res : null
  }, 5000)
  t.ok(r, 'a holds b\'s post')
  t.ok(r && r.complete, 'complete: everything a knows of is held, and a reached b')
})

// Story 6 #4 (SC-007): content this member dropped, its only other holder
// offline. The read returns within its bound, without it, incomplete; with the
// holder back, the same read is complete and shows it.
test('dropped content, its holder offline: incomplete within the bound; back: complete', async (t) => {
  const testing = require('../../../lib/testing.js')
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Dropped')
  const fb = await forum.join(b, await forum.invite(fa))
  await b.setBudget(1.5e6)
  const posts = []
  for (let i = 0; i < 120; i++) posts.push(await forum.post(fa, `p${i}`, `post ${i} `.padEnd(8000, 'lorem ipsum ')))
  t.ok(await eventually(async () => (await forum.latest(fb, 1))[0]?.id === posts.at(-1).id && !(await testing.holdsBlock(fb, posts[0].id)), 30000), 'b dropped the oldest content')
  await a.close()

  const t0 = Date.now()
  const old = await fb.query('post').latest(5, { after: posts[5], timeout: 1000 })
  const took = Date.now() - t0
  t.ok(took < 1500, `returned within the bound (${took} ms)`)
  t.is(old.complete, false, 'marked incomplete')
  t.absent(old.items.some((p) => p.id === posts[0].id), 'without what it couldn\'t fetch')
  const { record, complete } = await fb.get(posts[0].id, { timeout: 500 })
  t.is(record, null)
  t.is(complete, false)

  await account(t, 'a2', { dir: a.dir })
  const back = await eventually(async () => {
    const r = await fb.query('post').latest(5, { after: posts[5], timeout: 1000 })
    return r.complete ? r : null
  }, 20000)
  t.ok(back, 'complete once a is back')
  t.alike(back && back.items.map((p) => p.title), ['p4', 'p3', 'p2', 'p1', 'p0'])
})

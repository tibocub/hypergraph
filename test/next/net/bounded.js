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

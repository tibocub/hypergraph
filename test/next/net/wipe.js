// A deleted record stays wiped (FR-028): after members disconnect, reconnect
// and restart, no member holds its block again, so nobody can serve it; a
// newcomer never gets it, and the hole it leaves doesn't stop the newcomer
// from indexing what comes after, nor its answers from being complete.

const test = require('brittle')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { account, threeMembers } = require('../forum/_setup.js')
const { eventually, sleep } = require('../helpers.js')

const holdsNone = async (spaces, id) => {
  for (const f of spaces) if (await testing.holdsBlock(f, id)) return false
  return true
}
const shows = (f, id) => eventually(async () => (await forum.latest(f)).some((p) => p.id === id), 10000)

test('a deleted record stays wiped after reconnecting and restarting', async (t) => {
  const { b, c, fa, fb, fc, all } = await threeMembers(t)
  const before = await forum.post(fa, 'before', '')
  const gone = await forum.post(fa, 'gone', 'secret')
  const after = await forum.post(fa, 'after', '')
  for (const f of all) t.ok(await shows(f, after.id), 'everyone holds the three posts')
  await forum.remove(fa, gone)
  t.ok(await eventually(() => holdsNone(all, gone.id), 3000), 'wiped everywhere')

  // b and c go away and come back (new connections, new downloads); a writes meanwhile.
  await b.close()
  await c.close()
  const later = await forum.post(fa, 'while they were away', '')
  const b2 = await account(t, 'b2', { dir: b.dir })
  const c2 = await account(t, 'c2', { dir: c.dir })
  const back = [fa, b2.space(fb.key), c2.space(fc.key)]
  for (const f of back) t.ok(await shows(f, later.id), 'back in sync')
  await sleep(1500) // time for any download that would fetch it again
  t.ok(await holdsNone(back, gone.id), 'nobody holds the deleted block again')
  for (const f of back) t.ok(await eventually(async () => (await forum.latest(f)).length === 3), 'three posts shown')
  t.ok(before)
})

test('a newcomer after a delete: never gets the block, indexes past it, answers complete', async (t) => {
  const { fa, fb } = await threeMembers(t)
  const gone = await forum.post(fa, 'gone', 'secret')
  const after = await forum.post(fa, 'after', '')
  t.ok(await shows(fb, after.id))
  await forum.remove(fa, gone)
  t.ok(await eventually(() => holdsNone([fa, fb], gone.id), 3000))

  const d = await account(t, 'd')
  const fd = await forum.join(d, await forum.invite(fa))
  t.ok(await shows(fd, after.id), 'the post after the hole is indexed')
  const { items, complete } = await fd.query('post').latest(20, { timeout: 3000 })
  t.alike(items.map((p) => p.id), [after.id])
  t.ok(complete, 'the hole of a deleted record does not make answers incomplete')
  await sleep(1000)
  t.absent(await testing.holdsBlock(fd, gone.id), 'the newcomer never got the deleted block')
})

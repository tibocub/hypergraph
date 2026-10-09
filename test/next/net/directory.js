// The log directory (research R10, R17): a newcomer learns every member's log
// from any one member; a new log is announced and fetched; a non-member's log
// is neither kept nor passed on; members started at the same moment meet.

const test = require('brittle')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { account, threeMembers } = require('../forum/_setup.js')
const { eventually, sleep } = require('../helpers.js')

test('a newcomer learns every member\'s log from one member', async (t) => {
  const { b, c, fa, fb, fc } = await threeMembers(t)
  const pb = await forum.post(fb, 'from b', '')
  const pc = await forum.post(fc, 'from c', '')
  t.ok(await eventually(async () => (await forum.latest(fa)).length === 2, 3000), 'a holds both')
  await b.close()
  await c.close()

  const d = await account(t, 'd')
  const fd = await forum.join(d, await forum.invite(fa))
  t.ok(await eventually(async () => {
    const got = (await forum.latest(fd)).map((p) => p.id)
    return got.includes(pb.id) && got.includes(pc.id)
  }, 5000), 'd sees b\'s and c\'s posts, learned from a alone')
  t.is(testing.logs(fd).length, 4, 'd knows a, b, c and its own log')

  const pd = await forum.post(fd, 'from d', '')
  t.ok(await eventually(async () => (await forum.latest(fa)).some((p) => p.id === pd.id), 2000), 'd\'s new log reached a')
})

test('a non-member\'s log is neither kept nor passed on', async (t) => {
  const { fa, fb } = await threeMembers(t)
  const e = await account(t, 'stranger')
  const fe = await testing.openSpace(e, fa.key)
  await testing.writeRaw(fe, { kind: 'put', type: 'post', fields: { title: 'spam', text: 'buy now' } })
  const marker = await forum.post(fb, 'real', '')
  await eventually(async () => (await forum.latest(fa)).some((p) => p.id === marker.id), 3000)
  await sleep(1500) // time for e's log to be offered and refused
  for (const f of [fa, fb]) {
    t.absent((await forum.latest(f)).some((p) => p.title === 'spam'), 'no spam shown')
    t.absent(testing.logs(f).includes(testing.ownLog(fe)), 'the stranger\'s log is not in the directory')
  }
  t.is(testing.logs(fa).length, 3, 'a, b and c only')
})

test('a second space joined over a connection already open: its channel opens too', async (t) => {
  // Found in story 3 (research.md A7): Protomux turns down a channel the
  // other side opens before this side has one, so a space opened later on a
  // connection already up never got its channel, and its invite was never
  // heard.
  const { a, b, fa } = await threeMembers(t)
  const p = await forum.post(fa, 'connected', '')
  t.ok(await eventually(async () => (await forum.latest(b.space(fa.key))).some((x) => x.id === p.id), 5000), 'a and b are connected')
  const second = await forum.createForum(a, 'Second')
  const fb2 = await forum.join(b, await forum.invite(second), { timeout: 10000 })
  const q = await forum.post(fb2, 'in the second forum', '')
  t.ok(await eventually(async () => (await forum.latest(second)).some((x) => x.id === q.id), 5000), 'a sees b\'s post in it')
})

test('two members started at the same moment still meet', async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Restart')
  await forum.join(b, await forum.invite(fa))
  await a.close()
  await b.close()

  const [a2, b2] = await Promise.all([account(t, 'a2', { dir: a.dir }), account(t, 'b2', { dir: b.dir })])
  const p = await forum.post(a2.space(fa.key), 'after restart', '')
  t.ok(await eventually(async () => (await forum.latest(b2.space(fa.key))).some((x) => x.id === p.id), 20000), 'b sees a\'s new post')
})

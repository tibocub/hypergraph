// A fixed number of copies. A member's space is kept by 5 holders
// in all (split across its circles, ranked by a hash, one device per
// person), the next ranked taking over when one leaves; an extra copy while
// none is online; a holder unseen 7 days replaced, and told to delete when
// seen again; hg.copiesOf() for "kept by N of 5 copies".


const test = require('brittle')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { account } = require('../forum/_setup.js')
const { eventually } = require('../helpers.js')
const { holdsAll, heldBy, circleOf, keptByExactly } = require('./_circles.js')

test('a circle of 8: each space on exactly 5 holders, copiesOf(); a holder leaves, the next takes over', { timeout: 300000 }, async (t) => {
  const { a, circle, holders } = await circleOf(t, 7)
  const one = await forum.createForum(a, 'One', { private: true })
  await forum.post(one, 'hi', '')
  const two = await forum.createForum(a, 'Two', { private: true })
  await forum.post(two, 'hi', '')
  t.ok(await keptByExactly(holders, one, 5), 'one: 5 copies')
  t.ok(await keptByExactly(holders, two, 5), 'two: 5 copies')
  t.ok(await eventually(() => a.copiesOf(one.key).kept === 5, 20000))
  t.alike(a.copiesOf(one.key), { wanted: 5, kept: 5, online: 5 })
  t.is(circle.status().keptBy, undefined, 'keptBy is gone')
  t.is(circle.status().holders, 7)

  const before = await heldBy(holders, one)
  const leaver = before[0]
  await leaver.leaveSpace(circle.key)
  const rest = holders.filter((h) => h !== leaver)
  t.ok(await eventually(async () => (await heldBy(rest, one)).length === 5, 60000), 'the next ranked takes over')
  t.ok((before.slice(1)).every((h) => rest.includes(h)), 'the others stay')
  t.ok(await eventually(async () => !(await holdsAll(leaver, one)), 20000), 'the one who left deleted it')
})

test('two circles: 3 + 2 copies', { timeout: 300000 }, async (t) => {
  const x = await circleOf(t, 3, { name: 'X', prefix: 'x' })
  const y = await circleOf(t, 3, { name: 'Y', a: x.a, prefix: 'y' })
  const s = await forum.createForum(x.a, 'S', { private: true })
  await forum.post(s, 'hi', '')
  t.ok(await keptByExactly([...x.holders, ...y.holders], s, 5), '5 copies in all')
  const parts = [(await heldBy(x.holders, s)).length, (await heldBy(y.holders, s)).length].sort().join('+')
  t.is(parts, '2+3')
  t.alike(x.a.copiesOf(s.key).wanted, 5)
})

test('no copy online: one extra copy at once, dropped once 2 are back; a delete from anyone else is refused', { timeout: 300000 }, async (t) => {
  const { a, holders } = await circleOf(t, 6)
  const s = await forum.createForum(a, 'S', { private: true })
  await forum.post(s, 'hi', '')
  t.ok(await keptByExactly(holders, s, 5))
  const regular = await heldBy(holders, s)
  const spare = holders.find((h) => !regular.includes(h))

  const key = (await testing.coreKeys(s)).values().next().value
  t.is(await testing.askDelete(spare, regular[0], key), false, 'refused')
  t.ok(await holdsAll(regular[0], s), 'still held')

  const dirs = regular.map((h) => h.dir)
  for (const h of regular) await h.close()
  t.ok(await eventually(() => holdsAll(spare, s), 60000), 'the spare holds an extra copy')
  t.ok(await eventually(() => a.copiesOf(s.key).kept === 6, 20000))
  t.alike(a.copiesOf(s.key), { wanted: 5, kept: 6, online: 1 }, 'the 5 regular ones and the extra')

  const back = []
  for (const [i, dir] of dirs.slice(0, 2).entries()) back.push(await account(t, 'back' + i, { dir }))
  t.ok(await eventually(async () => !(await holdsAll(spare, s)), 60000), '2 back: the extra copy goes')
  t.ok(await eventually(() => a.copiesOf(s.key).online === 2, 20000))
  t.is(a.copiesOf(s.key).kept, 5)
})

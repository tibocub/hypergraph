// Spec 023 in the forum: friends in a circle keep each other's private
// boards online, so a board's reader gets its latest posts while every one
// of its members is away; the friends keeping it can't read it.

const test = require('brittle')
const forum = require('./forum.js')
const { account } = require('./_setup.js')
const { eventually } = require('../helpers.js')

test('a private board is kept by a friend\'s device while its members are offline', { timeout: 180000 }, async (t) => {
  const ann = await account(t, 'ann')
  const bob = await account(t, 'bob') // ann's friend, keeps her boards
  const cat = await account(t, 'cat') // reads ann's board, not in the circle
  const friends = await forum.createCircle(ann, 'Friends')
  await forum.join(bob, await forum.invite(friends))
  await forum.keepOnline(bob)

  const board = await forum.createForum(ann, 'Book club', { private: true })
  const fc = await forum.join(cat, await forum.invite(board))
  t.ok(await eventually(async () => (await forum.latest(fc)).length === 0, 10000))
  await cat.close()

  await forum.post(board, 'Next book', 'Dune, chapter 3')
  t.ok(await eventually(async () => (await forum.keptBy(friends)).kept === 1, 30000), 'kept by 1 of 2')
  t.alike(await forum.keptBy(friends), { kept: 1, of: 2 })
  await ann.close()

  const cat2 = await account(t, 'cat again', { dir: cat.dir })
  const back = cat2.space(board.key)
  t.ok(await eventually(async () => (await forum.latest(back)).some((p) => p.title === 'Next book'), 60000), 'cat reads it with ann away')
})

// Specs 023, 024 and 026 in the forum: friends in a circle keep each other's
// private boards online, 5 copies of each, so a board's reader gets its
// latest posts while every one of its members is away; the friends keeping
// it can't read it.

const test = require('brittle')
const forum = require('./forum.js')
const { account } = require('./_setup.js')
const { eventually } = require('../helpers.js')

test('a private board in a circle of 8 is kept in 5 copies while its members are offline', { timeout: 300000 }, async (t) => {
  const ann = await account(t, 'ann')
  const cat = await account(t, 'cat') // reads ann's board, not in the circle
  const friends = await forum.createCircle(ann, 'Friends')
  for (let i = 0; i < 7; i++) { // ann's friends keep her boards
    const friend = await account(t, 'friend' + i)
    await forum.join(friend, await forum.invite(friends))
    await forum.keepOnline(friend)
  }

  const board = await forum.createForum(ann, 'Book club', { private: true })
  const fc = await forum.join(cat, await forum.invite(board))
  t.ok(await eventually(async () => (await forum.latest(fc)).length === 0, 10000))
  await cat.close()

  await forum.post(board, 'Next book', 'Dune, chapter 3')
  t.ok(await eventually(async () => forum.copies(ann, board).kept === 5, 60000), 'kept by 5 of 5 copies')
  t.alike(forum.copies(ann, board), { wanted: 5, kept: 5, online: 5 })
  // the Members list's numbers: each friend's share (and what they hold), the circle's room after its 5 copies
  t.ok(await eventually(async () => (await friends.members()).filter((m) => m.share === 1e9 && m.used >= 0).length === 7, 30000), 'each friend: 1 GB share')
  t.is((await friends.members()).find((m) => m.you).share, null, 'ann holds nothing: no number')
  t.is(friends.status().total, 7e9 / 5, "the circle's room: 7 GB / 5 copies")
  await ann.close()

  const cat2 = await account(t, 'cat again', { dir: cat.dir })
  const back = cat2.space(board.key)
  t.ok(await eventually(async () => (await forum.latest(back)).some((p) => p.title === 'Next book'), 60000), 'cat reads it with ann away')
})

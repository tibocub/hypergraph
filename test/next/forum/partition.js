// SC-003: a partition healed after both sides wrote. Three members; c goes
// offline and keeps writing (posts, comments, votes, an edit, a shared note)
// while a and b write too, on the same records; once c is back online, every
// member shows the same posts, comments, scores and versions.

const test = require('brittle')
const forum = require('./forum.js')
const { threeMembers } = require('./_setup.js')
const { eventually, open } = require('../helpers.js')

const view = async (f, post, note) => {
  const posts = (await forum.latest(f, 50)).map((p) => `${p.title}:${p.text}`).sort()
  const comments = (await forum.comments(f, post)).map((x) => x.text).sort()
  const { record } = await f.get(note.id)
  return JSON.stringify({ posts, comments, score: await forum.score(f, post), note: record && record.text })
}

test('a partition healed after both sides wrote: every member shows the same', { timeout: 120000 }, async (t) => {
  const { c, fa, fb, fc } = await threeMembers(t)
  const p = await forum.post(fa, 'Before', 'written while together')
  const note = await forum.pin(fa, 'the board, v1')
  const mine = await forum.post(fc, 'By c', 'v1')
  t.ok(await eventually(async () => (await view(fa, p, note)) === (await view(fc, p, note)), 10000), 'together first')

  // c drops off the network and goes on writing on its own
  await c.close()
  const c2 = await open(t, { dir: c.dir, types: forum.types, rules: forum.rules })
  const gc = c2.space(fc.key)
  await forum.post(gc, 'Offline post', 'by c')
  await forum.comment(gc, p, 'c, offline')
  await forum.vote(gc, p, -1)
  await forum.edit(gc, mine, { text: 'v2, offline' })
  await forum.edit(gc, note, { text: 'the board, by c offline' })

  // meanwhile, the other side
  await forum.post(fb, 'Online post', 'by b')
  await forum.comment(fa, p, 'a, online')
  await forum.vote(fa, p, 1)
  await forum.vote(fb, p, 1)
  await forum.edit(fb, note, { text: 'the board, by b online' })

  // the partition heals
  await c2.connectToSwarm()
  const all = [fa, fb, gc]
  const agreed = await eventually(async () => {
    const seen = await Promise.all(all.map((f) => view(f, p, note)))
    return seen.every((x) => x === seen[0]) && seen[0]
  }, 20000)
  t.ok(agreed, 'every member shows the same')
  const v = JSON.parse(agreed || '{}')
  t.alike(v.comments, ['a, online', 'c, offline'], 'both sides\' comments')
  t.is(v.score, 1, 'one vote per member: 1 + 1 - 1')
  t.ok(v.posts && v.posts.includes('By c:v2, offline') && v.posts.includes('Offline post:by c') && v.posts.includes('Online post:by b'), 'both sides\' posts and the edit')
  t.ok(['the board, by c offline', 'the board, by b online'].includes(v.note), 'the shared note: one version wins, the same everywhere')
})

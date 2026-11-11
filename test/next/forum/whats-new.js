// Spec 021 (CLAUDE.md rule 3): "what's new since my last visit". The forum keeps
// where a person stands in their settings (the same call for a board's unread dot
// and a notification), and a member back from days away finds what others wrote
// meanwhile, posts written offline and clocks gone wrong included.

const test = require('brittle')
const forum = require('./forum.js')
const { account } = require('./_setup.js')
const { eventually } = require('../helpers.js')

const titles = (list) => list.map((r) => r.title || r.text).sort()

test('what\'s new since my last visit', { timeout: 120000 }, async (t) => {
  const ann = await account(t, 'ann')
  const bob = await account(t, 'bob')
  const fa = await forum.createForum(ann, 'Friends')
  const fb = await forum.join(bob, await forum.invite(fa))
  const hello = await forum.post(fa, 'Hello', 'everyone')
  t.ok(await eventually(async () => (await forum.latest(fb)).length === 1, 15000), 'bob reads the forum')

  t.alike(await forum.visit(bob, fb), { posts: [], comments: [] }, 'a first visit: everything is old')

  await bob.close()
  const old = await forum.post(fa, 'While you were away', 'a post')
  const gone = await forum.post(fa, 'Oops', 'deleted right after')
  await forum.comment(fa, hello, 'a comment on an old post')
  await forum.vote(fa, hello, 1) // votes aren't news here
  await forum.edit(fa, hello, { text: 'everyone, edited' }) // nor edits
  await forum.remove(fa, gone)

  const bob2 = await account(t, 'bob2', { dir: bob.dir })
  const f2 = bob2.space(fa.key)
  t.ok(await eventually(async () => (await forum.latest(f2)).some((p) => p.id === old.id) && (await forum.comments(f2, hello)).length === 1, 15000), 'bob caught up')

  t.is((await forum.unread(bob2, f2)), 2, 'the dot says two, and looking at it reads nothing')
  const news = await forum.visit(bob2, f2)
  t.alike(titles(news.posts), ['While you were away'])
  t.alike(titles(news.comments), ['a comment on an old post'])
  t.is((await forum.unread(bob2, f2)), 0, 'seen')
  t.alike(await forum.visit(bob2, f2), { posts: [], comments: [] }, 'nothing twice')
})

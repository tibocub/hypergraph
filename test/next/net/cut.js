// Cuts (research R8, R11, amended in research.md A4): when someone loses the
// right to write — removed, banned — the decision records their device logs'
// lengths as the decider held them. Records below the cut stay for everyone,
// records past it are ignored by everyone: members who indexed them remove
// them, newcomers never index them, and both end up showing the same thing.

const test = require('brittle')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { account, threeMembers } = require('../forum/_setup.js')
const { eventually, sleep, open } = require('../helpers.js')

// What a member shows: posts (ids, texts), and the comments and score of `on`.
async function view (f, on) {
  const posts = (await forum.latest(f)).map((p) => `${p.id}:${p.text}`).sort()
  const comments = (await forum.comments(f, on)).map((c) => c.id).sort()
  return JSON.stringify({ posts, comments, score: await forum.score(f, on) })
}
const agree = (spaces, on, expected) => eventually(async () => {
  for (const f of spaces) if ((await view(f, on)) !== expected) return false
  return true
}, 10000)

test('a removed member: what they wrote before stays for everyone, nothing after; a newcomer agrees', async (t) => {
  const { b, fa, fb, fc, all } = await threeMembers(t)
  const p = await forum.post(fa, 'by a', 'a')
  const before = await forum.post(fb, 'by b', 'before')
  await forum.vote(fb, p, 1)
  const comment = await forum.comment(fb, p, 'b comments')
  const expected = JSON.stringify({ posts: [`${before.id}:before`, `${p.id}:a`].sort(), comments: [comment.id], score: 1 })
  t.ok(await agree(all, p, expected), 'everyone holds b\'s records')

  await forum.removeMember(fa, b.identity.publicKey)
  t.ok(await eventually(async () => (await fb.getRole(b.identity.publicKey)) === null, 5000), 'b learns it was removed')
  await t.exception(forum.post(fb, 'refused', ''), /NOT_ALLOWED|member/, 'b\'s app refuses to write')

  // A misbehaving b writes anyway: a post, a vote replacing its earlier one,
  // an edit of its earlier post, a comment.
  const after = await testing.writeRaw(fb, { kind: 'put', type: 'post', fields: { title: 'after', text: 'after' } })
  await testing.writeRaw(fb, { kind: 'put', type: 'vote', fields: { on: p.id, value: -1 } })
  await testing.writeRaw(fb, { kind: 'edit', type: 'post', target: before.id, fields: { title: 'by b', text: 'edited after' } })
  await testing.writeRaw(fb, { kind: 'put', type: 'comment', fields: { on: p.id, text: 'after' } })
  await sleep(1000)
  t.ok(await agree([fa, fc], p, expected), 'old members ignore everything past the cut')
  t.ok(after)

  const d = await account(t, 'newcomer')
  const fd = await forum.join(d, await forum.invite(fa))
  t.ok(await agree([fa, fc, fd], p, expected), 'a newcomer shows exactly the same records')
  t.ok(await eventually(async () => !(await testing.holdsBlock(fd, after)), 1000), 'and doesn\'t hold what is past the cut')
})

test('a removed member let in again writes again; what they wrote while out stays ignored', async (t) => {
  const { b, fa, fb, fc, all } = await threeMembers(t)
  const p = await forum.post(fa, 'by a', 'a')
  await forum.removeMember(fa, b.identity.publicKey)
  await eventually(async () => (await fb.getRole(b.identity.publicKey)) === null, 5000)
  await testing.writeRaw(fb, { kind: 'put', type: 'post', fields: { title: 'while out', text: '' } })

  const link = await forum.invite(fa)
  await forum.join(b, link)
  const back = await forum.post(fb, 'back', '')
  t.ok(await eventually(async () => {
    for (const f of all) {
      const titles = (await forum.latest(f)).map((x) => x.title).sort().join()
      if (titles !== 'back,by a') return false
    }
    return true
  }, 10000), 'everyone shows the new post, not the one written while out')
  t.ok(back && p && fc)
})

test('members who already showed records past the cut take them back', async (t) => {
  const { a, b, fa, fb, fc } = await threeMembers(t)
  const p = await forum.post(fa, 'by a', 'a')
  const old = await forum.post(fb, 'old', 'old')
  await forum.vote(fb, p, 1)
  t.ok(await agree([fa, fc], p, JSON.stringify({ posts: [`${old.id}:old`, `${p.id}:a`].sort(), comments: [], score: 1 })), "a and c hold b's first records")

  // a goes away; b goes on writing, and c shows it all.
  await a.close()
  const newer = await forum.post(fb, 'newer', 'newer')
  await forum.vote(fb, p, -1)
  await forum.edit(fb, old, { text: 'old, edited' })
  const reply = await forum.comment(fb, p, 'newer comment')
  const later = JSON.stringify({ posts: [`${old.id}:old, edited`, `${newer.id}:newer`, `${p.id}:a`].sort(), comments: [reply.id], score: -1 })
  t.ok(await agree([fc], p, later), "c shows b's newer records")

  // a, offline, removes b where a holds b's log: before the newer records.
  const a2 = await open(t, { dir: a.dir, types: forum.types })
  await forum.removeMember(a2.space(fa.key), b.identity.publicKey)
  await a2.connectToSwarm()
  const expected = JSON.stringify({ posts: [`${old.id}:old`, `${p.id}:a`].sort(), comments: [], score: 1 })
  t.ok(await agree([a2.space(fa.key), fc], p, expected), "c takes back the newer post, comment, vote and edit; b's earlier vote counts again")
  t.ok(await eventually(async () => !(await testing.holdsBlock(fc, newer.id)), 3000), 'and clears their blocks')
})

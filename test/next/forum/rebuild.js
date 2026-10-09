// Story 6 #6, FR-012, SC-008: the local index is rebuilt from what the member
// holds. Deleted or unreadable, it is rebuilt at the next start, and the
// member shows the same as before — offline. After a crash in the middle of
// indexing, only what wasn't saved yet is indexed again.

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const { account, threeMembers } = require('./_setup.js')
const { eventually, open } = require('../helpers.js')

const opts = { types: forum.types, rules: forum.rules }

// What a member shows of the forum and of the person.
async function view (hg, f) {
  const posts = await forum.latest(f, 50)
  const out = []
  const people = new Set()
  for (const p of posts) {
    const comments = await forum.comments(f, p)
    people.add(p.author)
    for (const c of comments) people.add(c.author)
    out.push({
      title: p.title,
      text: p.text,
      edited: p.edited,
      comments: comments.map((c) => c.text).sort(),
      score: await forum.score(f, p),
      tagged: (await forum.tagged(f, 'news')).some((x) => x.id === p.id)
    })
  }
  const roles = {}
  for (const id of [...people].sort()) roles[id] = await forum.roleOf(f, id)
  return JSON.stringify({ out, roles, theme: await forum.setting(hg, 'theme'), devices: (await forum.devices(hg)).map((d) => d.name).sort() })
}

async function busyForum (t) {
  const { a, b, c, fa, fb, fc } = await threeMembers(t)
  const p1 = await forum.post(fa, 'Welcome', 'hello')
  const p2 = await forum.post(fb, 'News', 'v1')
  await forum.edit(fb, p2, { text: 'v2' })
  await forum.tag(fb, p2, 'news')
  await forum.comment(fc, p1, 'hi a')
  await forum.comment(fa, p2, 'nice')
  await forum.vote(fa, p2, 1)
  await forum.vote(fc, p2, 1)
  await forum.vote(fc, p1, -1)
  await forum.giveRole(fa, c.identity.publicKey, 'moderator')
  await forum.setSetting(b, 'theme', 'dark')
  const before = await eventually(async () => {
    const v = await view(b, fb)
    const parsed = JSON.parse(v)
    return parsed.out.length === 2 && parsed.out.every((p) => p.comments.length === 1) && parsed.roles[c.identity.publicKey] === 'moderator' ? v : null
  }, 10000)
  t.ok(before, 'b shows the whole forum')
  return { a, b, c, fa, fb, fc, before }
}

test('the index folder deleted: rebuilt at the next start, the same forum shown, offline', async (t) => {
  const { b, fb, before } = await busyForum(t)
  await b.close()
  fs.rmSync(path.join(b.dir, 'index'), { recursive: true, force: true })

  const again = await open(t, { dir: b.dir, ...opts, readTimeout: 200 }) // not connected (reads wait little): rebuilt from what it holds
  t.is(again.identity.publicKey, b.identity.publicKey, 'the same person')
  t.alike(again.spaces().map((s) => s.key), [fb.key], 'the same forums')
  const f = again.space(fb.key)
  t.ok(await eventually(async () => (await view(again, f)) === before, 10000), 'the same posts, comments, scores, edits, tags, roles, settings and devices')
  await again.connectToSwarm()
  t.ok(await eventually(async () => (await f.query('post').latest(10)).complete, 10000), 'complete once it reaches a member')
})

test('an unreadable index: set aside and rebuilt', async (t) => {
  const { b, fb, before } = await busyForum(t)
  await b.close()
  const dir = path.join(b.dir, 'index')
  for (const name of fs.readdirSync(dir)) if (name === 'CURRENT' || name.startsWith('MANIFEST')) fs.writeFileSync(path.join(dir, name), 'garbage')

  const again = await open(t, { dir: b.dir, ...opts, readTimeout: 200 })
  const f = again.space(fb.key)
  t.ok(await eventually(async () => (await view(again, f)) === before, 10000), 'the same forum shown')
  t.ok(fs.readdirSync(b.dir).some((n) => n.startsWith('index.broken-')), 'the damaged index is kept aside, not deleted')
})

test('a crash in the middle of indexing: only what wasn\'t saved is indexed again', async (t) => {
  const a = await account(t, 'a')
  const fa = await forum.createForum(a, 'Many')
  for (let i = 0; i < 400; i++) await forum.post(fa, `p${i}`, '')
  await a.close()
  fs.rmSync(path.join(a.dir, 'index'), { recursive: true, force: true })

  // Rebuilding; the process "dies" once a few batches were saved.
  testing.crashAfter(4)
  const crashed = await open(t, { dir: a.dir, ...opts })
  t.ok(await eventually(() => testing.crashed(crashed), 10000), 'it crashed while indexing')
  await crashed.close()

  const again = await open(t, { dir: a.dir, ...opts })
  const f = again.space(fa.key)
  t.ok(await eventually(async () => (await forum.latest(f, 500)).length === 400, 20000), 'everything is shown after the restart')
  const redone = testing.indexedBlocks(f)
  t.ok(redone < 400, `only the unsaved part was indexed again (${redone} of 401 blocks)`)
  t.ok(redone > 0)
})

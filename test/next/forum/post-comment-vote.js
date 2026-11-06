// Story 1 #1-3, SC-001: three members; a post appears for everyone within
// 1 s; comments and replies agree; votes count one per member, the latest.

const test = require('brittle')
const forum = require('./forum.js')
const { threeMembers } = require('./_setup.js')
const { eventually } = require('../helpers.js')
const testing = require('../../../lib/testing.js')

const ids = (records) => records.map((r) => r.id).sort()

test('a post reaches every member within a second', async (t) => {
  const { fa, all } = await threeMembers(t)
  const hello = await forum.post(fa, 'Hello', 'First post!')
  t.is(hello.title, 'Hello')
  t.is(typeof hello.id, 'string')

  const seen = await eventually(async () => {
    for (const f of all) if (!(await forum.latest(f)).some((p) => p.id === hello.id)) return false
    return true
  }, 1000)
  t.ok(seen, 'every member shows it within 1 s')
  for (const f of all) {
    const [p] = await forum.latest(f)
    t.alike({ id: p.id, title: p.title, text: p.text, author: p.author }, { id: hello.id, title: 'Hello', text: 'First post!', author: hello.author })
  }
})

test('comments and replies: every member gets the same thread', async (t) => {
  const { fa, fb, fc, all } = await threeMembers(t)
  const p = await forum.post(fa, 'Question', 'How do spaces work?')
  await eventually(async () => (await forum.latest(fb)).length && (await forum.latest(fc)).length, 3000)
  const c1 = await forum.comment(fb, p, 'Like forums.')
  const c2 = await forum.comment(fa, p, 'See the docs.')
  const reply = await forum.comment(fc, c1, 'Exactly.')

  const agreed = await eventually(async () => {
    for (const f of all) {
      if (ids(await forum.comments(f, p)).join() !== ids([c1, c2]).join()) return false
      if (ids(await forum.comments(f, c1)).join() !== reply.id) return false
    }
    return true
  }, 1000)
  t.ok(agreed, 'what points at the post and at the comment agree within 1 s')
  const tree = await forum.thread(fb, p)
  t.is(tree.replies.length, 2)
  t.is(tree.replies.find((r) => r.id === c1.id).replies[0].text, 'Exactly.')
  const { value } = await fc.count('comment', { on: p })
  t.is(value, 2, 'count of comments')
})

test('votes: one per member, the latest counts, the same everywhere', async (t) => {
  const { fa, fb, fc, all } = await threeMembers(t)
  const p = await forum.post(fa, 'Vote on me', '')
  await eventually(async () => (await forum.latest(fb)).length && (await forum.latest(fc)).length, 3000)
  await forum.vote(fa, p, 1)
  await forum.vote(fb, p, 1)
  await forum.vote(fc, p, -1)
  t.ok(await eventually(async () => {
    for (const f of all) if ((await forum.score(f, p)) !== 1) return false
    return true
  }, 1000), 'score 1 everywhere')

  await forum.vote(fc, p, 1) // changes their mind
  t.ok(await eventually(async () => {
    for (const f of all) if ((await forum.score(f, p)) !== 3) return false
    return true
  }, 1000), 'score 3 everywhere: one vote per member, the latest')
  t.is((await fa.count('vote', { on: p })).value, 3, 'three votes, not four')
})

test('a field passed as undefined counts as absent: old and new helpers share code; typos still throw', async (t) => {
  const { a } = await threeMembers(t)
  const f = a.spaces().length ? a.space(a.spaces()[0].key) : null
  // An older version's helper passing a field this version dropped from its
  // call, and a newer one passing a field this version doesn't have yet.
  const p = await f.put('post', { title: 'Hi', text: 'one', topic: 'rust', mood: undefined })
  t.is(p.topic, 'rust')
  const e = await f.edit(p.id, { text: 'two', topic: undefined, mood: undefined })
  t.is(e.text, 'two')
  t.is(e.topic, 'rust', 'undefined in an edit leaves the field as it was')
  const err = await f.put('post', { title: 'Hi', txet: 'typo' }).then(() => null, (x) => x)
  t.is(err && err.code, 'INVALID_RECORD', 'an unknown field with a value is a typo')
  t.ok(err && /txet/.test(err.message), 'named')
})

test('a vote indexed twice still counts (the 2026-11-06 soak)', async (t) => {
  const { fa, fb, all } = await threeMembers(t)
  const p = await forum.post(fa, 'P', '')
  t.ok(await eventually(async () => !!(await fb.get(p.id)).record, 5000))
  const v = await forum.vote(fb, p, 1)
  t.ok(await eventually(async () => (await forum.score(fa, p)) === 1, 5000), 'a has b\'s vote')
  await testing.indexAgain(fa, testing.ownLog(fb))
  t.is(await forum.score(fa, p), 1, 'still counts')
  t.ok((await fa.query('vote').latest(10)).items.some((r) => r.id === v.id), 'still listed')
  const w = await forum.vote(fb, p, -1) // b changes its mind: the earlier vote stays replaced
  t.ok(await eventually(async () => (await forum.score(fa, p)) === -1, 5000))
  await testing.indexAgain(fa, testing.ownLog(fb))
  t.is(await forum.score(fa, p), -1, 'the latest counts, indexed twice too')
  t.alike((await fa.query('vote').latest(10)).items.map((r) => r.id), [w.id])
  t.ok(all)
})

test('a block announced again while the indexer reads it is indexed once (the soak\'s cause)', async (t) => {
  const Hypercore = require('hypercore')
  const b4a = require('b4a')
  const { fa, fb } = await threeMembers(t)
  await forum.post(fb, 'first', '')
  t.ok(await eventually(async () => (await forum.latest(fa)).length === 1, 5000))
  const key = fb.own.key
  const seq = fb.own.core.length // b's next record
  const log = fa.directory.logs.get(b4a.toString(key, 'hex'))
  // On a: the block isn't held at first (a hole), and it is announced again
  // while the indexer reads it, as a member coming back online can.
  const get = Hypercore.prototype.get
  let calls = 0
  Hypercore.prototype.get = async function (i, opts) {
    if (!b4a.equals(this.key, key) || this.core === fb.own.core.core || i !== seq || !opts || opts.wait !== false) return get.call(this, i, opts)
    if (calls++ === 0) return null
    fa.indexer.arrived(log, seq)
    return get.call(this, i, opts)
  }
  t.teardown(() => { Hypercore.prototype.get = get })
  const before = testing.indexedBlocks(fa)
  await forum.post(fb, 'second', '')
  t.ok(await eventually(async () => (await forum.latest(fa)).length === 2, 5000))
  t.ok(calls >= 2, 'it was a hole, then read again')
  t.is(testing.indexedBlocks(fa) - before, 1, 'one block, indexed once')
})

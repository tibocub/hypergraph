// Core follow-ups, item 1 (constitution Principle I, research.md A12): a link
// field's allowed targets are judged when read, never when a record arrives.
// A record is kept whatever its links point at; a link whose target is held
// with a type the field doesn't allow counts for nothing (shown as null, not
// "on" the target) on every member, whatever the order of arrival. Before,
// a member that held the target first refused the record and one that got
// the record first kept it: a misbehaving member could make them disagree.

const test = require('brittle')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const enc = require('../../../lib/encodings.js')
const z32 = require('z32')
const { account, threeMembers } = require('./_setup.js')
const { eventually } = require('../helpers.js')

const ids = (xs) => xs.map((x) => x.id).sort().join()

// What a member shows around one target: everything that follows a link.
async function around (f, target) {
  return JSON.stringify({
    linked: ids((await f.linked(target, 'comment')).items),
    on: ids((await f.query('comment').on(target).latest(50)).items),
    count: (await f.count('comment', { on: target })).value,
    score: await forum.score(f, target),
    polls: ids(await forum.polls(f, target))
  })
}

test('a link to a disallowed type counts for nothing, in either order of arrival, on every member', async (t) => {
  const { a, fa, fb, fc } = await threeMembers(t)
  const p = await forum.post(fa, 'Post', '')
  const va = await forum.vote(fa, p, 1)
  t.ok(await eventually(async () => (await fc.get(va.id)).record, 10000), 'c holds a\'s vote')

  // c's app is modified. The target held first: a comment, a vote and a poll
  // "on" a's vote (comments, votes and polls go on posts or comments).
  const c1 = await testing.writeRaw(fc, { kind: 'put', type: 'comment', fields: { text: 'on a vote', on: va.id } })
  await testing.writeRaw(fc, { kind: 'put', type: 'vote', fields: { value: 5, on: va.id } })
  const bad = await testing.writeRaw(fc, { kind: 'put', type: 'poll', fields: { question: '?', on: va.id } })

  // The record first: a comment on the next block of c's own log, which c then
  // fills with a vote. Every member indexes the comment before its target.
  const own = z32.decode(testing.ownLog(fc))
  const next = (await fc.inspect()).logs.find((l) => l.own && l.key === testing.ownLog(fc)).length
  const ahead = enc.idToString({ log: own, seq: next + 1 })
  const c2 = await testing.writeRaw(fc, { kind: 'put', type: 'comment', fields: { text: 'on what comes next', on: ahead } })
  t.ok(await eventually(async () => (await fc.get(c2)).record, 5000))
  t.is((await fc.get(c2)).record.on, ahead, 'a target not held yet: the link counts as written')
  const vc = await testing.writeRaw(fc, { kind: 'put', type: 'vote', fields: { value: 1, on: p.id } })
  t.is(vc, ahead)

  const d = await account(t, 'd') // a newcomer, after all of it
  const fd = await forum.join(d, await forum.invite(fa))
  const members = [fa, fb, fc, fd]
  const settled = await eventually(async () => {
    for (const f of members) {
      const r1 = (await f.get(c1)).record
      const r2 = (await f.get(c2)).record
      if (!r1 || !r2 || (await f.get(vc)).record === null || (await f.get(bad)).record === null) return false
      if (!(await f.get(va.id)).record || (await forum.score(f, p)) !== 2) return false
    }
    return true
  }, 15000)
  t.ok(settled, 'every member keeps the records, whatever their links point at')

  for (const [name, f] of [['a', fa], ['b', fb], ['c', fc], ['newcomer', fd]]) {
    t.is((await f.get(c1)).record.on, null, `${name}: target held first, the link shows nothing`)
    t.is((await f.get(c2)).record.on, null, `${name}: record first, the link shows nothing once the target is here`)
    t.is((await f.get(bad)).record.on, null, `${name}: the poll too`)
    t.is(await around(f, va), JSON.stringify({ linked: '', on: '', count: 0, score: 0, polls: '' }), `${name}: nothing is on a's vote`)
    t.is(await around(f, { id: vc }), JSON.stringify({ linked: '', on: '', count: 0, score: 0, polls: '' }), `${name}: nothing is on c's vote`)
    t.is(await forum.score(f, p), 2, `${name}: the two votes on the post count`)
  }
  t.is(await around(fd, p), await around(fb, p), 'the newcomer shows the same post as b')

  // The target deleted (gone on every member, its type with it): the link
  // stands as written again, everywhere, newcomer included.
  await forum.remove(fa, va)
  const restored = await eventually(async () => {
    for (const f of members) {
      if ((await f.get(va.id)).record) return false
      if ((await f.get(c1)).record.on !== va.id) return false
      if (ids((await f.linked(va, 'comment')).items) !== c1) return false
    }
    return true
  }, 10000)
  t.ok(restored, 'a deleted target: the link counts as written on every member')
  t.is(await around(fa, va), await around(fd, va), 'a and the newcomer agree')
})

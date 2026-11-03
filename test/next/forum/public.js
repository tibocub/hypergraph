// A public forum (spec 016): the owner opens it to everyone, for good; people
// sign up with its one link while every admin is offline, post, show in the
// member list of whoever read them; a banned joiner stays out; a joiner who
// never wrote isn't listed, until its first post.

const test = require('brittle')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const { account } = require('./_setup.js')
const { eventually, codeOf } = require('../helpers.js')

const listed = async (f, hg) => (await forum.people(f)).some((p) => p.identity === hg.identity.publicKey)
const sees = (f, title) => async () => (await forum.latest(f)).some((p) => p.title === title)

// a owns it and opened it; b was invited before and stays online.
async function openForum (t) {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Everyone welcome')
  const fb = await forum.join(b, await forum.invite(fa))
  const link = await forum.openLink(fa, { perHour: 20 })
  t.ok(await eventually(() => fb.isPublic, 10000), 'b hears it is public')
  return { a, b, fa, fb, link }
}

test('sign up with every admin offline, post, show in the member list', async (t) => {
  const { a, fb, link } = await openForum(t)
  await a.close()
  const c = await account(t, 'c')
  const fc = await forum.join(c, link)
  await forum.post(fc, 'Hello', 'new here')
  t.ok(await eventually(sees(fb, 'Hello'), 15000), 'b reads the post')
  t.ok(await eventually(() => listed(fb, c), 5000), 'and lists c')
  const entry = (await forum.people(fb)).find((p) => p.identity === c.identity.publicKey)
  t.is(entry.role, 'member')
  t.is(entry.devices.length, 1)
})

test('a joiner who never wrote isn\'t listed, then is after its first post', async (t) => {
  const { fa, fb, link } = await openForum(t)
  const c = await account(t, 'c')
  const fc = await forum.join(c, link)
  const d = await account(t, 'd') // writes, so we know c's silence had time to reach
  const fd = await forum.join(d, link)
  await forum.post(fd, 'From d', '')
  t.ok(await eventually(sees(fb, 'From d'), 15000))
  t.absent(await listed(fb, c), 'c is not listed by b')
  t.absent(await listed(fa, c), 'nor by a')
  t.absent(testing.logs(fb).includes(testing.ownLog(fc)), 'b never got its log')
  await forum.post(fc, 'Finally', '')
  t.ok(await eventually(() => listed(fb, c), 15000), 'listed after its first post')
  t.ok(await eventually(sees(fa, 'Finally'), 15000))
})

test('ban a public joiner: its posts stop counting; making the forum private again is refused', async (t) => {
  const { fa, fb, link } = await openForum(t)
  const c = await account(t, 'c')
  const fc = await forum.join(c, link)
  await forum.post(fc, 'Spam', 'buy now')
  t.ok(await eventually(sees(fb, 'Spam'), 15000))
  await forum.ban(fa, c.identity.publicKey, { reason: 'spam', dropAll: true })
  t.ok(await eventually(async () => !(await sees(fb, 'Spam')()), 15000), 'gone for b')
  const entry = (await forum.people(fa)).find((p) => p.identity === c.identity.publicKey)
  t.ok(entry && entry.banned, 'listed as banned')
  t.is(await codeOf(forum.post(fc, 'More', '')), 'NOT_ALLOWED', 'c can\'t post')
  t.is(await codeOf(fa.revokeInvite(link)), 'NOT_ALLOWED', 'the door can\'t be closed')
  t.ok(fa.isPublic, 'still public')
  t.is(await codeOf(forum.removeMember(fa, (await account(t, 'e')).identity.publicKey)), 'NOT_ALLOWED', 'a public joiner is banned, not removed')
})

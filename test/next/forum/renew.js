// Spec 027 in the forum: after a troll is banned, the owner secures the forum;
// members carry on where they were (links and bookmarks follow), the troll is
// left behind; an old forum keeps its last months only.

const test = require('brittle')
const forum = require('./forum.js')
const { account } = require('./_setup.js')
const { eventually, codeOf } = require('../helpers.js')

const titles = async (f) => (await forum.latest(f, 50)).map((p) => p.title)

test('ban a troll, secure the forum: members follow, the troll is left behind', { timeout: 180000 }, async (t) => {
  const owner = await account(t, 'owner')
  const member = await account(t, 'member')
  const troll = await account(t, 'troll')
  const club = await forum.createForum(owner, 'Book club', { private: true })
  const onMember = await forum.join(member, await forum.invite(club))
  const onTroll = await forum.join(troll, await forum.invite(club))
  const first = await forum.post(onMember, 'Dune, chapter 1', 'thoughts')
  await forum.bookmark(member, onMember)
  await forum.post(onTroll, 'spam', '')
  await forum.ban(club, troll.identity.publicKey, { reason: 'spam' })

  const secured = await forum.secure(club)
  t.ok((await titles(secured)).includes('Dune, chapter 1'), 'the history is there')
  const here = await eventually(() => { const f = member.space(club.key); return f.key === secured.key ? f : null }, 40000)
  t.ok(here, 'the member\'s link leads to the secured forum')
  t.ok(await eventually(() => forum.bookmarks(member).includes(secured.key), 20000), 'and the bookmark')
  t.ok(await eventually(async () => (await titles(here)).includes('Dune, chapter 1'), 30000), 'the member reads the history')
  await forum.comment(here, first, 'still here')
  t.ok(await eventually(async () => (await forum.comments(secured, first)).length === 1, 30000), 'comments on an old post work')

  const left = troll.space(club.key)
  t.ok(await eventually(() => left.moved, 30000), 'the troll sees it moved')
  t.is(left.movedTo, null, 'not where')
  t.is(await codeOf(forum.post(left, 'more spam', '')), 'MOVED', 'and can\'t write there any more')
})

test('keep the last days only: older posts go everywhere', { timeout: 120000 }, async (t) => {
  const owner = await account(t, 'owner')
  const member = await account(t, 'member')
  const f = await forum.createForum(owner, 'Old forum')
  const onMember = await forum.join(member, await forum.invite(f))
  await forum.post(f, 'ancient', '')
  t.ok(await eventually(async () => (await titles(onMember)).includes('ancient'), 20000))
  t.is(await codeOf(forum.trimHistory(onMember, 0)), 'NOT_ALLOWED', 'a member may not')
  await forum.trimHistory(f, -1) // everything up to tomorrow
  await forum.post(f, 'fresh', '')
  t.ok(await eventually(async () => JSON.stringify(await titles(onMember)) === '["fresh"]', 20000), 'the member keeps the new posts only')
})

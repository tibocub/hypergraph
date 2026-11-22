// Renewing, in the forum: after a troll is banned, the owner secures the forum;
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

test('securing a forum that hides its history: members read its history and go on with new keys; a newcomer reads from its join on', { timeout: 180000 }, async (t) => {
  const owner = await account(t, 'owner')
  const member = await account(t, 'member')
  const club = await forum.createForum(owner, 'Book club', { private: true })
  await club.setHistory('hidden')
  const onMember = await forum.join(member, await forum.invite(club))
  await forum.post(onMember, 'old', '')
  t.ok(await eventually(async () => (await titles(club)).includes('old'), 15000), 'the owner reads it')

  const secured = await forum.secure(club)
  t.is(secured.history, 'hidden', 'still hiding its history')
  const here = await eventually(() => { const f = member.space(club.key); return f.key === secured.key ? f : null }, 40000)
  t.ok(await eventually(async () => (await titles(here)).includes('old'), 30000), 'the member reads the old posts, with the old space\'s chains')
  const fresh = await eventually(async () => {
    try { return await forum.post(here, 'new', '') } catch { return null }
  }, 30000)
  t.ok(fresh, 'and writes with the new space\'s keys')
  t.ok(await eventually(async () => (await titles(secured)).includes('new'), 30000), 'which the owner reads')
  const newcomer = await account(t, 'newcomer')
  const onNew = await forum.join(newcomer, await forum.invite(secured))
  t.ok(await eventually(() => onNew.status().access === 'full', 30000), 'its key came') // it reads from here on
  const later = await forum.post(secured, 'after the newcomer', '')
  t.ok(await eventually(async () => (await forum.latest(onNew, 50)).some((p) => p.id === later.id), 30000), 'the newcomer reads what came after it')
  t.alike(await titles(onNew), ['after the newcomer'], 'and no history')
})

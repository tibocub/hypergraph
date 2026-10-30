// Story 4 #1-4: invites and joining. A link works while its maker is
// offline, as long as someone able to let people in is online; a link that
// is expired, used up, revoked, or made by someone who can't give its role is
// refused with that reason, within the read bound; a public link lets many in
// until it is revoked.

const test = require('brittle')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const { account } = require('./_setup.js')
const { eventually, codeOf, open } = require('../helpers.js')

const BOUND = 5000 // the forum's read bound (the default)

// How long `promise` takes to settle, and its error code (null if it resolves).
async function timed (promise) {
  const started = Date.now()
  const code = await codeOf(promise)
  return { code, ms: Date.now() - started }
}

// a owns the forum; b is an admin.
async function forumWithAdmin (t) {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Invites')
  const fb = await forum.join(b, await forum.invite(fa))
  await forum.giveRole(fa, b.identity.publicKey, 'admin')
  t.ok(await eventually(async () => (await forum.roleOf(fb, b.identity.publicKey)) === 'admin', 10000))
  return { a, b, fa, fb }
}

test('a link works while its maker is offline, if another admin is online', async (t) => {
  const { b, fa, fb } = await forumWithAdmin(t)
  const link = await forum.invite(fb)
  await b.close()
  const c = await account(t, 'c')
  const fc = await forum.join(c, link)
  t.is(await forum.roleOf(fc, c.identity.publicKey), 'member', 'c is a member, let in by a')
  await forum.post(fc, 'Hi all', '')
  t.ok(await eventually(async () => (await forum.latest(fa)).some((p) => p.title === 'Hi all'), 10000), 'and posts')
  t.alike((await forum.whoJoined(fa, link)).map((r) => r.identity), [c.identity.publicKey], 'a sees who used the link')
})

test('expired, used up, revoked: refused with the reason, within the read bound', async (t) => {
  const { fa } = await forumWithAdmin(t)

  const soon = await fa.createInvite({ expires: Date.now() + 300 })
  await new Promise((resolve) => setTimeout(resolve, 400))
  let r = await timed(forum.join(await account(t, 'late'), soon))
  t.is(r.code, 'INVITE_EXPIRED', 'expired')

  const once = await forum.invite(fa)
  await forum.join(await account(t, 'first'), once)
  r = await timed(forum.join(await account(t, 'second'), once))
  t.is(r.code, 'INVITE_USED_UP', 'used up')
  t.ok(r.ms < BOUND + 1000, `within the bound (${r.ms} ms)`)

  const revoked = await forum.openLink(fa)
  await forum.revokeLink(fa, revoked)
  r = await timed(forum.join(await account(t, 'too late'), revoked))
  t.is(r.code, 'INVITE_REVOKED', 'revoked')
  t.ok(r.ms < BOUND + 1000, `within the bound (${r.ms} ms)`)
})

test('an inviter whose role can\'t give the role is refused', async (t) => {
  const { a, fa } = await forumWithAdmin(t)
  const m = await account(t, 'm')
  const fm = await forum.join(m, await forum.invite(fa))
  t.is(await codeOf(forum.invite(fm)), 'NOT_ALLOWED', 'a member can\'t invite')
  t.is(await codeOf(fa.createInvite({ role: 'owner' })), 'NOT_ALLOWED', 'nobody invites an owner')
  t.is(await codeOf(fa.createInvite({ role: 'nope' })), 'NOT_FOUND', 'nor to a role that does not exist')

  const anyway = testing.inviteAnyway(fm, { role: 'admin' }) // made by m's app, skipping its checks
  const r = await timed(forum.join(await account(t, 'n'), anyway))
  t.is(r.code, 'NOT_ALLOWED', 'a link made anyway is refused')
  t.ok(r.ms < BOUND + 1000, `within the bound (${r.ms} ms)`)
  t.ok(a)
})

test('a public link lets many in; revoked, it lets no one else in and members stay', async (t) => {
  const { fa, fb } = await forumWithAdmin(t)
  const link = await forum.openLink(fb)
  const joined = []
  for (const name of ['p1', 'p2', 'p3']) {
    const hg = await account(t, name)
    joined.push({ hg, f: await forum.join(hg, link) })
  }
  t.is((await forum.whoJoined(fa, link)).length, 3, 'three people joined with it')
  await forum.revokeLink(fa, link)
  t.is(await codeOf(forum.join(await account(t, 'p4'), link)), 'INVITE_REVOKED', 'revoked: no one else')
  for (const { hg, f } of joined) t.is(await forum.roleOf(f, hg.identity.publicKey), 'member', 'who joined stays')
})

test('nobody able to let you in is online: INVITE_INVALID after the bound, or the timeout given', async (t) => {
  const a = await account(t, 'a')
  const fa = await forum.createForum(a, 'Quiet')
  const link = await forum.invite(fa)
  await a.close()
  const c = await account(t, 'c')
  const r = await timed(forum.join(c, link, { timeout: 1500 }))
  t.is(r.code, 'INVITE_INVALID')
  t.ok(r.ms >= 1500 && r.ms < 4000, `after the timeout given (${r.ms} ms)`)
  t.is(c.spaces().length, 0, 'the space is not kept')
})

test('joining waits (30 s by default), though reads do not: the inviter comes online 2 s later', async (t) => {
  const a = await account(t, 'a')
  const fa = await forum.createForum(a, 'Patient')
  const link = await forum.invite(fa)
  await a.close()
  const n = await open(t, { types: forum.types, rules: forum.rules })
  const joining = forum.join(n, link)
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const a2 = await open(t, { dir: a.dir, types: forum.types, rules: forum.rules })
  await a2.connectToSwarm()
  const fn = await joining
  t.is(await forum.roleOf(fn, n.identity.publicKey), 'member', 'let in, 2 s later')
})

test('friends invite friends, who invite theirs; none of them can invite a moderator (F6)', async (t) => {
  const a = await account(t, 'a')
  const fa = await forum.createForum(a, 'Friends')
  let inviter = fa
  const friends = []
  for (const name of ['b', 'c', 'd']) {
    const hg = await account(t, name)
    const f = await forum.join(hg, await forum.inviteFriend(inviter))
    t.is(await forum.roleOf(f, hg.identity.publicKey), 'friend', `${name} is a friend, invited by the previous one`)
    friends.push(f)
    inviter = f
  }
  const p = await forum.post(friends[2], 'Hi', 'from the friend of a friend of a friend')
  t.ok(await eventually(async () => (await forum.latest(fa)).some((x) => x.id === p.id), 10000), 'and posts')
  t.is(await codeOf(friends[2].createInvite({ role: 'moderator' })), 'NOT_ALLOWED', 'a friend can\'t invite a moderator')
  t.is(await codeOf(friends[2].createInvite({ role: 'admin' })), 'NOT_ALLOWED', 'nor an admin')
})

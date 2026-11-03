// Public spaces (spec 016, US1-US2): made public once by an owner or admin,
// joined with the space's one link with no decision and no decider online;
// bans still keep people out; members() lists the joiners met.

const test = require('brittle')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { account } = require('../forum/_setup.js')
const { eventually, codeOf } = require('../helpers.js')

const count = async (f) => (await f.decisions({ limit: 1000 })).items.length
const has = (f, title) => async () => (await forum.latest(f)).some((p) => p.title === title)

// a owns a public forum, b is a member (invited before it went public).
async function publicForum (t) {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Open')
  const fb = await forum.join(b, await forum.invite(fa))
  await fa.makePublic()
  t.ok(fa.isPublic, 'public for the owner at once')
  t.ok(await eventually(() => fb.isPublic, 10000), 'and for b once it hears')
  return { a, b, fa, fb }
}

test('a newcomer joins a public space with every decider offline, and posts', { timeout: 90000 }, async (t) => {
  const { a, b, fa, fb } = await publicForum(t)
  const link = fa.publicLink()
  t.is(fb.publicLink(), link, 'the same link on every member')
  await a.close()
  const before = await count(fb)
  const c = await account(t, 'c')
  const fc = await c.redeemInvite(link, { timeout: 15000 })
  t.ok(fc.isPublic)
  t.is(await fc.getRole(c.identity.publicKey), 'member', 'a member at once')
  await forum.post(fc, 'Hello from c', '')
  t.ok(await eventually(has(fb, 'Hello from c'), 15000), 'b reads it')
  t.is(await count(fb), before, 'nothing added to the decision log')
  t.ok(c.spaces().some((s) => s.key === fb.key), 'kept by c')
  t.ok(b)
})

test('a link of a space that isn\'t public: INVITE_INVALID; nobody reachable: the timeout', { timeout: 90000 }, async (t) => {
  const a = await account(t, 'a')
  const fa = await forum.createForum(a, 'Closed')
  const { publicLink } = require('../../../lib/invites.js')
  const link = publicLink(fa.keyBytes)
  t.is(await codeOf(Promise.resolve().then(() => fa.publicLink())), 'NOT_ALLOWED', 'no public link before it is public')
  const c = await account(t, 'c')
  let err = null
  try { await c.redeemInvite(link, { timeout: 15000 }) } catch (e) { err = e }
  t.is(err && err.code, 'INVITE_INVALID')
  t.ok(err && /isn't public/.test(err.message), err && err.message)
  t.is(c.spaces().length, 0, 'not kept')
  await fa.makePublic()
  await a.close()
  const d = await account(t, 'd')
  const started = Date.now()
  err = null
  try { await d.redeemInvite(link, { timeout: 1500 }) } catch (e) { err = e }
  t.is(err && err.code, 'INVITE_INVALID')
  t.ok(Date.now() - started >= 1500, 'after the timeout given')
  t.is(d.spaces().length, 0, 'not kept')
})

test('bans hold, removed members come back in a new log, the door can\'t close', { timeout: 120000 }, async (t) => {
  const { a, b, fa, fb } = await publicForum(t)
  const link = fa.publicLink()
  t.is(await codeOf(fb.makePublic()), 'NOT_ALLOWED', 'a member can\'t make it public')
  t.is(await codeOf(fa.revokeInvite(link)), 'NOT_ALLOWED', 'the public link can\'t be revoked')
  t.is(await codeOf(testing.decide(fa, { type: 'settings/set', stamp: Date.now(), policy: null, writeLimit: null, rules: null, public: false }).then(() => fa.isPublic ? null : 'closed')), null, 'a forged "not public" changes nothing')
  t.ok(fa.isPublic)

  const c = await account(t, 'c')
  const fc = await c.redeemInvite(link, { timeout: 15000 })
  await forum.post(fc, 'First', '')
  t.ok(await eventually(has(fa, 'First'), 15000))
  await forum.ban(fa, c.identity.publicKey, { reason: 'spam' })
  t.is(await fa.getRole(c.identity.publicKey), null, 'banned: no role')
  t.ok(await eventually(async () => (await fc.getRole(c.identity.publicKey)) === null, 15000), 'c hears it')
  const fresh = await testing.prepareLog(fc, { fields: { title: 'Again', text: '' } })
  await new Promise((resolve) => setTimeout(resolve, 2000))
  fresh.announce()
  await new Promise((resolve) => setTimeout(resolve, 2000))
  t.absent(await has(fa)('Again'), 'a banned identity\'s new log counts for nothing')
  t.absent(testing.logs(fa).includes(fresh.log), 'and isn\'t kept')

  await forum.removeMember(fa, b.identity.publicKey)
  const settled = testing.settled(fa) // b's copy may be reordered meanwhile: wait for it to settle there too
  t.ok(await eventually(() => testing.settled(fb) >= settled && !fb.state.isRecorded(b.identity.publicKey), 15000), 'b hears it is removed')
  t.is(await fb.getRole(b.identity.publicKey), 'member', 'and is a public member again')
  await forum.post(fb, 'Back', '')
  t.ok(await eventually(has(fa, 'Back'), 15000), 'b writes in a new log that counts')
  const mb = (await fa.members()).find((m) => m.identity === b.identity.publicKey)
  t.is(mb.role, 'member', 'listed as a member')
  t.is(mb.removed, false, 'not as removed: a public space let it back in')
  t.ok(a)
})

test('a space from before keeps its recorded members when made public', { timeout: 90000 }, async (t) => {
  const { fa, fb, b } = await publicForum(t)
  const m = await fa.members()
  t.alike(m.map((x) => x.role), ['owner', 'member'])
  t.is(await fa.getRole(b.identity.publicKey), 'member')
  t.ok(fb)
})

test('members() lists a public joiner once read, with its device; \'members\' fires', { timeout: 90000 }, async (t) => {
  const { a, fa, fb } = await publicForum(t)
  const link = fa.publicLink()
  const seen = []
  fb.on('members', () => seen.push(Date.now()))
  const c = await account(t, 'c')
  const fc = await c.redeemInvite(link, { timeout: 15000 })
  const cid = c.identity.publicKey
  t.absent((await fb.members()).some((m) => m.identity === cid), 'not listed before it writes')
  await forum.post(fc, 'Hi', '')
  t.ok(await eventually(async () => (await fb.members()).some((m) => m.identity === cid), 15000), 'listed once read')
  const list = await fb.members()
  const entry = list.find((m) => m.identity === cid)
  t.is(entry.role, 'member')
  t.is(entry.you, false)
  t.is(entry.devices.length, 1, 'with its device')
  t.is(entry.devices[0].device, c.device.publicKey)
  t.is(list[0].role, 'owner', 'highest role first')
  t.ok(seen.length > 0, '\'members\' fired')
  const mine = (await fc.members()).find((m) => m.identity === cid)
  t.ok(mine && mine.you, 'c lists itself')
  t.alike((await fb.redemptions(link)).map((r) => r.identity), [cid], 'redemptions of the public link: the joiners met')
  t.is((await fb.redemptions(link))[0].at, null)
  t.ok(a)
})

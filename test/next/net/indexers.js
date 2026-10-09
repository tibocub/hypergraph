// Admins settle the decision order with the owner (story 4, research.md A8;
// v1 spec 003's lesson: with a sole settler, an unsettled tail grows for
// good once it is gone). One device per member with `decide` is an Autobase
// indexer; settling needs most of them online.

const test = require('brittle')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { account } = require('../forum/_setup.js')
const { eventually } = require('../helpers.js')

// a owns the forum; b and c are admins; m is a member.
async function admins (t) {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const c = await account(t, 'c')
  const m = await account(t, 'm')
  const fa = await forum.createForum(a, 'Outlives its owner')
  const fb = await forum.join(b, await forum.invite(fa))
  const fc = await forum.join(c, await forum.invite(fa))
  const fm = await forum.join(m, await forum.invite(fa))
  await forum.giveRole(fa, b.identity.publicKey, 'admin')
  await forum.giveRole(fa, c.identity.publicKey, 'admin')
  const settlers = [fa, fb, fc].map((f) => testing.ownSettlerKey(f)).sort().join()
  t.ok(await eventually(() => [fa, fb, fc, fm].every((f) => testing.settlers(f).sort().join() === settlers), 15000), 'the owner and both admins settle, as every member sees it')
  return { a, b, c, m, fa, fb, fc, fm }
}

test('the owner gone for good, two admins still settle new decisions', async (t) => {
  const { a, b, c, m, fb, fc, fm } = await admins(t)
  await a.close()

  const before = [testing.settled(fb), testing.settled(fc)]
  await forum.addRole(fb, 'helper', ['post'])
  await forum.giveRole(fc, m.identity.publicKey, 'moderator')
  const d = await account(t, 'd')
  const fd = await forum.join(d, await forum.invite(fb))
  const e = await account(t, 'e')
  const fe = await forum.join(e, await forum.invite(fc))
  await forum.ban(fb, e.identity.publicKey, { reason: 'test' })

  t.ok(await eventually(() => testing.settled(fb) > before[0] && testing.settled(fc) > before[1] &&
    testing.settled(fb) === testing.settled(fc), 20000), 'both admins settle what was decided without the owner')

  const roles = async (f) => (await Promise.all([m, d, e].map((x) => forum.roleOf(f, x.identity.publicKey)))).map(String).join()
  const expected = 'moderator,member,null'
  t.ok(await eventually(async () => (await roles(fb)) === expected && (await roles(fc)) === expected && (await roles(fm)) === expected && (await roles(fd)) === expected, 10000), 'every member applies them the same way')
  const n = await account(t, 'newcomer')
  const fn = await forum.join(n, await forum.invite(fc))
  t.ok(await eventually(async () => (await roles(fn)) === expected, 10000), 'a newcomer too')
  t.ok(fe && b && c)
})

test('an admin demoted to moderator stops settling, and still moderates', async (t) => {
  const { b, fa, fb, fc, fm } = await admins(t)
  await forum.giveRole(fa, b.identity.publicKey, 'moderator')
  const settlers = [fa, fc].map((f) => testing.ownSettlerKey(f)).sort().join()
  t.ok(await eventually(() => [fa, fb, fc, fm].every((f) => testing.settlers(f).sort().join() === settlers), 15000), 'b no longer settles')
  const p = await forum.post(fm, 'hello', '')
  t.ok(await eventually(async () => (await fb.get(p.id)).record, 10000))
  await forum.hide(fb, p, 'test')
  t.ok(await eventually(async () => (await forum.latest(fa)).length === 0, 10000), 'b\'s hide counts')
})

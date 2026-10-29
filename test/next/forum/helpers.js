// Spec 013: a forum kept by a helper. The owner adds the forum's helper (a VPS
// running blind-peer-cli) once; members see who keeps it; a friend who was
// away reads what was posted while nobody else was online.

const test = require('brittle')
const forum = require('./forum.js')
const { account } = require('./_setup.js')
const { helper, heldBy } = require('../net/_helper.js')
const { eventually } = require('../helpers.js')

test('a friend who was away reads posts through the forum\'s helper', { timeout: 120000 }, async (t) => {
  const vps = await helper(t)
  const ann = await account(t, 'ann')
  const bob = await account(t, 'bob')
  const fa = await forum.createForum(ann, 'Friends')
  await forum.setHelpers(fa, [vps.key])
  t.alike(forum.helpers(fa), [vps.key], 'the owner sees the helper')

  const fb = await forum.join(bob, await forum.invite(fa))
  t.ok(await eventually(() => forum.helpers(fb).length === 1, 10000), 'a member sees "kept by"')
  t.is(forum.helpers(fb)[0], vps.key)
  await bob.close()

  await forum.post(fa, 'posted at night', 'everyone was asleep')
  t.ok(await eventually(() => heldBy(vps, fa), 20000), 'the helper holds the forum')
  await ann.close()

  const bob2 = await account(t, 'bob2', { dir: bob.dir })
  const fb2 = bob2.space(fa.key)
  const got = await eventually(async () => (await forum.latest(fb2)).find((p) => p.title === 'posted at night'), 30000)
  t.ok(got, 'bob reads it with only the helper online')
})

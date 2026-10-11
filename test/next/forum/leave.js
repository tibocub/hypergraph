// Leaving a forum on one device (hg.leaveSpace): its data goes from this
// device, sub-forums included; it isn't opened again here (though the
// account's personal space still lists it), until joined again. The others
// keep everything, the leaver's posts included.

const test = require('brittle')
const b4a = require('b4a')
const forum = require('./forum.js')
const { account, threeMembers } = require('./_setup.js')
const { eventually, codeOf, bounded } = require('../helpers.js')

test('leave a forum: its data goes from this device; joining again brings it back', { timeout: 90000 }, async (t) => {
  const { b, fa, fb } = await threeMembers(t)
  await forum.createSubforum(fa, 'off topic')
  const mine = await forum.post(fb, 'from b', 'before leaving')
  const theirs = await forum.post(fa, 'from a', '')
  t.ok(await eventually(async () => !!(await fb.get(theirs.id)).record && forum.subforums(fb).length === 1 && b.spaces().length === 2, 10000), 'b holds the forum and its sub-forum')
  const key = fb.key
  const ofForum = async () => (await b.db.find('@hg/records', {}).toArray()).filter((r) => b4a.equals(r.space, fa.keyBytes)).length
  t.ok(await ofForum() > 0, 'b\'s index holds the forum\'s records')

  await b.leaveSpace(key)
  t.alike(b.spaces(), [], 'b holds neither the forum nor its sub-forum')
  t.is(await codeOf(Promise.resolve().then(() => b.space(key))), 'NOT_FOUND')
  t.is(await ofForum(), 0, 'and none any more')
  const core = b.store.get({ key: fa.own.key })
  await core.ready()
  t.absent(await core.has(1), 'a\'s posts are gone from b\'s device')
  await core.close()
  t.is(await codeOf(b.leaveSpace(key)), 'NOT_FOUND', 'leaving twice: nothing to leave')

  t.ok((await fa.get(mine.id)).record, 'a still has b\'s post')

  // reopened: not opened again from the personal space's list
  const dir = b.dir
  await bounded(b.close(), 10000, 'b.close()')
  const b2 = await account(t, 'b again', { dir })
  t.alike(b2.spaces(), [], 'not opened again when b opens the app')

  const back = await forum.join(b2, await forum.invite(fa))
  t.ok(await eventually(async () => !!(await back.get(theirs.id)).record, 10000), 'joining again brings it back')
})

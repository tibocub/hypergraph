// Let back in after a ban (story 4's gap, closed in story 9; research.md A14):
// a modified app could prepare a new log during the ban, which no cut names;
// it counts for nobody, because a log made after a cut must carry the code of
// the decision that let its author back in. The app's own new log does.

const test = require('brittle')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const { account, threeMembers } = require('./_setup.js')
const { eventually, sleep } = require('../helpers.js')

const titles = async (f) => (await forum.latest(f, 50)).map((p) => p.title).sort()

test('a log prepared during a ban counts for nobody once its author is let back in', async (t) => {
  const { b, fa, fb, fc } = await threeMembers(t)
  await forum.post(fb, 'before the ban', '')
  t.ok(await eventually(async () => (await titles(fa)).includes('before the ban'), 3000))
  await forum.ban(fa, b.identity.publicKey, { reason: 'spam' })
  t.ok(await eventually(async () => (await forum.roleOf(fb, b.identity.publicKey)) === null, 5000), 'b knows it is out')
  const prepared = await testing.prepareLog(fb, { fields: { title: 'prepared during the ban', text: '' } })

  await forum.unban(fa, b.identity.publicKey)
  await forum.giveRole(fa, b.identity.publicKey, 'member')
  t.ok(await eventually(async () => (await forum.roleOf(fb, b.identity.publicKey)) === 'member', 5000), 'b is let back in')
  const after = await forum.post(fb, 'after being let back in', '')
  t.not(testing.ownLog(fb), prepared.log, 'b\'s app writes in a new log, not the prepared one')
  prepared.announce()
  for (const f of [fa, fc]) t.ok(await eventually(async () => (await forum.latest(f)).some((p) => p.id === after.id), 5000), 'its new post counts')
  await sleep(1000) // time for the prepared log to be offered and refused
  for (const f of [fa, fc]) {
    t.absent((await titles(f)).includes('prepared during the ban'), 'the prepared log counts for nobody')
    t.absent(testing.logs(f).includes(prepared.log), 'and is not kept')
  }
  const d = await account(t, 'd')
  const fd = await forum.join(d, await forum.invite(fa))
  t.ok(await eventually(async () => (await titles(fd)).includes('after being let back in'), 5000))
  t.alike(await titles(fd), await titles(fa), 'a newcomer counts the same')
})

// A silent member costs nothing (spec 016, US3, research R4): no log of a
// member is announced before its first record, invited or public; then it is,
// and the record arrives. A private space still accepts it at join (key
// holders grant the devices they see).

const test = require('brittle')
const b4a = require('b4a')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { account } = require('../forum/_setup.js')
const { eventually, sleep } = require('../helpers.js')

const holds = (f, log) => testing.logs(f).includes(log)

test('invited and public members who never wrote reach nobody\'s directory; their first record does', { timeout: 90000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const c = await account(t, 'c')
  const fa = await forum.createForum(a, 'Quiet')
  const fb = await forum.join(b, await forum.invite(fa))
  const link = await forum.openLink(fa)
  const fc = await forum.join(c, link)
  await forum.post(fa, 'From a', '') // the owner writes: b and c get it, so they were in touch
  for (const f of [fb, fc]) t.ok(await eventually(async () => (await forum.latest(f)).length === 1, 15000))
  await sleep(1000)
  for (const silent of [fb, fc]) {
    const log = testing.ownLog(silent)
    t.absent(holds(fa, log), 'not in the owner\'s directory')
    t.absent(holds(silent === fb ? fc : fb, log), 'nor in the other member\'s')
    t.absent(silent.directory.logs.has(b4a.toString(silent.own.key, 'hex')), 'nor accepted by its own app')
  }
  await forum.post(fb, 'From b', '')
  await forum.post(fc, 'From c', '')
  for (const f of [fa, fb, fc]) t.ok(await eventually(async () => (await forum.latest(f)).length === 3, 15000), 'first records arrive')
  t.ok(holds(fa, testing.ownLog(fb)) && holds(fa, testing.ownLog(fc)), 'and their logs are known')
})

test('in a private space a member\'s log is accepted at join, so it gets the key', { timeout: 90000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Secret', { private: true })
  const fb = await forum.join(b, await forum.invite(fa))
  t.ok(fb.directory.logs.has(b4a.toString(fb.own.key, 'hex')), 'accepted at join')
  await forum.post(fa, 'Sealed', '')
  t.ok(await eventually(async () => (await forum.latest(fb)).some((p) => p.title === 'Sealed'), 20000), 'b was granted the key and reads')
})

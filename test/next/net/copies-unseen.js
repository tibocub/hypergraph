// A fixed number of copies, over time: a holder unseen 7 days replaced, and
// told to delete when seen again; hours seen per holder; no holder in any circle.
// (The first part: copies.js.)

const test = require('brittle')
const z32 = require('z32')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { account } = require('../forum/_setup.js')
const { eventually, sleep } = require('../helpers.js')
const { holdsAll, heldBy, circleOf, keptByExactly } = require('./_circles.js')

const DAY = 24 * 3600 * 1000

test('a holder unseen 7 days (this device online a day of them) is replaced, and deletes when seen again', { timeout: 300000 }, async (t) => {
  const { a, holders } = await circleOf(t, 6)
  const s = await forum.createForum(a, 'S', { private: true })
  await forum.post(s, 'hi', '')
  t.ok(await keptByExactly(holders, s, 5))
  const regular = await heldBy(holders, s)
  const gone = regular[0]
  const spare = holders.find((h) => !regular.includes(h))
  const dir = gone.dir
  await gone.close()
  await sleep(2000)
  t.absent(await holdsAll(spare, s), 'not replaced at once')

  testing.holdingClock(a, 10 * DAY) // a off for 10 days (its own hours none), back for minutes
  await a._circles.update()
  await sleep(3000)
  t.is(a._circles.replaced.size, 0, 'back after 10 days off: nobody replaced yet')
  t.absent(await holdsAll(spare, s))

  testing.holdingClock(a, 10 * DAY, { online: 25 }) // then online a day
  await a._circles.update()
  t.ok(await eventually(() => holdsAll(spare, s), 60000), 'replaced by the next ranked')
  const again = await account(t, 'again', { dir })
  t.ok(await eventually(async () => !(await holdsAll(again, s)), 60000), 'seen again: it deleted it')
  t.ok(await holdsAll(spare, s), 'the replacement keeps it')
  t.ok(await eventually(() => a.copiesOf(s.key).kept === 5, 20000))
})

test('online numbers: hours seen per holder, kept on the device; a holder reports its own share at most once a day', { timeout: 120000 }, async (t) => {
  const { a, circle, holders: [b] } = await circleOf(t, 1)
  const dev = b._identity.device.publicKey.toString('hex')
  await a._circles.update()
  t.ok(await eventually(() => (a._circles.hours.get(dev) || new Set()).size === 1, 20000), 'a saw b online this hour')
  const own = b._circles.hours.get(dev)
  const H = 3600 * 1000
  for (let i = 1; i < 360; i++) own.add(Math.floor((Date.now() - i * H) / H)) // online half of the last 30 days
  await b._circles.update()
  const record = async () => {
    const items = (await circle.query('hg/holder').latest(100)).items
    return items.find((r) => r.device === z32.encode(b._identity.device.publicKey))
  }
  t.ok(await eventually(async () => (await record() || {}).online === 50, 20000), 'b reports 50%')
  for (let i = 360; i < 720; i++) own.add(Math.floor((Date.now() - i * H) / H))
  await b._circles.update()
  await sleep(2000)
  t.is((await record()).online, 50, 'not again the same day')
  testing.holdingClock(b, 25 * H)
  await b._circles.update()
  t.ok(await eventually(async () => (await record()).online > 90, 20000), 'a day later, the new share')

  await b.leaveSpace(circle.key)
  t.ok(await eventually(async () => { await a._circles.update(); return !a._circles.hours.has(dev) }, 20000), 'deleted with the circle')
})

test('in no circle with a holder: nothing handed, no closed space opened for it', { timeout: 60000 }, async (t) => {
  const a = await account(t, 'a', { idleMs: 500, maxAnnounced: 1 })
  await a.createCircle({ name: 'Alone' }) // a circle nobody else holds in (it stays open: the one announced)
  const old = await forum.createForum(a, 'Old')
  await forum.post(old, 'hi', '')
  const opened = () => a.spaces().find((s) => s.key === old.key).opened
  t.ok(await eventually(() => !opened(), 15000), 'closed when idle')
  await a._circles.update()
  t.absent(opened(), 'not opened to list its cores')
  t.is(a._circles.peering, null, 'no blind-peering client')
  t.alike(a.copiesOf(old.key), { wanted: 0, kept: 0, online: 0 })
})

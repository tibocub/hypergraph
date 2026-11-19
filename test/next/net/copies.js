// A fixed number of copies. A member's space is kept by 5 holders
// in all (split across its circles, ranked by a hash, one device per
// person), the next ranked taking over when one leaves; an extra copy while
// none is online; a holder unseen 7 days replaced, and told to delete when
// seen again; hg.copiesOf() for "kept by N of 5 copies".

const test = require('brittle')
const z32 = require('z32')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { account } = require('../forum/_setup.js')
const { eventually, sleep } = require('../helpers.js')
const { holdsAll, heldBy } = require('./_circles.js')

const DAY = 24 * 3600 * 1000

async function circleOf (t, n, { name = 'C', a = null, prefix = 'h' } = {}) {
  a = a || await account(t, 'a')
  const circle = await a.createCircle({ name })
  const holders = []
  for (let i = 0; i < n; i++) {
    const h = await account(t, prefix + i)
    await forum.join(h, await circle.createInvite())
    await h.setHolding({ on: true })
    holders.push(h)
  }
  return { a, circle, holders }
}

async function keptByExactly (hgs, space, n, ms = 60000) {
  if (!await eventually(async () => (await heldBy(hgs, space)).length === n, ms)) return false
  await sleep(3000)
  return (await heldBy(hgs, space)).length === n
}

test('a circle of 8: each space on exactly 5 holders, copiesOf(); a holder leaves, the next takes over', { timeout: 300000 }, async (t) => {
  const { a, circle, holders } = await circleOf(t, 7)
  const one = await forum.createForum(a, 'One', { private: true })
  await forum.post(one, 'hi', '')
  const two = await forum.createForum(a, 'Two', { private: true })
  await forum.post(two, 'hi', '')
  t.ok(await keptByExactly(holders, one, 5), 'one: 5 copies')
  t.ok(await keptByExactly(holders, two, 5), 'two: 5 copies')
  t.ok(await eventually(() => a.copiesOf(one.key).kept === 5, 20000))
  t.alike(a.copiesOf(one.key), { wanted: 5, kept: 5, online: 5 })
  t.is(circle.status().keptBy, undefined, 'keptBy is gone')
  t.is(circle.status().holders, 7)

  const before = await heldBy(holders, one)
  const leaver = before[0]
  await leaver.leaveSpace(circle.key)
  const rest = holders.filter((h) => h !== leaver)
  t.ok(await eventually(async () => (await heldBy(rest, one)).length === 5, 60000), 'the next ranked takes over')
  t.ok((before.slice(1)).every((h) => rest.includes(h)), 'the others stay')
  t.ok(await eventually(async () => !(await holdsAll(leaver, one)), 20000), 'the one who left deleted it')
})

test('two circles: 3 + 2 copies', { timeout: 300000 }, async (t) => {
  const x = await circleOf(t, 3, { name: 'X', prefix: 'x' })
  const y = await circleOf(t, 3, { name: 'Y', a: x.a, prefix: 'y' })
  const s = await forum.createForum(x.a, 'S', { private: true })
  await forum.post(s, 'hi', '')
  t.ok(await keptByExactly([...x.holders, ...y.holders], s, 5), '5 copies in all')
  const parts = [(await heldBy(x.holders, s)).length, (await heldBy(y.holders, s)).length].sort().join('+')
  t.is(parts, '2+3')
  t.alike(x.a.copiesOf(s.key).wanted, 5)
})

test('no copy online: one extra copy at once, dropped once 2 are back; a delete from anyone else is refused', { timeout: 300000 }, async (t) => {
  const { a, holders } = await circleOf(t, 6)
  const s = await forum.createForum(a, 'S', { private: true })
  await forum.post(s, 'hi', '')
  t.ok(await keptByExactly(holders, s, 5))
  const regular = await heldBy(holders, s)
  const spare = holders.find((h) => !regular.includes(h))

  const key = (await testing.coreKeys(s)).values().next().value
  t.is(await testing.askDelete(spare, regular[0], key), false, 'refused')
  t.ok(await holdsAll(regular[0], s), 'still held')

  const dirs = regular.map((h) => h.dir)
  for (const h of regular) await h.close()
  t.ok(await eventually(() => holdsAll(spare, s), 60000), 'the spare holds an extra copy')
  t.ok(await eventually(() => a.copiesOf(s.key).kept === 6, 20000))
  t.alike(a.copiesOf(s.key), { wanted: 5, kept: 6, online: 1 }, 'the 5 regular ones and the extra')

  const back = []
  for (const [i, dir] of dirs.slice(0, 2).entries()) back.push(await account(t, 'back' + i, { dir }))
  t.ok(await eventually(async () => !(await holdsAll(spare, s)), 60000), '2 back: the extra copy goes')
  t.ok(await eventually(() => a.copiesOf(s.key).online === 2, 20000))
  t.is(a.copiesOf(s.key).kept, 5)
})

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

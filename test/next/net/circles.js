// Spec 023: circles. People in a circle keep each other's places online:
// each device with holding on holds every member's spaces (encrypted ones
// stay unreadable to it) and serves them to anyone in those spaces, a
// member's offline or not; leaving or removal deletes it at once, unless
// another shared circle covers it.

const test = require('brittle')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { account } = require('../forum/_setup.js')
const { eventually, codeOf } = require('../helpers.js')

const titles = async (f) => (await forum.latest(f)).map((p) => p.title).sort().join()

// Does `holder` hold every core of `space` as long as `owner`'s device has it?
async function holdsAll (holder, space) {
  for (const key of (await testing.coreKeys(space)).values()) {
    const mine = space.hg.store.get({ key })
    await mine.ready()
    const length = mine.length
    await mine.close()
    if (!length) continue
    const copy = holder.store.get({ key })
    await copy.ready()
    const ok = copy.length >= length && await copy.has(0, length)
    await copy.close()
    if (!ok) return false
  }
  return true
}

// a and b in a circle, b holding; `opts` for setHolding.
async function pair (t, opts = {}) {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const circle = await a.createCircle({ name: 'Family' })
  await forum.join(b, await circle.createInvite())
  await b.setHolding({ on: true, ...opts })
  return { a, b, circle }
}

test('createCircle: a private circle; the owner and admins invite, members can\'t', { timeout: 90000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const c = await account(t, 'c')
  const circle = await a.createCircle({ name: 'Friends' })
  t.ok(circle.circle, 'a circle')
  t.ok(circle.private, 'private (spec 022)')
  t.absent((await a.createSpace({ name: 'plain', private: true })).circle, 'a plain space is not one')
  const cb = await forum.join(b, await circle.createInvite())
  t.ok(cb.circle, 'b sees a circle')
  t.is(await codeOf(cb.createInvite()), 'NOT_ALLOWED', 'a member can\'t invite')
  await forum.giveRole(circle, b.identity.publicKey, 'admin')
  t.ok(await eventually(async () => !(await codeOf(cb.createInvite())), 10000), 'an admin can')
  const cc = await forum.join(c, await cb.createInvite())
  t.ok(cc.circle)
  t.is(await codeOf(cc.createInvite()), 'NOT_ALLOWED')
})

test('holding: off until set, 1 GB by default, used counted', { timeout: 60000 }, async (t) => {
  const a = await account(t, 'a')
  t.alike(a.holding(), { on: false, bytes: 1e9, used: 0 })
  await a.setHolding({ on: true })
  t.alike(a.holding(), { on: true, bytes: 1e9, used: 0 })
  await a.setHolding({ on: true, bytes: 5e8 })
  t.is(a.holding().bytes, 5e8)
  await t.exception(a.setHolding({ on: true, bytes: -1 }), /bytes/)
  const dir = a.dir
  await a.close()
  const a2 = await account(t, 'a2', { dir })
  t.alike(a2.holding(), { on: true, bytes: 5e8, used: 0 }, 'kept across restarts (per device)')
})

test('an outsider in a member\'s private conversation reads its latest from a holder while the member is offline', { timeout: 180000 }, async (t) => {
  const { a, b, circle } = await pair(t)
  const c = await account(t, 'c') // not in the circle
  const talk = await forum.createForum(a, 'Talk-7071', { private: true })
  const ct = await forum.join(c, await forum.invite(talk))
  t.ok(await eventually(async () => (await titles(ct)) === '', 10000))
  await c.close()

  await forum.post(talk, 'late-1', 'secret-7071')
  await forum.post(talk, 'late-2', 'secret-7071')
  t.ok(await eventually(() => holdsAll(b, talk), 30000), 'b holds a\'s conversation')
  t.ok(await eventually(async () => (await circle.status()).keptBy === 1, 30000), 'a sees it kept by 1')
  t.absent(testing.inClear(await testing.rawBlocks(b.store, [...(await testing.coreKeys(talk)).values()]), 'secret-7071'), 'b can\'t read it')
  t.absent(b.spaces().some((s) => s.key === talk.key), 'nor is it one of b\'s spaces')
  await a.close()

  const t0 = Date.now()
  const c2 = await account(t, 'c2', { dir: c.dir })
  const ct2 = c2.space(talk.key)
  t.ok(await eventually(async () => (await titles(ct2)) === 'late-1,late-2', 60000), 'c reads them from b')
  t.comment(`read from the holder in ${Date.now() - t0} ms`)
})

test('a closed space is handed too', { timeout: 120000 }, async (t) => {
  const a = await account(t, 'a', { idleMs: 500 })
  const old = await forum.createForum(a, 'Old-1')
  await forum.post(old, 'kept-while-closed', '')
  t.ok(await eventually(() => !a.spaces().find((s) => s.key === old.key).opened, 15000), 'closed when idle')
  const b = await account(t, 'b')
  const circle = await a.createCircle({ name: 'C' })
  await forum.join(b, await circle.createInvite())
  await b.setHolding({ on: true })
  const closedOld = a.spaces().find((s) => s.key === old.key)
  t.absent(closedOld.opened, 'still closed')
  t.ok(await eventually(() => holdsAll(b, old), 30000), 'b holds it')
})

test('caps: the member cap hands the newest first; past the share, the oldest activity goes first', { timeout: 150000 }, async (t) => {
  const { a, b } = await pair(t)
  const older = await forum.createForum(a, 'Older', { private: true })
  await forum.post(older, 'o', 'x'.repeat(200000))
  const newer = await forum.createForum(a, 'Newer', { private: true })
  await forum.post(newer, 'n', 'y'.repeat(200000))
  t.ok(await eventually(async () => (await holdsAll(b, older)) && (await holdsAll(b, newer)), 30000), 'both held')
  await b.setHolding({ on: true, bytes: 300000 })
  t.ok(await eventually(async () => b.holding().used <= 300000, 30000), 'b fits its share again')
  t.ok(await holdsAll(b, newer), 'the newer is kept')
  t.absent(await holdsAll(b, older), 'the older went')

  const c = await account(t, 'c')
  testing.memberBytes(c, 300000) // the 200 MB per member, lowered
  await forum.join(c, await a.createCircle({ name: 'C2' }).then((x) => x.createInvite()))
  const c1 = await forum.createForum(c, 'C-old', { private: true })
  await forum.post(c1, 'o', 'x'.repeat(200000))
  const c2 = await forum.createForum(c, 'C-new', { private: true })
  await forum.post(c2, 'n', 'y'.repeat(200000))
  await a.setHolding({ on: true })
  t.ok(await eventually(() => holdsAll(a, c2), 30000), 'c\'s newest is handed')
  t.absent(await holdsAll(a, c1), 'not the one past c\'s cap')
})

test('removal and leaving delete at once, unless another shared circle covers it; status()', { timeout: 180000 }, async (t) => {
  const { a, b, circle } = await pair(t)
  const d = await account(t, 'd')
  const cd = await forum.join(d, await circle.createInvite())
  const da = await forum.createForum(d, 'D-talk', { private: true })
  await forum.post(da, 'from d', '')
  const aa = await forum.createForum(a, 'A-talk', { private: true })
  await forum.post(aa, 'from a', '')
  t.ok(await eventually(async () => (await holdsAll(b, da)) && (await holdsAll(b, aa)), 30000), 'b holds a\'s and d\'s')
  t.ok(await eventually(async () => {
    const s = await circle.status()
    return s.members === 3 && s.holders === 1 && s.keptBy === 1
  }, 30000), 'status: 3 members, 1 holding, kept by 1')
  t.alike(await cd.status().then((s) => s.members), 3)

  // d is removed: b deletes d's at once
  await forum.removeMember(circle, d.identity.publicKey)
  t.ok(await eventually(async () => !(await holdsAll(b, da)), 20000), 'd\'s data gone from b')
  t.ok(await holdsAll(b, aa), 'a\'s stays')

  // a and b share a second circle: b leaving the first keeps a's
  const second = await a.createCircle({ name: 'Second' })
  await forum.join(b, await second.createInvite())
  await b.leaveSpace(circle.key)
  await new Promise((resolve) => setTimeout(resolve, 3000))
  t.ok(await holdsAll(b, aa), 'still covered by the second circle')
  t.ok(await eventually(async () => (await circle.status()).members === 1, 20000), 'a sees b gone from the first')
  await b.leaveSpace(second.key)
  t.ok(await eventually(async () => !(await holdsAll(b, aa)), 20000), 'left both: a\'s data gone from b')
  t.ok(await eventually(async () => (await second.status()).keptBy === 0, 20000), 'kept by nobody')
})

// Spec 023: circles. People in a circle keep each other's places online:
// devices with holding on hold the members' spaces (5 copies of each, spec
// 024; encrypted ones stay unreadable to them) and serve them to anyone in those spaces, a
// member's offline or not; leaving or removal deletes it at once, unless
// another shared circle covers it.

const test = require('brittle')
const crypto = require('hypercore-crypto')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { account, device } = require('../forum/_setup.js')
const { eventually, codeOf } = require('../helpers.js')
const { holdsAll, heldBy } = require('./_circles.js')

const titles = async (f) => (await forum.latest(f)).map((p) => p.title).sort().join()

// a and b in a circle, b holding; `opts` for setHolding.
// `n` posts of 50 KB (a record is 64 KB at most)
async function fill (f, n, ch) {
  for (let i = 0; i < n; i++) await forum.post(f, ch + i, ch.repeat(50000))
}

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
  await t.exception.all(a.setHolding({ on: true, bytes: -1 }), /bytes/)
  const dir = a.dir
  await a.close()
  const a2 = await account(t, 'a2', { dir })
  t.alike(a2.holding(), { on: true, bytes: 5e8, used: 0 }, 'kept across restarts (per device)')
})

test('an outsider in a member\'s private conversation reads its latest from a holder while the member is offline', { timeout: 180000 }, async (t) => {
  const { a, b } = await pair(t)
  const c = await account(t, 'c') // not in the circle
  const talk = await forum.createForum(a, 'Talk-7071', { private: true })
  const ct = await forum.join(c, await forum.invite(talk))
  t.ok(await eventually(async () => (await titles(ct)) === '', 10000))
  await c.close()

  await forum.post(talk, 'late-1', 'secret-7071')
  await forum.post(talk, 'late-2', 'secret-7071')
  t.ok(await eventually(() => holdsAll(b, talk), 30000), 'b holds a\'s conversation')
  t.ok(await eventually(async () => a.copiesOf(talk.key).kept === 1, 30000), 'a sees it kept by 1 copy')
  t.absent(testing.inClear(await testing.rawBlocks(b.store, [...(await testing.coreKeys(talk)).values()]), 'secret-7071'), 'b can\'t read it')
  t.absent(b.spaces().some((s) => s.key === talk.key), 'nor is it one of b\'s spaces')
  await a.close()

  const t0 = Date.now()
  const c2 = await account(t, 'c2', { dir: c.dir })
  const ct2 = c2.space(talk.key)
  t.ok(await eventually(async () => (await titles(ct2)) === 'late-1,late-2', 60000), 'c reads them from b')
  t.comment(`read from the holder in ${Date.now() - t0} ms`)
})

test('a closed space is handed without being opened', { timeout: 120000 }, async (t) => {
  const a = await account(t, 'a', { idleMs: 500, maxAnnounced: 1 }) // only the circle stays open
  const circle = await a.createCircle({ name: 'C' })
  const old = await forum.createForum(a, 'Old-1')
  await forum.post(old, 'kept-while-closed', '')
  const keys = [...(await testing.coreKeys(old)).values()]
  const opened = () => a.spaces().find((s) => s.key === old.key).opened
  t.ok(await eventually(() => !opened(), 15000), 'closed when idle')
  const b = await account(t, 'b')
  await forum.join(b, await circle.createInvite())
  await b.setHolding({ on: true })
  t.ok(await eventually(() => holdsAll(b, old, keys), 30000), 'b holds it')
  t.absent(opened(), 'never opened for it')
})

test('caps: the member cap hands the newest first; past the share, the oldest activity goes first', { timeout: 150000 }, async (t) => {
  const { a, b } = await pair(t)
  const older = await forum.createForum(a, 'Older', { private: true })
  await fill(older, 4, 'x')
  const newer = await forum.createForum(a, 'Newer', { private: true })
  await fill(newer, 4, 'y')
  t.ok(await eventually(async () => (await holdsAll(b, older)) && (await holdsAll(b, newer)), 30000), 'both held')
  await b.setHolding({ on: true, bytes: 300000 })
  t.ok(await eventually(async () => b.holding().used <= 300000, 30000), 'b fits its share again')
  t.ok(await holdsAll(b, newer), 'the newer is kept')
  t.absent(await holdsAll(b, older), 'the older went')

  const c = await account(t, 'c')
  testing.memberBytes(c, 300000) // the 200 MB per member, lowered
  await forum.join(c, await a.createCircle({ name: 'C2' }).then((x) => x.createInvite()))
  const c1 = await forum.createForum(c, 'C-old', { private: true })
  await fill(c1, 4, 'x')
  const c2 = await forum.createForum(c, 'C-new', { private: true })
  await fill(c2, 4, 'y')
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
    const s = circle.status()
    return s.members === 3 && s.holders === 1 && a.copiesOf(aa.key).kept === 1
  }, 30000), 'status: 3 members, 1 holding; kept by 1 copy')
  t.is(cd.status().members, 3)

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
  t.ok(await eventually(async () => circle.status().members === 1, 20000), 'a sees b gone from the first')
  await b.leaveSpace(second.key)
  t.ok(await eventually(async () => !(await holdsAll(b, aa)), 20000), 'left both: a\'s data gone from b')
  t.ok(await eventually(async () => a.copiesOf(aa.key).kept === 0, 20000), 'kept by nobody')
})

test('a holder who is also in a held space never loses its own copy: past its share, or leaving the circle', { timeout: 150000 }, async (t) => {
  const { a, b, circle } = await pair(t)
  const shared = await forum.createForum(a, 'Shared', { private: true })
  const sb = await forum.join(b, await forum.invite(shared)) // b is in it too
  await fill(shared, 4, 'z')
  t.ok(await eventually(async () => (await forum.latest(sb)).length === 4, 30000), 'b has it as a member')
  const other = await forum.createForum(a, 'Other', { private: true })
  await fill(other, 2, 'w')
  t.ok(await eventually(() => holdsAll(b, other), 30000), 'b holds a\'s other one')
  t.ok(b.spaces().some((s) => s.key === shared.key) && !b.spaces().some((s) => s.key === other.key), 'only its own space is among b\'s')
  await b.setHolding({ on: true, bytes: 1000 }) // far past its share
  t.ok(await eventually(async () => !(await holdsAll(b, other)), 20000), 'what it held goes')
  await b.leaveSpace(circle.key)
  await a.close()
  t.is((await forum.latest(sb)).length, 4, 'b still reads its own space, a offline')
})

test('leaving: from one device the person leaves; only their own records count; rejoining holds again', { timeout: 180000 }, async (t) => {
  const { a, b, circle } = await pair(t)
  const { code } = await forum.addDevice(b)
  const b2 = await device(t, 'b2', code)
  t.ok(await eventually(() => b2.spaces().some((s) => s.key === circle.key), 20000), 'b2 has the circle')
  await b2.setHolding({ on: true })
  const talk = await forum.createForum(a, 'Talk', { private: true })
  await forum.post(talk, 'hi', '')
  t.ok(await eventually(async () => (await heldBy([b, b2], talk)).length === 1, 30000), "one of b's devices holds a's (one per person, spec 024)")
  const bh = (await heldBy([b, b2], talk))[0]

  // c writes `left` in its own name: only c counts as gone
  const c = await account(t, 'c')
  const cc = await forum.join(c, await circle.createInvite())
  t.ok(await eventually(() => circle.status().members === 3, 20000))
  await cc._put('hg/holder', { client: Buffer.alloc(32), on: false, left: true })
  t.ok(await eventually(() => circle.status().members === 2, 20000), 'c counts as gone')
  t.ok(await holdsAll(bh, talk), "b still holds a's")

  await b.leaveSpace(circle.key)
  t.ok(await eventually(async () => !(await holdsAll(b, talk)), 20000), 'gone from b')
  t.ok(await eventually(async () => !(await holdsAll(b2, talk)) && !b2.spaces().some((s) => s.key === circle.key), 30000), 'b2 left too, and dropped it')
  t.ok(await eventually(() => circle.status().members === 1, 20000), 'a sees b gone')

  await forum.join(b, await circle.createInvite()) // back, after its `left`
  t.ok(await eventually(() => circle.status().members === 2, 20000), 'a sees b back')
  t.ok(await eventually(async () => (await heldBy([b, b2], talk)).length === 1, 30000), "b holds a's again")
})

test('a member handing a holder\'s own cores under a made-up referrer can\'t make it delete them', { timeout: 150000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const circle = await a.createCircle({ name: 'C' })
  await forum.join(b, await circle.createInvite())
  await a.setHolding({ on: true }) // a holds; b hands
  const shared = await forum.createForum(b, 'Shared', { private: true })
  const sa = await forum.join(a, await forum.invite(shared))
  await forum.post(shared, 'kept-4411', '')
  t.ok(await eventually(async () => (await forum.latest(sa)).length === 1, 20000), 'a reads the shared space')
  t.ok(await eventually(() => !!b._circles.peering, 20000), 'b hands to a')

  const personal = a._personal.decisionLog.base.local.key // a's personal space
  const own = sa.own.key // a's log in a space it is in
  const lengths = []
  for (const key of [personal, own]) {
    const core = a.store.get({ key })
    await core.ready()
    lengths.push(core.length)
    await core.close()
  }
  t.ok(lengths.every((n) => n > 0), 'a has blocks in both')
  const fake = crypto.randomBytes(32)
  for (const [i, key] of [personal, own].entries()) {
    const core = b.store.get({ key })
    await core.ready()
    await b._circles.peering.addCore(core, { referrer: fake, announce: false })
    t.comment('handed ' + i)
  }
  await new Promise((resolve) => setTimeout(resolve, 3000))
  t.absent(a._circles.held.has(personal.toString('hex')) || a._circles.held.has(own.toString('hex')), 'neither recorded as held')

  await b.leaveSpace(circle.key)
  await a.setHolding({ on: false }) // drops everything held
  await new Promise((resolve) => setTimeout(resolve, 2000))
  for (const [i, key] of [personal, own].entries()) {
    const core = a.store.get({ key })
    await core.ready()
    t.ok(core.length >= lengths[i] && await core.has(0, lengths[i]), 'a\'s blocks intact ' + i) // the personal core may grow meanwhile (a lists the space it joined)
    await core.close()
  }
  t.is((await forum.latest(sa)).length, 1, 'a still reads the shared space')
})

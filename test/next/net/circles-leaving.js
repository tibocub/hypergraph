// Circles: a holder that is also a member, leaving from one device, a made-up
// referrer, storage numbers. (The first part: circles.js.)

const test = require('brittle')
const crypto = require('hypercore-crypto')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { account, device } = require('../forum/_setup.js')
const { eventually } = require('../helpers.js')
const { holdsAll, heldBy, fill, pair } = require('./_circles.js')

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
  const devs = [b, b2].map((x) => x._identity.device.publicKey.toString('hex'))
  t.ok(await eventually(() => devs.every((d) => a._circles.holders.has(d)), 20000), 'a knows both of b\'s devices holding')
  const talk = await forum.createForum(a, 'Talk', { private: true })
  await forum.post(talk, 'hi', '')
  t.ok(await eventually(async () => (await heldBy([b, b2], talk)).length === 1, 30000), "one of b's devices holds a's (one per person, spec 024)")
  const bh = (await heldBy([b, b2], talk))[0]

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
  for (const key of [personal, own]) t.is(await testing.askDelete(b, a, key), false, 'its delete-core for them is refused (blind-peer would have cleared them)')

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

test('storage numbers (spec 026): members see each holder\'s share and use, a share change at once, the circle\'s total', { timeout: 120000 }, async (t) => {
  const { a, b, circle } = await pair(t, { bytes: 3e9 })
  await a.setHolding({ on: true, bytes: 2e9 })
  const cb = b.space(circle.key)
  const person = async (s, who) => (await s.members()).find((m) => m.identity === who.identity.publicKey)
  t.ok(await eventually(async () => (await person(circle, b)).share === 3e9 && (await person(cb, a)).share === 2e9, 30000), 'each sees the other\'s share')
  t.is(typeof (await person(circle, b)).used, 'number', 'and its use')
  t.ok(await eventually(() => circle.status().total === 5e9 / 5 && cb.status().total === 5e9 / 5, 30000), 'total: shares / 5')

  await b.setHolding({ on: true, bytes: 4e9 })
  t.ok(await eventually(async () => (await person(circle, b)).share === 4e9, 20000), 'a share change shows at once')
  t.ok(await eventually(() => circle.status().total === 6e9 / 5, 20000))

  const records = async () => (await circle.query('hg/holder').latest(1000)).items.length
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const before = await records()
  await b._circles.update()
  await b._circles.update()
  await new Promise((resolve) => setTimeout(resolve, 2000))
  t.is(await records(), before, 'nothing moved: no new record')

  const c = await account(t, 'c')
  const cc = await forum.join(c, await circle.createInvite())
  await cc._put('hg/holder', { client: crypto.randomBytes(32), on: true, left: false }) // as a device before 026 writes it
  t.ok(await eventually(async () => circle.status().holders === 3, 20000), 'a sees c holding')
  const pc = await person(circle, c)
  t.is(pc.share, null, 'share unknown')
  t.is(pc.used, null, 'use unknown')
  t.is(circle.status().total, 6e9 / 5, 'not in the total')
})

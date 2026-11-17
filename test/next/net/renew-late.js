// Spec 027 (build.md FR-004): writes landing in the old space's logs after the
// move (past the cut the renew recorded: design change 2). The author's own
// device re-posts its own records into the renewed space, once (a `from` link
// to the old id), sealed with the new keys; never anyone else's, never for a
// removed person; records before the cut are history, not re-posted; readers
// ignore the old-log records past the cut.

const test = require('brittle')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { account, device } = require('../forum/_setup.js')
const { eventually, sleep } = require('../helpers.js')

const titles = async (f) => (await forum.latest(f, 50)).map((p) => p.title)
const count = async (f, title) => (await titles(f)).filter((x) => x === title).length
const spaceOf = (hg, key) => { try { return hg.space(key) } catch { return null } }
const movedOn = (hg, old, fresh) => eventually(() => { const s = spaceOf(hg, old.key); return s && s.key === fresh.key ? s : null }, 40000)

test('late writes: the author re-posts its own, once, sealed with the new keys; a removed person\'s are dropped', { timeout: 240000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const c = await account(t, 'c')
  const fa = await forum.createForum(a, 'Late-2711', { private: true })
  const fb = await forum.join(b, await forum.invite(fa))
  const fc = await forum.join(c, await forum.invite(fa))
  const early = await forum.post(fb, 'b-before', '')
  t.ok(await eventually(async () => (await titles(fa)).includes('b-before'), 20000))
  await forum.removeMember(fa, c.identity.publicKey)

  const fresh = await fa.renew()
  const onB = await movedOn(b, fa, fresh)
  t.ok(onB, 'b moved')
  const oldOnB = b._spaces.get(fa.hex)
  const late = await testing.writeAsIfNotMoved(oldOnB, 'post', { title: 'b-late', text: '' })
  await testing.writeRaw(c._spaces.get(fa.hex) || fc, { kind: 'put', type: 'post', fields: { title: 'c-late', text: '' } })

  const dir = b.dir
  await b.close()
  const b2 = await account(t, 'b2', { dir })
  const onB2 = await eventually(() => { const s = spaceOf(b2, fa.key); return s && s.key === fresh.key ? s : null }, 40000)
  t.ok(onB2, 'b back')
  t.ok(await eventually(async () => (await count(fresh, 'b-late')) === 1, 90000), 'a reads b\'s late post, re-posted')
  const reposted = (await forum.latest(fresh, 50)).find((p) => p.title === 'b-late')
  t.not(reposted.id, late.id, 'with a new id')
  t.is(await count(fresh, 'b-before'), 1, 'what came before the move is history: not re-posted')
  t.is((await forum.latest(fresh, 50)).find((p) => p.title === 'b-before').id, early.id, 'same id')
  t.absent(await testing.inClear(await testing.rawBlocks(b2.store, await testing.coreKeys(onB2)), 'b-late'), 'sealed on disk')

  await b2.close()
  const b3 = await account(t, 'b3', { dir })
  t.ok(await eventually(() => { const s = spaceOf(b3, fa.key); return s && s.key === fresh.key }, 40000))
  await sleep(5000)
  t.is(await count(fresh, 'b-late'), 1, 'a second start re-posts nothing more')
  t.is(await count(fresh, 'c-late'), 0, 'the removed person\'s late write is dropped')
})

test('late writes of two devices of one person: each re-posts its own, nobody else\'s', { timeout: 240000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Two-2712', { private: true })
  await forum.join(b, await forum.invite(fa))
  const { code } = await forum.addDevice(b)
  const phone = await device(t, 'phone', code)
  const onPhone = await eventually(() => spaceOf(phone, fa.key), 30000)
  await onPhone.ready()
  await forum.post(onPhone, 'phone-before', '')

  const fresh = await fa.renew()
  t.ok(await movedOn(b, fa, fresh), 'the laptop moved')
  t.ok(await movedOn(phone, fa, fresh), 'the phone moved')
  await testing.writeAsIfNotMoved(phone._spaces.get(fa.hex), 'post', { title: 'phone-late', text: '' })
  const dir = phone.dir
  await phone.close()
  await b.close() // the laptop holds the phone's old log too: it must not re-post it
  const b2 = await account(t, 'b2', { dir: b.dir })
  t.ok(await movedOn(b2, fa, fresh))
  const phone2 = await account(t, 'phone2', { dir })
  t.ok(await movedOn(phone2, fa, fresh))
  t.ok(await eventually(async () => (await count(fresh, 'phone-late')) === 1, 90000), 'one re-post')
  const r = (await forum.latest(fresh, 50)).find((p) => p.title === 'phone-late')
  t.is(r.device, phone2.device.publicKey, 'by the device that wrote it')
  await sleep(3000)
  t.is(await count(fresh, 'phone-late'), 1, 'still one')
})

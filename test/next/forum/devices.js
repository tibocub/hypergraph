// Story 3 #1, #3-6: one person, two devices. A phone joins with the laptop's
// code and shows the same forums and settings; both write as the same person;
// a change made after seeing an earlier one wins whatever the clocks say;
// simultaneous offline edits settle the same everywhere; a lost device is
// removed with the recovery phrase (research.md A7), keeping what it wrote
// before and nothing after.

const test = require('brittle')
const forum = require('./forum.js')
const z32 = require('z32')
const testing = require('../../../lib/testing.js')
const { account, device } = require('./_setup.js')
const { eventually, open, codeOf } = require('../helpers.js')

// The laptop owns a forum with another member, c; the phone joins with the
// laptop's code and, once it shows the forum, writes in it.
async function twoDevices (t) {
  const laptop = await account(t, 'laptop')
  const c = await account(t, 'c')
  const fl = await forum.createForum(laptop, 'Fans')
  const fc = await forum.join(c, await forum.invite(fl))
  await forum.setSetting(laptop, 'theme', 'dark')

  const started = Date.now()
  const { code, added } = await forum.addDevice(laptop)
  const phone = await device(t, 'phone', code)
  const shown = await eventually(async () => forum.forums(phone).some((f) => f.key === fl.key) && (await forum.setting(phone, 'theme')) === 'dark', 15000)
  const ms = Date.now() - started
  const fp = phone.space(fl.key)
  t.ok(await eventually(async () => {
    try { return !!(await forum.post(fp, 'phone is in', '')) } catch { return false }
  }, 10000), 'the phone can write in the forum')
  return { laptop, phone, c, fl, fp, fc, added, shown, ms }
}

const titles = (f) => forum.latest(f).then((xs) => xs.map((x) => x.title).sort().join())
const agree = (spaces, fn, expected, ms = 10000) => eventually(async () => {
  for (const f of spaces) if ((await fn(f)) !== expected) return false
  return true
}, ms)

test('a phone joins with the laptop\'s code: the same person, forums and settings', async (t) => {
  const { laptop, phone, c, fl, fp, fc, added, shown, ms } = await twoDevices(t)
  t.ok(shown, 'the phone shows the laptop\'s forum and settings')
  t.ok(ms < 10000, `within 10 s of asking for a code (${ms} ms, SC-010)`)
  t.is(phone.identity.publicKey, laptop.identity.publicKey, 'the same person')
  t.not(phone.device.publicKey, laptop.device.publicKey, 'another device')
  t.is((await added).publicKey, phone.device.publicKey, 'the laptop learns which device joined')
  t.is(await forum.recoveryPhrase(phone), await forum.recoveryPhrase(laptop), 'the phone received the recovery phrase')

  const names = async (hg) => (await forum.devices(hg)).map((d) => `${d.name}${d.current ? '*' : ''}`).sort().join()
  t.ok(await eventually(async () => (await names(laptop)) === 'laptop*,phone', 10000), 'the laptop lists both devices')
  t.ok(await eventually(async () => (await names(phone)) === 'laptop,phone*', 10000), 'so does the phone')

  await forum.post(fl, 'from the laptop', '')
  const expected = ['from the laptop', 'phone is in'].join()
  t.ok(await agree([fl, fp, fc], titles, expected), 'everyone sees both posts')
  const authors = new Set((await forum.latest(fc)).map((p) => p.author))
  t.alike([...authors], [laptop.identity.publicKey], 'by the same person')
  t.ok(c)

  await forum.setSetting(phone, 'theme', 'light')
  t.ok(await eventually(async () => (await forum.setting(laptop, 'theme')) === 'light', 10000), 'a setting changed on the phone reaches the laptop')
})

test('latest wins across devices, even with the laptop\'s clock an hour ahead', async (t) => {
  const { laptop, phone, fl, fp, fc } = await twoDevices(t)
  const p = await forum.post(fc, 'Vote here', '')
  t.ok(await eventually(async () => (await phone.space(fl.key).get(p.id)).record, 10000))

  testing.setClock(laptop, 3600e3)
  await forum.vote(fl, p, 1)
  const score = (f) => forum.score(f, p)
  t.ok(await agree([fp], score, 1), 'the phone sees the laptop\'s +1')
  await forum.vote(fp, p, -1)
  t.ok(await agree([fl, fp, fc], score, -1), 'the phone\'s later -1 counts everywhere')

  const mine = await forum.post(fl, 'Draft', 'v1')
  await forum.edit(fl, mine, { text: 'v2 (laptop)' })
  const text = async (f) => ((await f.get(mine.id)).record || {}).text
  t.ok(await agree([fp], text, 'v2 (laptop)'))
  await forum.edit(fp, mine, { text: 'v3 (phone)' })
  t.ok(await agree([fl, fp, fc], text, 'v3 (phone)'), 'the phone\'s later edit wins everywhere')

  // The laptop's clock is put right; after a restart its next vote still
  // comes after everything this person wrote with the clock ahead.
  await laptop.close()
  const again = await account(t, 'laptop-again', { dir: laptop.dir })
  const fl2 = again.space(fl.key)
  t.ok(await agree([fl2], score, -1))
  await forum.vote(fl2, p, 1)
  t.ok(await agree([fl2, fp, fc], score, 1), 'the laptop\'s vote after a restart counts everywhere')
})

test('simultaneous edits from two offline devices settle the same everywhere', async (t) => {
  const { laptop, phone, fl, fc } = await twoDevices(t)
  const mine = await forum.post(fl, 'Shared', 'v1')
  const text = async (f) => ((await f.get(mine.id)).record || {}).text
  t.ok(await eventually(async () => (await text(phone.space(fl.key))) === 'v1', 10000))

  await laptop.close()
  await phone.close()
  const opts = { types: forum.types, rules: forum.rules }
  const l2 = await open(t, { dir: laptop.dir, ...opts })
  const p2 = await open(t, { dir: phone.dir, ...opts })
  await forum.edit(l2.space(fl.key), mine, { text: 'from the laptop' })
  await forum.edit(p2.space(fl.key), mine, { text: 'from the phone' })
  await l2.connectToSwarm()
  await p2.connectToSwarm()

  const all = [l2.space(fl.key), p2.space(fl.key), fc]
  t.ok(await eventually(async () => {
    const seen = await Promise.all(all.map(text))
    return seen[0] !== 'v1' && seen.every((x) => x === seen[0])
  }, 15000), 'every member shows the same version')
})

test('a lost device: removed with the recovery phrase; what it wrote before stays, nothing after', async (t) => {
  const { laptop, phone, fl, fp, fc } = await twoDevices(t)
  await forum.protectPhrase(laptop, 'laptop password')
  await forum.protectPhrase(phone, 'phone password')
  const before = await forum.post(fp, 'before', '')
  t.ok(await agree([fl, fc], titles, ['before', 'phone is in'].join()))

  // Whoever holds the phone without its password can't remove the laptop.
  t.is(await codeOf(forum.removeDevice(phone, laptop.device.publicKey)), 'NOT_ALLOWED', 'no removal without the recovery phrase')
  t.is(await codeOf(forum.removeDevice(laptop, phone.device.publicKey, 'wrong')), 'NOT_ALLOWED', 'nor with a wrong password')
  await forum.removeDevice(laptop, phone.device.publicKey, 'laptop password')

  // The lost phone writes on (its own app would refuse once it learns).
  await testing.writeRaw(fp, { kind: 'put', type: 'post', fields: { title: 'after', text: '' } })
  await testing.writeRaw(fp, { kind: 'edit', type: 'post', target: before.id, fields: { title: 'before, edited after', text: '' } })
  const expected = ['before', 'phone is in'].join()
  t.ok(await agree([fl, fc], titles, expected), 'what it wrote before stays; nothing after counts')
  t.ok(await eventually(async () => {
    try { await forum.post(fp, 'refused', ''); return false } catch (err) { return err.code === 'DEVICE_REMOVED' }
  }, 10000), 'the phone\'s own app refuses to write once it learns')
  t.ok(await eventually(async () => (await forum.devices(laptop)).map((d) => d.name).join() === 'laptop', 10000), 'the laptop lists only itself')

  const d = await account(t, 'newcomer')
  const fd = await forum.join(d, await forum.invite(fl))
  t.ok(await agree([fd], titles, expected), 'a newcomer shows the same')
})

test('someone else can\'t remove your device, even with their own recovery phrase', async (t) => {
  const { laptop, phone, c, fl, fp, fc } = await twoDevices(t)
  const words = await forum.recoveryPhrase(c)
  t.is(await codeOf(c.removeDevice(phone.device.publicKey, { recoveryPhrase: words })), 'NOT_FOUND', 'c\'s app refuses: not one of c\'s devices')
  await testing.removeDeviceAnyway(c, phone.device.publicKey, words) // c's removal is written anyway
  await forum.post(fp, 'still here', '')
  t.ok(await agree([fl, fp, fc], titles, ['phone is in', 'still here'].join()), 'the phone\'s posts still count everywhere')
  t.is((await forum.devices(laptop)).length, 2)
})

// Story 4 (research.md A8): decision rights follow devices.

test('the owner\'s phone moderates and lets people in, with the laptop offline, no extra step', async (t) => {
  const { laptop, fp, fc } = await twoDevices(t)
  const rude = await forum.post(fc, 'rude', '')
  t.ok(await eventually(async () => (await fp.get(rude.id)).record, 10000))
  t.ok(await eventually(async () => {
    try { await forum.hide(fp, rude, 'rude'); return true } catch { return false }
  }, 15000), 'the phone records decisions')
  t.ok(await agree([fc], (f) => forum.latest(f).then((xs) => xs.some((x) => x.id === rude.id)), false), 'everyone applies its hide')

  await laptop.close()
  const d = await account(t, 'd')
  const fd = await forum.join(d, await forum.invite(fp))
  t.ok(fd, 'a newcomer is let in by the phone while the laptop is offline')
})

test('an admin\'s phone moderates', async (t) => {
  const { laptop, fl, fc, c } = await twoDevices(t)
  await forum.giveRole(fl, c.identity.publicKey, 'admin')
  const { code } = await forum.addDevice(c)
  const cPhone = await device(t, 'c-phone', code)
  const p = await forum.post(fl, 'Welcome', '')
  const fcp = await eventually(async () => {
    try { const f = cPhone.space(fl.key); return (await f.get(p.id)).record ? f : null } catch { return null }
  }, 15000)
  t.ok(fcp, 'c\'s phone holds the forum')
  t.ok(await eventually(async () => {
    try { await forum.hide(fcp, p, 'test'); return true } catch { return false }
  }, 15000), 'c\'s phone records decisions')
  t.ok(await agree([fl, fc], titles, 'phone is in'), 'hidden for everyone')
  t.ok(laptop)
})

test('a removed device\'s decisions afterwards are ignored by everyone, a newcomer included', async (t) => {
  const { laptop, phone, c, fl, fp, fc } = await twoDevices(t)
  // The phone records decisions (it claimed its writer key).
  t.ok(await eventually(async () => {
    try { await forum.flag(fp, (await forum.latest(fp))[0], 'check'); return true } catch { return false }
  }, 15000), 'the phone records decisions')
  await forum.protectPhrase(laptop, 'pw')
  const phoneDir = phone.dir
  await phone.close()
  await forum.removeDevice(laptop, phone.device.publicKey, 'pw')

  // The stolen phone, offline, bans c; then it connects.
  const thief = await open(t, { dir: phoneDir, types: forum.types, rules: forum.rules })
  const ft = thief.space(fl.key)
  await testing.decide(ft, { type: 'moderate', action: 'ban', target: z32.decode(c.identity.publicKey), reason: 'stolen', cut: [] })
  t.is(await forum.roleOf(ft, c.identity.publicKey), null, 'the stolen phone, offline, banned c')
  await thief.connectToSwarm()

  const role = (f) => forum.roleOf(f, c.identity.publicKey)
  t.ok(await agree([fl, fc], role, 'member'), 'c is still a member for everyone')
  const d = await account(t, 'newcomer')
  const fd = await forum.join(d, await forum.invite(fl))
  t.ok(await agree([fd], role, 'member'), 'and for a newcomer')
  t.ok(await eventually(async () => (await codeOf(forum.post(ft, 'more', ''))) === 'DEVICE_REMOVED', 10000), 'the stolen phone\'s app learns it was removed')
  t.ok(fp)
})

test('once the phrase is forgotten on a device, it is typed to add or remove a device', async (t) => {
  const laptop = await account(t, 'laptop')
  const words = await forum.recoveryPhrase(laptop)
  await forum.forgetPhrase(laptop)
  t.is(await codeOf(forum.addDevice(laptop)), 'NOT_ALLOWED', 'addDevice needs it')
  const { code } = await laptop.addDevice({ recoveryPhrase: words })
  const phone = await device(t, 'phone', code)
  t.is(phone.identity.publicKey, laptop.identity.publicKey)
  t.is(await codeOf(forum.removeDevice(laptop, phone.device.publicKey)), 'NOT_ALLOWED', 'removeDevice needs it')
  const other = await forum.recoveryPhrase(await account(t, 'someone else'))
  t.is(await codeOf(laptop.removeDevice(phone.device.publicKey, { recoveryPhrase: other })), 'NOT_ALLOWED', 'another account\'s phrase is refused')
  await laptop.removeDevice(phone.device.publicKey, { recoveryPhrase: words })
  t.ok(await eventually(async () => (await forum.devices(laptop)).length === 1, 10000))
})

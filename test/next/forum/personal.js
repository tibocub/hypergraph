// Story 3 #2, FR-026: the personal space, shared by a person's devices only.
// An app record kept there ("this device holds X", as SwarmFS will write) is
// read by the person's other device and by nobody else: it is encrypted, not
// listed among the spaces, and someone else writing into it is ignored.

const test = require('brittle')
const b4a = require('b4a')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const { eventually, sleep, open, codeOf } = require('../helpers.js')

// The forum's types plus what a file-sharing app would keep per device.
const types = {
  ...forum.types,
  held: { fields: { path: 'string', holder: 'string', root: 'string' }, index: [['holder', 'stamp'], ['root', 'stamp']] }
}

test('an app record in the personal space: the other device reads it, nobody else', async (t) => {
  const laptop = await open(t, { label: 'laptop', types })
  await laptop.connectToSwarm()
  const { code } = await laptop.addDevice()
  const phone = await open(t, { label: 'phone', types, joinCode: code })
  const stranger = await open(t, { label: 'stranger', types })
  await stranger.connectToSwarm()

  const held = (hg, holder) => hg.personal.query('held').where({ holder }).latest(10).then((r) => r.items.map((x) => x.path).join())
  const rec = await laptop.personal.put('held', { path: '/music/a.mp3', holder: laptop.device.publicKey })
  t.is(rec.author, laptop.identity.publicKey)
  t.is(rec.device, laptop.device.publicKey)
  t.ok(await eventually(async () => (await held(phone, laptop.device.publicKey)) === '/music/a.mp3', 10000), 'the phone reads what the laptop holds')

  t.absent(laptop.spaces().some((s) => s.key === laptop.personal.key), 'not listed among the spaces')
  t.is(await codeOf((async () => stranger.space(laptop.personal.key))()), 'NOT_FOUND', 'a stranger doesn\'t hold it')
  const raw = await testing.rawBlock(laptop.personal, rec.id)
  t.ok(raw && b4a.indexOf(raw, b4a.from('/music/a.mp3')) === -1, 'its blocks are encrypted (on disk and on the wire)')

  // A stranger who got hold of its keys writes "into" it: ignored.
  const intruder = await testing.openSpace(stranger, laptop.personal.key, testing.personalKeys(laptop))
  await testing.writeRaw(intruder, { kind: 'put', type: 'held', fields: { path: '/evil', holder: laptop.device.publicKey } })
  testing.announce(intruder)
  await sleep(2000)
  t.is(await held(laptop, laptop.device.publicKey), '/music/a.mp3', 'the laptop ignores it')
  t.is(await held(phone, laptop.device.publicKey), '/music/a.mp3', 'so does the phone')
  t.absent(testing.logs(laptop.personal).includes(testing.ownLog(intruder)), 'and doesn\'t keep its log')
})

test('each device\'s heads (its log lengths) reach the person\'s other devices', async (t) => {
  const laptop = await open(t, { label: 'laptop', types })
  await laptop.connectToSwarm()
  const { code } = await laptop.addDevice()
  const phone = await open(t, { label: 'phone', types, joinCode: code })
  const mine = await phone.createSpace({ name: 'mine' })
  await mine.put('post', { title: 'x', text: '' })
  await testing.writeHeads(phone)
  const log = testing.ownLog(mine)
  t.ok(await eventually(async () => {
    const heads = await testing.headsOf(laptop, phone.device.publicKey)
    return heads.some((h) => h.log === log && h.length >= 2)
  }, 10000), 'the laptop knows how far the phone wrote')
})

// Story 4 (ROADMAP 2026-10-09): what one device wrote, e.g. SwarmFS's "what does this device hold".
test('query(type).fromDevice(key): what one device wrote, page by page', async (t) => {
  const laptop = await open(t, { label: 'laptop', types })
  await laptop.connectToSwarm()
  const { code } = await laptop.addDevice()
  const phone = await open(t, { label: 'phone', types, joinCode: code })
  for (const p of ['/a', '/b', '/c']) await laptop.personal.put('held', { path: p, holder: '' })
  t.ok(await eventually(async () => {
    try { return !!(await phone.personal.put('held', { path: '/phone', holder: '' })) } catch { return false }
  }, 10000))
  const paths = (r) => r.items.map((x) => x.path).join()
  const from = (hg, dev, n = 10, opts) => hg.personal.query('held').fromDevice(dev.device.publicKey).latest(n, opts)
  t.ok(await eventually(async () => paths(await from(phone, laptop)) === '/c,/b,/a', 10000), 'the phone lists what the laptop holds')
  t.ok(await eventually(async () => paths(await from(laptop, phone)) === '/phone', 10000), 'and the laptop what the phone holds')
  const first = await from(phone, laptop, 2)
  t.is(paths(first), '/c,/b')
  const next = await from(phone, laptop, 2, { after: first.items.at(-1) })
  t.is(paths(next), '/a', 'paging, no gaps or repeats')
})

// SwarmFS's H10: what this device wrote is all here, so reading it doesn't
// wait for the other device, even offline after a restart.
test('fromDevice(this device) answers at once, complete, with the other device offline', async (t) => {
  const laptop = await open(t, { label: 'laptop', types })
  await laptop.connectToSwarm()
  const { code } = await laptop.addDevice()
  const phone = await open(t, { label: 'phone', types, joinCode: code })
  t.ok(await eventually(async () => {
    try { return !!(await phone.personal.put('held', { path: '/phone', holder: '' })) } catch { return false }
  }, 10000))
  await laptop.personal.put('held', { path: '/a', holder: '' })
  const dir = laptop.dir
  await phone.close()
  await laptop.close()
  const again = await open(t, { dir, types, readTimeout: 5000 })
  const started = Date.now()
  const res = await again.personal.query('held').fromDevice(again.device.publicKey).latest(10)
  t.is(res.items.map((x) => x.path).join(), '/a')
  t.ok(res.complete, 'complete')
  t.ok(Date.now() - started < 1000, 'without waiting the read timeout: ' + (Date.now() - started) + ' ms')
  t.absent((await again.personal.query('held').latest(10, { timeout: 300 })).complete, 'everything: not complete, the phone is offline')
})

// SwarmFS's H3: "does this device hold X" is an index filter and fromDevice
// together (AND).
test('where() and fromDevice() combine', async (t) => {
  const laptop = await open(t, { label: 'laptop', types })
  await laptop.connectToSwarm()
  const { code } = await laptop.addDevice()
  const phone = await open(t, { label: 'phone', types, joinCode: code })
  await laptop.personal.put('held', { path: '/l1', holder: '', root: 'r1' })
  await laptop.personal.put('held', { path: '/l2', holder: '', root: 'r2' })
  t.ok(await eventually(async () => {
    try { return !!(await phone.personal.put('held', { path: '/p1', holder: '', root: 'r1' })) } catch { return false }
  }, 10000))
  const paths = (r) => r.items.map((x) => x.path).join()
  const holds = (hg, dev, root) => hg.personal.query('held').where({ root }).fromDevice(dev.device.publicKey).latest(10)
  t.ok(await eventually(async () => paths(await holds(phone, laptop, 'r1')) === '/l1', 10000), 'the laptop\'s r1 only')
  t.ok(await eventually(async () => paths(await holds(laptop, phone, 'r1')) === '/p1', 10000), 'the phone\'s r1 only')
  t.is(paths(await holds(laptop, phone, 'r2')), '', 'the phone holds no r2')
  t.is(paths(await holds(laptop, laptop, 'r2')), '/l2')
})

// Story 6 (ROADMAP 2026-10-09): superseded settings and heads don't pile up.
// Each device keeps one row per setting and per device's heads; the older
// versions' blocks are cleared, except in a device's own log, which stays
// whole so the other devices can always fetch and check it (FR-027).
test('settings set many times and heads written many times leave one of each, on every device', async (t) => {
  const laptop = await open(t, { label: 'laptop', types })
  await laptop.connectToSwarm()
  const { code } = await laptop.addDevice()
  const phone = await open(t, { label: 'phone', types, joinCode: code })
  const mine = await laptop.createSpace({ name: 'mine' })
  for (let i = 0; i < 5; i++) {
    await laptop.setSetting('theme', `laptop ${i}`)
    await mine.put('post', { title: `p${i}`, text: '' })
    await testing.writeHeads(laptop)
  }
  const theme = async (hg) => (await hg.settings()).theme
  t.ok(await eventually(async () => (await theme(phone)) === 'laptop 4', 10000), 'the phone shows the latest')
  await phone.setSetting('theme', 'phone 0')
  await phone.setSetting('theme', 'phone 1')
  t.ok(await eventually(async () => (await theme(laptop)) === 'phone 1', 10000), 'the laptop shows the phone\'s latest')

  const one = async (hg) => {
    const { records } = await hg.personal.inspect()
    return records['hg/setting'] === 1 && records['hg/heads'] <= 2
  }
  t.ok(await eventually(async () => (await one(laptop)) && (await one(phone)), 10000), 'one setting row and one heads row per device, on each device')

  const logOn = async (hg, key) => (await hg.personal.inspect()).logs.find((l) => l.key === key)
  const laptopLog = await logOn(laptop, testing.ownLog(laptop.personal))
  t.is(laptopLog.held, laptopLog.length, 'the laptop\'s own log stays whole')
  const phoneLog = testing.ownLog(phone.personal)
  const cleared = async () => { const l = await logOn(laptop, phoneLog); return l.held < l.length }
  t.ok(await eventually(cleared, 5000), 'the phone\'s superseded settings are cleared on the laptop')
  await sleep(2000)
  t.ok(await cleared(), 'and not fetched again')

  // A third device, and a restart, show the same, complete.
  const { code: code2 } = await laptop.addDevice()
  const tablet = await open(t, { label: 'tablet', types, joinCode: code2 })
  t.ok(await eventually(async () => (await theme(tablet)) === 'phone 1', 10000), 'a new device shows the latest')
  t.ok(await eventually(async () => (await tablet.personal.query('held').latest(1)).complete, 10000), 'complete: nothing it needs is missing')
  t.ok(await eventually(async () => one(tablet), 10000), 'one row of each there too')
  await laptop.close()
  const again = await open(t, { dir: laptop.dir, types })
  t.is(await theme(again), 'phone 1', 'after a restart')
  t.ok(await one(again))
})

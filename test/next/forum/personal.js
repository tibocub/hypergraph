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
  held: { fields: { path: 'string', holder: 'string' }, index: [['holder', 'stamp']] }
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

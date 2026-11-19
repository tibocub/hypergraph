// The simulator's core and the export. node research/holders/test.js
const test = require('brittle')
const path = require('path')
const os = require('os')
const fs = require('fs')
const { execFileSync } = require('child_process')
const HyperDB = require('hyperdb')
const b4a = require('b4a')
const def = require('../../lib/index/spec/hyperdb')
const { packHours } = require('../../lib/circles.js')
const { anonymise } = require('./export.js')
const { simulate, unit, wilson, replay, replication, erasure, copiesFor } = require('./sim.js')

const H = 4 * 168
const M0 = 2 * 168
const pattern = (fn) => Uint8Array.from({ length: H }, (_, t) => (fn(t) ? 1 : 0))
const dev = (online, extra = {}) => ({ kind: 'test', tz: 0, joinAt: 0, online, helper: false, ...extra })

test('S3 numbers: Wilson lower bound as the spec says', (t) => {
  t.ok(Math.abs(wilson(1, 1) - 0.207) < 0.01, '1 h always on ~ 20 %')
  t.ok(Math.abs(wilson(1, 24) - 0.86) < 0.01, '1 day ~ 86 %')
  t.ok(wilson(1, 720) > 0.99, '30 days ~ 99 %')
})

test('RQ1 formulas', (t) => {
  t.is(copiesFor(0.5, 0.99), 7)
  t.ok(Math.abs(replication(0.5, 1) - 0.5) < 1e-9)
  t.ok(Math.abs(erasure(0.5, 1, 1) - 0.5) < 1e-9)
  t.ok(Math.abs(erasure(0.3, 1, 5) - replication(0.3, 5)) < 1e-9, '1-of-n is n copies')
})

test('replay: a copy online when the owner is off counts every offline hour', (t) => {
  const owner = dev(pattern((h) => h % 24 < 12)) // days (UTC)
  const night = dev(pattern((h) => h % 24 >= 10)) // 2 hours with the owner: enough to be handed
  const r = simulate({ devices: [owner, night], H, M0 }, 'hash', { copies: 1 })
  // the night holder's space: owner `night` offline in the day, `owner` holds it then
  t.is(r.avail, 1)
  t.is(r.uploads, 0, 'handed before the measured weeks, never again')
})

test('replay: a holder never online with the owner never gets a copy (handing needs both online)', (t) => {
  const owner = dev(pattern((h) => h % 24 < 12))
  const night = dev(pattern((h) => h % 24 >= 12))
  const other = dev(pattern((h) => h % 24 >= 12))
  const r = simulate({ devices: [owner, night, other], H, M0 }, 'hash', { copies: 2, extra: false })
  t.ok(r.avail < 1, 'the night-only holders of `owner` hold nothing for it')
})

test('replay: 7 days unseen -> replaced, a weighted pick prefers the always-on device', (t) => {
  const owner = dev(pattern(() => true))
  const gone = dev(pattern((h) => h < 168))
  const helper = dev(pattern(() => true), { helper: true })
  let seed = 1
  while (unit(seed, 0, 1) > unit(seed, 0, 2)) seed++ // the hash ranks `gone` first for the owner's space
  const opts = { copies: 1, extra: false, seed }
  const replaced = simulate({ devices: [owner, gone, helper], H, M0 }, 'hash', opts)
  const never = simulate({ devices: [owner, gone, helper], H, M0 }, 'hash', { ...opts, staleH: Infinity })
  t.ok(replaced.load[2] >= H - M0, 'replaced: the helper holds the owner\'s space all the measured weeks')
  t.ok(never.load[2] < H - M0, 'never replaced: it doesn\'t')
  t.ok(simulate({ devices: [owner, gone, helper], H, M0 }, 'weighted', { ...opts, staleH: Infinity }).load[2] >= H - M0, 'weighted: the helper from the start')
})

test('real maps replayed by hour of the week', (t) => {
  const end = 500000 // an hour number
  const hours = []
  for (let a = end - 719; a <= end; a++) if ((a + 72) % 168 === 10) hours.push(a) // Monday 10:00 UTC
  const out = replay(hours, 2 * 168, end)
  t.alike([...out.keys()].filter((i) => out[i]), [10, 178])
})

test('export: labels, roles, no keys', (t) => {
  const now = 480000 * 3600000
  const self = 'aa'.repeat(32)
  const holder = 'bb'.repeat(32)
  const seen = { at: { [holder]: now }, hours: { [self]: packHours(new Set([480000, 479999]), now), [holder]: packHours(new Set([480000]), now) }, replaced: [], reported: 0 }
  const file = anonymise(seen)
  const text = JSON.stringify(file)
  t.absent(text.includes('aa'.repeat(4)) || text.includes('bb'.repeat(4)), 'no key in the file')
  t.alike(file.devices.find((d) => d.role === 'self').hours, [479999, 480000])
  t.alike(file.devices.find((d) => d.role === 'seen'), { label: 'holder-1', role: 'seen', online: 0, hours: [480000] })
})

test('export: reads the index read only while another process has it open', async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.HG_TEST_TMP || os.tmpdir(), 'hg-025-'))
  const now = Date.now()
  const hour = Math.floor(now / 3600000)
  const seen = { at: { ['bb'.repeat(32)]: now }, hours: { ['aa'.repeat(32)]: packHours(new Set([hour, hour - 1, hour - 2]), now) } }
  const db = HyperDB.rocks(path.join(dir, 'index'), def)
  await db.ready()
  await db.insert('@hg/meta', { name: 'seen', value: b4a.from(JSON.stringify(seen)) })
  await db.flush()
  const out = path.join(dir, 'hours.json')
  execFileSync(process.execPath, [path.join(__dirname, 'export.js'), dir, '--out', out]) // db still open here
  await db.close()
  const file = JSON.parse(fs.readFileSync(out, 'utf-8'))
  t.is(file.devices.length, 1)
  t.alike(file.devices[0].hours, [hour - 2, hour - 1, hour])
  fs.rmSync(dir, { recursive: true, force: true })
})

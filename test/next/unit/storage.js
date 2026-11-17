// Spec 026: each holder's share and use (lib/circles.js): when a device
// rewrites its hg/holder record, and the sums members see.

const test = require('brittle')
const { COPIES, storageMoved, storageOf } = require('../../../lib/circles.js')

const H = 3600 * 1000

test('a record is rewritten for a share change at once, a use moving 10 % at most once an hour', (t) => {
  const mine = { share: 1e9, used: 100e6 }
  t.ok(storageMoved(null, { share: 1e9, used: 0 }, 0, 0), 'no record yet')
  t.ok(storageMoved({ share: null, used: null }, { share: 1e9, used: 0 }, 0, 0), 'an old record without them')
  t.ok(storageMoved(mine, { share: 2e9, used: 100e6 }, 0, 0), 'share changed: at once')
  t.absent(storageMoved(mine, { share: 1e9, used: 100e6 }, 0, 2 * H), 'nothing moved')
  t.absent(storageMoved(mine, { share: 1e9, used: 109e6 }, 0, 2 * H), 'under 10 %')
  t.ok(storageMoved(mine, { share: 1e9, used: 110e6 }, 0, 2 * H), '10 % up')
  t.ok(storageMoved(mine, { share: 1e9, used: 90e6 }, 0, 2 * H), '10 % down')
  t.absent(storageMoved(mine, { share: 1e9, used: 200e6 }, 0, H - 1), 'moved, but within the hour')
  t.ok(storageMoved({ share: 1e9, used: 0 }, { share: 1e9, used: 1e6 }, 0, H), 'from nothing')
})

test('per person: their holding devices\' latest share and use added up; unknown if none reported; total = shares / 5', (t) => {
  const records = [
    { identity: 'a', on: true, share: 1e9, used: 2e8 },
    { identity: 'a', on: true, share: 2e9, used: 1e8 }, // a's second device
    { identity: 'b', on: true, share: 3e9, used: 0 },
    { identity: 'b', on: false, share: 0, used: 0 }, // not holding: not counted
    { identity: 'c', on: true, share: null, used: null }, // an old record: unknown
    { identity: 'd', on: false, share: 0, used: 0 } // holds nothing
  ]
  const { people, total } = storageOf(records)
  t.alike(people.get('a'), { share: 3e9, used: 3e8 })
  t.alike(people.get('b'), { share: 3e9, used: 0 })
  t.absent(people.has('c'), 'unknown')
  t.absent(people.has('d'), 'not holding')
  t.is(total, 6e9 / COPIES)
  t.is(storageOf([{ identity: 'c', on: true }]).total, null, 'no share known: no total')
  t.alike(storageOf([{ identity: 'a', on: true, share: 1e9 }, { identity: 'a', on: true }]).people.get('a'), { share: 1e9, used: 0 }, 'a device with no use reported counts its share only')
})

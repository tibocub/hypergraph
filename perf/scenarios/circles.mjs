// Circles (spec 023): people keeping each other's spaces online, real peers on a local DHT:
//   circles.hand        a member with N private conversations (a few posts each) in a circle; a
//                       friend turns holding on: until the friend holds all of them (ms)
//   circles.start       a holder holding N MB for a friend reopens: until open with its holding
//                       running again (ms). flat: must not grow with what it holds (spec: 1 GB;
//                       `--sizes 1000` for that, slow to fill)

import { context, record, now, eventually, sizes } from '../harness.mjs'
import helpers from '../../test/next/helpers.js'
import testing from '../../lib/testing.js'

const types = { post: { fields: { title: 'string', body: 'string' } } }

async function holdsAll (holder, member, spaces) {
  for (const s of spaces) {
    for (const key of await testing.coreKeys(s)) {
      const mine = member.store.get({ key })
      await mine.ready()
      const length = mine.contiguousLength
      await mine.close()
      if (!length) continue
      const copy = holder.store.get({ key })
      await copy.ready()
      const ok = copy.contiguousLength >= length
      await copy.close()
      if (!ok) return false
    }
  }
  return true
}

const t = context()
try {
  for (const n of sizes([5, 20])) {
    const a = await helpers.open(t, { types, label: 'member' })
    const b = await helpers.open(t, { types, label: 'friend' })
    await a.connectToSwarm()
    await b.connectToSwarm()
    const circle = await a.createCircle({ name: 'Friends' })
    await b.redeemInvite(await circle.createInvite())
    const spaces = []
    for (let i = 0; i < n; i++) {
      const s = await a.createSpace({ name: 'talk ' + i, private: true })
      for (let j = 0; j < 3; j++) await s.put('post', { title: 'p' + j, body: 'x'.repeat(1000) })
      spaces.push(s)
    }
    const start = now()
    await b.setHolding({ on: true })
    if (!await eventually(() => holdsAll(b, a, spaces), 120000)) throw new Error('never held')
    record('circles.hand', n, 'ms', now() - start)
    await a.close()
    await b.close()
  }

  for (const mb of sizes([5, 25])) {
    const a = await helpers.open(t, { types, label: 'member' })
    const b = await helpers.open(t, { types, label: 'holder' })
    await a.connectToSwarm()
    await b.connectToSwarm()
    const circle = await a.createCircle({ name: 'Friends' })
    await b.redeemInvite(await circle.createInvite())
    await b.setHolding({ on: true })
    const s = await a.createSpace({ name: 'big', private: true })
    for (let i = 0; i < mb * 16; i++) await s.put('post', { title: 'p' + i, body: 'y'.repeat(60000) }) // ~64 KB each
    if (!await eventually(() => b.holding().used >= mb * 0.9e6, 300000)) throw new Error('never held')
    const dir = b.dir
    await b.close()
    const samples = []
    for (let k = 0; k < 3; k++) {
      const start = now()
      const b2 = await helpers.open(t, { types, dir, label: 'holder again' })
      await b2.connectToSwarm()
      await b2._circles.update()
      samples.push(now() - start)
      await b2.close()
    }
    record('circles.start', mb, 'ms', samples, { flat: true })
    await a.close()
  }
} finally {
  await t.close()
}

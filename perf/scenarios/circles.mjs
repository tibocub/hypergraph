// Circles: people keeping each other's spaces online, real peers on a local DHT:
//   circles.hand        a member with N private conversations (a few posts each) in a circle; a
//                       friend turns holding on: until the friend holds all of them (ms)
//   circles.records     the same holder's hg/holder records once it holds them all (share and
//                       use rewritten on a 10 % move, at most hourly). flat: not one per space
//   circles.start       a holder holding N MB for a friend reopens: until open with its holding
//                      running again (ms). flat: must not grow with what it holds (target: 1 GB;
//                       `--sizes 1000` for that, slow to fill)
//   circles.upload      a member in a circle of N (all the others holding) writes a private
//                       conversation of ~1 MB: what its device uploads until held, in times its
//                       size (about 5, was N - 1)
//   circles.share       the same: what the holders use for it in all, in times its size (the copies)
//   circles.join        3 circles; N others join all three, holding on: each person's 3 joins (ms).
//                       From 7 people this crashed the process (a holder announced
//                       message logs as decision writers); the run fails on anything uncaught

import process from 'process' // Bare: bare-process (package.json imports)
import { context, record, now, eventually, sizes, sleep } from '../harness.mjs'
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
    // the holder's own hg/holder records (share and use), flat: not one per space held
    const records = (await circle.query('hg/holder').latest(1000)).items.filter((r) => r.device === b.device.publicKey).length
    record('circles.records', n, 'records', records, { flat: true })
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

  // what the member's device sent: its swarm connections and its blind-peering ones
  const sent = (hg) => {
    let n = 0
    for (const conn of hg._network.connections) n += conn.rawBytesWritten || 0
    const peering = hg._circles.peering
    if (peering) for (const p of peering.blindPeers.values()) n += (p.socket && p.socket.rawBytesWritten) || 0
    return n
  }
  for (const n of sizes([8])) {
    const a = await helpers.open(t, { types, label: 'member' })
    await a.connectToSwarm()
    const circle = await a.createCircle({ name: 'Friends' })
    const holders = []
    for (let i = 1; i < n; i++) {
      const h = await helpers.open(t, { types, label: 'friend ' + i })
      await h.connectToSwarm()
      await h.redeemInvite(await circle.createInvite())
      await h.setHolding({ on: true })
      holders.push(h)
    }
    await sleep(3000) // circle records settled
    const s = await a.createSpace({ name: 'talk', private: true })
    const before = sent(a)
    for (let i = 0; i < 16; i++) await s.put('post', { title: 'p' + i, body: 'z'.repeat(60000) })
    let bytes = 0
    for (const key of await testing.coreKeys(s)) {
      const core = a.store.get({ key })
      await core.ready()
      bytes += core.byteLength
      await core.close()
    }
    const held = async () => {
      let k = 0
      for (const h of holders) if (await holdsAll(h, a, [s])) k++
      return k
    }
    if (!await eventually(async () => (await held()) >= Math.min(5, n - 1), 120000)) throw new Error('never held')
    let last = -1
    while (last !== await held()) { // until no more holders fetch it
      last = await held()
      await sleep(5000)
    }
    record('circles.upload', n, 'x', (sent(a) - before) / bytes)
    let used = 0
    for (const h of holders) used += h.holding().used
    record('circles.share', n, 'x', used / bytes)
    for (const h of holders) await h.close()
    await a.close()
  }

  for (const n of sizes([8])) {
    const uncaught = []
    const onerr = (err) => uncaught.push(err)
    process.on('uncaughtException', onerr)
    process.on('unhandledRejection', onerr)
    try {
      const a = await helpers.open(t, { types, label: 'owner' })
      await a.connectToSwarm()
      await a.setHolding({ on: true })
      const circles = []
      for (let i = 0; i < 3; i++) circles.push(await a.createCircle({ name: 'C' + i }))
      const people = []
      const samples = []
      for (let p = 0; p < n; p++) {
        const h = await helpers.open(t, { types, label: 'person ' + p })
        await h.connectToSwarm()
        const start = now()
        for (const c of circles) {
          await h.redeemInvite(await c.createInvite())
          await h.setHolding({ on: true })
        }
        samples.push(now() - start)
        people.push(h)
      }
      await sleep(5000) // hand-offs and wakeups after the last join
      if (uncaught.length) throw uncaught[0]
      record('circles.join', n, 'ms', samples)
      for (const h of people) await h.close()
      await a.close()
    } finally {
      process.off('uncaughtException', onerr)
      process.off('unhandledRejection', onerr)
    }
  }
} finally {
  await t.close()
}

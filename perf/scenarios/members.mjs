// Members and reactions as a space grows (specs/research/scale-audit.md, perf scenarios 1, 2
// and 6), real decisions on a local DHT:
//   members.decision  one more decision (a member added) applied on the owner, with N members
//                     already in (each written as a real decision: lib/testing.js decide), until
//                     the space's 'members' event (its decision hooks done; not members(), a
//                     list of all N the app may or may not read). flat: must not grow with
//                     members (the audit's top risk, #1)
//   members.join      a newcomer redeems an invite with N members in: until let in (ms)
//   members.join-kb   what it downloaded to get there (KB). flat
//   reactions.count   count() of the likes on one post with N likes (ms per read). flat: the
//                     audit's #10 (every like is read; counters would make it flat)
//   reactions.sum     sum() of the same

import hc from 'hypercore-crypto'
import { context, time, record, now, eventually, within, sizes } from '../harness.mjs'
import helpers from '../../test/next/helpers.js'
import testing from '../../lib/testing.js'

const types = {
  post: { fields: { title: 'string' } },
  like: { fields: { value: 'int', on: 'link' }, links: { on: ['post'] } } // not one per member: one author writes many
}
const received = (hg) => { let n = 0; for (const c of hg._network.swarm.connections) n += c.rawBytesRead || 0; return n }

const t = context()
try {
  const owner = await helpers.open(t, { types, label: 'owner' })
  await owner.connectToSwarm()
  const space = await owner.createSpace({ name: 'Club' })
  let count = 0
  const add = async (k) => {
    for (let i = 0; i < k; i++) await testing.decide(space, { type: 'member/add', identity: hc.randomBytes(32) })
    count += k
    if (!await eventually(async () => (await space.members()).length >= count + 1, 60000)) throw new Error('the members never showed')
  }
  for (const n of sizes([100, 400])) {
    await add(n - count)
    const decisions = await time(async () => {
      const id = hc.randomBytes(32)
      const applied = new Promise((resolve) => {
        const done = () => { if (space.state.isMember(id)) { space.off('members', done); resolve() } }
        space.on('members', done)
      })
      await testing.decide(space, { type: 'member/add', identity: id })
      count++
      if (!await within(applied.then(() => true), 30000)) throw new Error('the decision never applied')
    }, 5)
    record('members.decision', n, 'ms', decisions, { flat: true })
    const joins = []
    const kbs = []
    for (let j = 0; j < 3; j++) {
      const c = await helpers.open(t, { types, label: 'newcomer' })
      try {
        await c.connectToSwarm()
        const link = await space.createInvite({ role: 'member' })
        const start = now()
        await c.redeemInvite(link)
        joins.push(now() - start)
        kbs.push(received(c) / 1024)
      } finally {
        await c.close()
      }
      count++
    }
    record('members.join', n, 'ms', joins)
    record('members.join-kb', n, 'KB', kbs, { flat: true })
  }

  // reactions, on a space of its own
  const club = await owner.createSpace({ name: 'Likes' })
  const post = await club.put('post', { title: 'hot' })
  let likes = 0
  for (const n of sizes([1000, 4000])) {
    for (; likes < n; likes++) await club.put('like', { value: 1, on: post })
    record('reactions.count', n, 'ms', await time(() => club.count('like', { on: post }), 5), { flat: true })
    record('reactions.sum', n, 'ms', await time(() => club.sum('like', 'value', { on: post }), 5), { flat: true })
  }
} finally {
  await t.close()
}

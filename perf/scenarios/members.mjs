// Members and reactions as a space grows (specs/research/scale-audit.md, perf scenarios 1, 2
// and 6), real decisions on a local DHT:
//   members.decision  one more decision (a member added) applied on the owner, with N members
//                     already in (each written as a real decision: lib/testing.js decide), until
//                     the space's 'members' event (its decision hooks done; not members(), a
//                     list of all N the app may or may not read). flat: must not grow with
//                     members (the audit's top risk, #1)
//   members.join      a newcomer redeems an invite with N members in: until let in (ms)
//   members.join-kb   what it downloaded to get there (KB). flat
//   members.public-join  spec 016: a newcomer joins a public space with N known public members
//                     (their logs held: scripted, keys only) through its link, and posts: until
//                     another member reads the post (ms)
//   members.public-join-kb  what the newcomer downloaded to join (KB). flat
//   members.public-cost  what the other members received while it joined, silent (KB). flat:
//                     a silent account costs nobody
//   logs.settle-kb    two members holding the same N logs, one new log at one of them, never
//                     announced: bytes of ranges and keys until the other has it (spec 016, R7). flat
//   reactions.count   count() of the likes on one post with N likes (ms per read). flat: the
//                     audit's #10 (every like is read; counters would make it flat)
//   reactions.sum     sum() of the same

import hc from 'hypercore-crypto'
import c from 'compact-encoding'
import { context, time, record, now, eventually, within, sizes, sleep } from '../harness.mjs'
import enc from '../../lib/encodings.js'
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

  // public spaces (spec 016)
  const pub = await owner.createSpace({ name: 'Open' })
  await pub.makePublic()
  const plink = pub.publicLink()
  const reader = await helpers.open(t, { types, label: 'reader' })
  await reader.connectToSwarm()
  const rp = await reader.redeemInvite(plink)
  await rp.put('post', { title: 'reader' }) // its log known to the owner
  if (!await eventually(async () => (await pub.query('post').latest(5)).items.length === 1, 30000)) throw new Error('the reader never showed')
  let known = 0
  const someone = { identity: hc.randomBytes(32), device: hc.randomBytes(32) }
  for (const n of sizes([1000, 4000])) {
    for (; known < n; known++) {
      const key = hc.randomBytes(32)
      for (const s of [pub, rp]) await s.directory.accept(key, s.store.get({ key }), someone, { announce: false })
    }
    await sleep(1500) // their summaries settle
    const joins = []
    const kbs = []
    const costs = []
    for (let j = 0; j < 3; j++) {
      const n2 = await helpers.open(t, { types, label: 'public-newcomer' })
      try {
        await n2.connectToSwarm()
        const before = received(owner) + received(reader)
        const start = now()
        const space2 = await n2.redeemInvite(plink)
        kbs.push(received(n2) / 1024)
        await sleep(1000) // silent for a moment
        costs.push((received(owner) + received(reader) - before) / 1024)
        const title = 'hello ' + j + ' ' + n
        await space2.put('post', { title })
        if (!await eventually(async () => (await rp.query('post').latest(5)).items.some((p) => p.title === title), 30000)) throw new Error('the post never arrived')
        joins.push(now() - start - 1000)
      } finally {
        await n2.close()
      }
    }
    record('members.public-join', n, 'ms', joins)
    record('members.public-join-kb', n, 'KB', kbs, { flat: true })
    record('members.public-cost', n, 'KB', costs, { flat: true })

    // one new log at the owner, never announced: settled with the reader by ranges
    const toward = (s, peer) => [...s.directory.channels].find((ch) => ch.peer && ch.peer.equals(peer))
    const settle = []
    for (let r = 0; r < 3; r++) {
      let bytes = 0
      const chans = [toward(pub, reader._identity.device.publicKey), toward(rp, owner._identity.device.publicKey)]
      const undo = []
      for (const ch of chans) {
        for (const [i, codec] of [[1, enc.ranges], [2, enc.keys]]) {
          const m = ch.messages[i]
          const send = m.send
          m.send = (x) => { bytes += c.encode(codec, x).byteLength; return send.call(m, x) }
          undo.push(() => { m.send = send })
        }
      }
      const fresh = hc.randomBytes(32)
      let seen = false
      const consider = rp.directory.consider
      rp.directory.consider = function (k, urgent) { if (k.equals(fresh)) seen = true; return consider.call(this, k, urgent) }
      await pub.directory.accept(fresh, pub.store.get({ key: fresh }), someone, { announce: false })
      known++
      const ok = await eventually(() => seen, 30000)
      await sleep(1000) // the exchange is over
      rp.directory.consider = consider
      for (const u of undo) u()
      if (!ok) throw new Error('the new log never reached the reader')
      settle.push(bytes / 1024)
    }
    record('logs.settle-kb', n, 'KB', settle, { flat: true })
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

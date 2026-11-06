// Spec 017: a member holding many authors' logs keeps their cores closed until it uses them.
//   logs.held-start      reopening an account whose forum holds N other authors' logs (scripted,
//                        two blocks each, by a member), until the forum's first page (ms). flat
//                        (SC-002): no core is opened per held log; what grows is one index row read
//                        per log
//   logs.held-open       held logs whose core is open right after that (count). flat (SC-001: none)
//   logs.length-settle-kb  two members holding the same N logs, all closed; one log grows at one
//                        of them: bytes of ranges and keys until the other holds the new block
//                        (KB). flat (SC-004: under 3 KB, as a one-log list difference, spec 016)

import hc from 'hypercore-crypto'
import c from 'compact-encoding'
import { context, record, now, eventually, sizes, sleep } from '../harness.mjs'
import enc from '../../lib/encodings.js'
import helpers from '../../test/next/helpers.js'
import testing from '../../lib/testing.js'

const types = { post: { fields: { title: 'string' } } }
const rowsOf = async (s) => (await s.db.find('@hg/logs', { gte: { space: s.keyBytes }, lte: { space: s.keyBytes } }).toArray()).length

// A member's logs, written here (two blocks each: a header and a record), held as accepted.
async function script (space, author, from, to, blocks = ['header', 'x']) {
  const out = []
  for (let i = from; i < to; i++) {
    const core = space.store.get({ name: 'scripted-' + i })
    await core.ready()
    if (blocks.length) await core.append(blocks)
    await space.directory.accept(core.key, core, { identity: author, device: hc.randomBytes(32) }, { announce: false })
    out.push(core.key)
  }
  return out
}

const t = context()
try {
  // held-start
  const dir = helpers.tmpDir(t, 'held')
  let hg = await helpers.open(t, { types, label: 'held', dir, bootstrap: null })
  let space = await hg.createSpace({ name: 'Held' })
  const key = space.key
  await space.put('post', { title: 'hello' })
  const author = hc.randomBytes(32)
  await testing.decide(space, { type: 'member/add', identity: author })
  if (!await eventually(() => space.state.isMember(author), 30000)) throw new Error('the member never showed')
  let held = 0
  for (const n of sizes([1000, 10000])) {
    await script(space, author, held, n)
    held = n
    if (!await eventually(async () => (await rowsOf(space)) >= n, 120000, 200)) throw new Error('the logs were never indexed')
    const starts = []
    const open = []
    for (let r = 0; r < 3; r++) {
      await hg.close()
      const start = now()
      hg = await helpers.open(t, { types, label: 'held', dir, bootstrap: null })
      space = hg.space(key)
      const page = await space.query('post').latest(20)
      starts.push(now() - start)
      if (page.items.length !== 1) throw new Error('the post is gone')
      if (space.directory.logs.size < n) throw new Error(`reopened with ${space.directory.logs.size} logs, not ${n}`)
      open.push(testing.openLogs(space).length)
    }
    record('logs.held-start', n, 'ms', starts, { flat: true })
    record('logs.held-open', n, 'cores', open, { flat: true })
  }
  await hg.close()

  // length-settle-kb
  const owner = await helpers.open(t, { types, label: 'owner' })
  const reader = await helpers.open(t, { types, label: 'reader' })
  testing.idleLogs(owner, 200)
  testing.idleLogs(reader, 200)
  await owner.connectToSwarm()
  await reader.connectToSwarm()
  const club = await owner.createSpace({ name: 'Club' })
  await club.put('post', { title: 'owner' })
  const rc = await reader.redeemInvite(await club.createInvite({ role: 'member' }))
  const someone = hc.randomBytes(32)
  await testing.decide(club, { type: 'member/add', identity: someone })
  if (!await eventually(() => rc.state.isMember(someone), 30000)) throw new Error('the member never reached the reader')
  const toward = (s, peer) => [...s.directory.channels].find((ch) => ch.peer && ch.peer.equals(peer))
  let count = 0
  const keys = []
  for (const n of sizes([1000, 10000])) {
    for (const k of await script(club, someone, count, n, [])) { // empty: grown below
      keys.push(k)
      await rc.directory.accept(k, rc.store.get({ key: k }), { identity: someone, device: hc.randomBytes(32) }, { announce: false })
    }
    count = n
    if (!await eventually(() => club.directory.settled() && rc.directory.settled() && testing.digestOf(club) === testing.digestOf(rc), 60000, 100)) throw new Error('the lists never settled')
    await sleep(1000)
    const settle = []
    for (let r = 0; r < 3; r++) {
      let bytes = 0
      const undo = []
      for (const ch of [toward(club, reader._identity.device.publicKey), toward(rc, owner._identity.device.publicKey)]) {
        for (const [i, codec] of [[1, enc.ranges], [2, enc.keys]]) {
          const m = ch.messages[i]
          const send = m.send
          m.send = (x) => { bytes += c.encode(codec, x).byteLength; return send.call(m, x) }
          undo.push(() => { m.send = send })
        }
      }
      const k = keys[r]
      const log = club.directory.logs.get(k.toString('hex'))
      await club.directory.use(log, (core) => core.append('grown ' + r))
      const theirs = () => rc.directory.logs.get(k.toString('hex'))
      const ok = await eventually(() => theirs() && theirs().length === 1, 30000, 20)
      await sleep(1000) // the exchange is over
      for (const u of undo) u()
      if (!ok) throw new Error('the reader never got the new block')
      settle.push(bytes / 1024)
    }
    keys.splice(0, 3)
    record('logs.length-settle-kb', n, 'KB', settle, { flat: true })
  }
} finally {
  await t.close()
}

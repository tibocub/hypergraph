// Renewing a private space and trimming a forum.
//   renew.time   a renew with N member devices (each a member with a log: the
//                history, and a box of the "moved to" pointer), until it resolves (ms)
//   renew.kb     what the renew wrote: the old space's move plus the new space's
//                copied state (KB of decisions). Grows with the devices; the
//                history itself is never copied
//   trim.time    trimHistory() of a forum holding N posts, all trimmed (ms)

import hc from 'hypercore-crypto'
import { context, time, record, sizes } from '../harness.mjs'
import helpers from '../../test/next/helpers.js'
import testing from '../../lib/testing.js'

const types = { post: { fields: { title: 'string' } } }
const written = (s) => s.decisionLog.base.local.byteLength

const t = context()
try {
  const owner = await helpers.open(t, { types, label: 'owner' })
  for (const n of sizes([100, 1000])) {
    const space = await owner.createSpace({ name: 'Club', private: true })
    for (let i = 0; i < n; i++) {
      const identity = hc.randomBytes(32)
      await testing.decide(space, { type: 'member/add', identity })
      const key = hc.randomBytes(32)
      await space.directory.accept(key, space.store.get({ key }), { identity, device: hc.keyPair().publicKey }, { announce: false })
    }
    const before = written(space)
    let fresh = null
    const ms = await time(async () => { fresh = await space.renew() }, 1)
    record('renew.time', n, 'ms', ms)
    record('renew.kb', n, 'KB', [(written(space) - before + written(fresh)) / 1024])

    const f = await owner.createSpace({ name: 'Forum' })
    for (let i = 0; i < n; i++) await f.put('post', { title: 'p' + i })
    record('trim.time', n, 'ms', await time(() => f.trimHistory({ before: Infinity }), 1))
  }
} finally {
  await t.close()
}

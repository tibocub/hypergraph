// The scale audit's cores (specs/research/scale-audit.md, "Perf scenarios"), measured on the
// code that pays them, at small sizes that show the curve. From bench/scale-audit/:
//   decisions.reload  (#1) what one decision costs every member: the decision view read
//                     again and the state rebuilt (lib/decisions/state.js State.from), with N
//                     members (N member:, redeemed: and listed: entries). flat: must not grow
//                     with members (today it does: the audit's top risk)
//   logs.open         (#2) a full member's start with N held logs: each opened with a live
//                     download range and listeners (lib/replication.js hold); ms per log
//                     (memory per log is not measured here: after the first round the
//                     allocator reuses what closed logs freed; the audit's 18 KB per log came
//                     from a fresh process)
//   grants.seal       (#3) a private space's key change: sealing the key to N devices (ms, the
//                     changer's part; every member then holds and indexes N grants)

import b4a from 'b4a'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import hc from 'hypercore-crypto'
import { context, record, now, sizes } from '../harness.mjs'
import helpers from '../../test/next/helpers.js'
import stateMod from '../../lib/decisions/state.js'
import grants from '../../lib/private/grants.js'
import pc from '../../lib/private/crypto.js'

const hex = () => b4a.toString(hc.randomBytes(32), 'hex')
const [members, logs, devices] = [sizes([1000, 4000, 10000]), sizes([500, 2000]), sizes([100, 1000])]

for (const n of members) {
  const t = context()
  try {
    const store = new Corestore(helpers.tmpDir(t, 'dec'))
    t.teardown(() => store.close())
    const bee = new Hyperbee(store.get({ name: 'view' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await bee.ready()
    const invite = hex()
    for (let i = 0; i < n; i += 1000) {
      const b = bee.batch()
      for (let j = i; j < Math.min(n, i + 1000); j++) {
        const id = hex()
        await b.put('member:' + id, { role: 'member', by: id, stamp: Date.now(), writer: hex(), writerDevice: hex() })
        await b.put(`redeemed:${invite}:${id}`, { at: Date.now(), by: id })
        await b.put('listed:' + hex(), { space: invite })
      }
      await b.flush()
    }
    const times = []
    for (let r = 0; r < 5; r++) {
      const start = now()
      const entries = []
      for await (const { key, value } of bee.createReadStream({ lt: '~' })) entries.push([key, value])
      if (stateMod.State.from(entries).members.size !== n) throw new Error('wrong state')
      times.push(now() - start)
    }
    record('decisions.reload', n, 'ms', times, { flat: true })
    await bee.close()
  } finally {
    await t.close()
  }
}

for (const n of logs) {
  const t = context()
  try {
    const dir = helpers.tmpDir(t, 'logs')
    let store = new Corestore(dir)
    const keys = []
    for (let i = 0; i < n; i++) {
      const core = store.get({ name: 'log-' + i })
      await core.append([b4a.alloc(270), b4a.alloc(110)]) // a header and one post
      keys.push(core.key)
      await core.close()
    }
    await store.close()
    const times = []
    for (let r = 0; r < 3; r++) {
      store = new Corestore(dir) // fresh each time: a reopened store has the cores cached
      await store.ready()
      const start = now()
      const open = []
      for (const key of keys) {
        const core = store.get({ key })
        await core.ready()
        core.on('append', () => {})
        core.on('download', () => {})
        open.push({ core, range: core.download({ start: 2, end: -1 }) })
      }
      times.push((now() - start) / n)
      for (const { core, range } of open) { range.destroy(); await core.close() }
      await store.close()
    }
    record('logs.open', n, 'ms/log', times, { flat: true })
  } finally {
    await t.close()
  }
}

for (const n of devices) {
  const keys = []
  for (let i = 0; i < n; i++) keys.push(hc.keyPair().publicKey)
  const times = []
  for (let r = 0; r < 3; r++) {
    const key = pc.newEpochKey()
    const commit = pc.commitOf(key)
    const start = now()
    for (const d of keys) grants.makeGrant(key, 7, commit, d)
    times.push(now() - start)
  }
  record('grants.seal', n, 'ms', times)
}

// What one decision costs every member as the space grows (lib/decisions/log.js
// reload → _read): the whole view is read and State.from() rebuilds the state.
// A view with N members holds ~3 entries each (member:, redeemed:, uses: per
// invite counted once, and ~log: one per redemption) plus listed: per log
// (spec 013, spaces with helpers). Here: N member: + N redeemed: + N listed:
// entries (the ~log: list is skipped by the read, lt: '~').
//   node --expose-gc bench/scale-audit/decisions-reload.js 1000,10000,100000
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const crypto = require('crypto')
const { State } = require('../../lib/decisions/state.js')
const { tmpDir, rm, mb, mem } = require('./_tmp.js')

const sizes = (process.argv[2] || '1000,10000,100000').split(',').map(Number)
const hex = () => crypto.randomBytes(32).toString('hex')

async function run (n) {
  const dir = tmpDir('dec')
  const store = new Corestore(dir)
  const bee = new Hyperbee(store.get({ name: 'view' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await bee.ready()
  const invite = hex()
  const t0 = Date.now()
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
  const build = Date.now() - t0
  const before = mem()
  const times = []
  let state = null
  for (let r = 0; r < 3; r++) {
    const t = process.hrtime.bigint()
    const entries = []
    for await (const { key, value } of bee.createReadStream({ lt: '~' })) entries.push([key, value])
    state = State.from(entries)
    times.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  const after = mem()
  times.sort((a, b) => a - b)
  console.log(`${n} members (${3 * n} view entries): reload ${times[1].toFixed(0)} ms median of 3; state in memory ~${mb(after.heap - before.heap)} heap (${state.members.size} members); view core ${mb(bee.core.byteLength)}; built in ${build} ms`)
  await bee.close()
  await store.close()
  rm(dir)
}

;(async () => { for (const n of sizes) await run(n) })()

// Where a member's bytes go in the decision log (scale audit #1): each view
// entry a join writes (key + JSON value, and the whole Hyperbee block with its
// tree index), the decision itself in the recorder's writer log, the decision
// list line, and what State holds in memory. N newcomers each redeem an invite
// of their own (as space.createInvite() makes one per person, perf
// members.join), real signed redemptions on a real Autobase; with helpers
// (spec 013) each member's log is listed too.
//   node --expose-gc bench/scale-audit/member-bytes.js [n=2000] [state module to measure memory with]
const path = require('path')
const c = require('compact-encoding')
const Corestore = require('corestore')
const crypto = require('hypercore-crypto')
const { Decisions } = require('../../lib/decisions/log.js')
const { Identity } = require('../../lib/identity.js')
const invites = require('../../lib/invites.js')
const enc = require('../../lib/encodings.js')
const { tmpDir, rm, mem } = require('./_tmp.js')

const N = Number(process.argv[2] || 2000)
const stateModule = process.argv[3] ? path.resolve(process.argv[3]) : '../../lib/decisions/state.js'

async function main () {
  const dir = tmpDir('member-bytes')
  const store = new Corestore(dir)
  const owner = await Identity.create({ device: crypto.keyPair() })
  const d = new Decisions(store, null, { identity: owner })
  await d.ready()
  await d.init({ name: 'Forum' })
  const newcomer = await Identity.create({ device: crypto.keyPair() }) // one signer: the bytes are the same for anyone
  const before = { local: d.base.local.byteLength, view: d.base.view.core.byteLength, viewLength: d.base.view.core.length, system: d.base.system.core.byteLength }
  const t0 = Date.now()
  for (let i = 0; i < N; i++) {
    const inv = invites.makeInvite({ space: d.key, role: 'member', uses: 1 }, owner)
    const r = invites.makeRedemption(inv, newcomer, crypto.randomBytes(32)) // one person, many invites: the same bytes as many people
    await d.base.append(c.encode(enc.decision, { stamp: Date.now(), type: 'invite/redeem', redemption: c.encode(enc.redemption, r) }))
  }
  await d.update()
  const joined = Date.now() - t0
  const decisionBytes = (d.base.local.byteLength - before.local) / N
  const listBytes = (d.base.view.core.byteLength - before.view) / N
  const listBlocks = (d.base.view.core.length - before.viewLength) / N
  console.log({ joined })
  await d.close()
  await store.close()
  rm(dir)
  return { decisionBytes, listBytes, listBlocks, system: before.system }
}

// The entries one counted join writes (lib/decisions/apply.js invite/redeem), on a plain
// Hyperbee like the view: member:, redeemed:, uses: (an invite per person), and listed:
// (spaces with helpers, one log per member). Each put is its own block, as in apply.
async function entries () {
  const Hyperbee = require('hyperbee')
  const dir = tmpDir('member-entries')
  const store = new Corestore(dir)
  const bee = new Hyperbee(store.get({ name: 'view' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await bee.ready()
  const hex = () => crypto.randomBytes(32).toString('hex')
  const maker = hex()
  const space = hex()
  const out = []
  for (let i = 0; i < N; i++) {
    const id = hex()
    const invite = crypto.randomBytes(32).toString('hex').slice(0, 32) // invite ids are 16 bytes (lib/invites.js)
    const stamp = Date.now()
    out.push([`member:${id}`, { role: 'member', by: maker, stamp, writer: hex(), writerDevice: hex() }])
    out.push([`redeemed:${invite}:${id}`, { at: stamp, by: maker }])
    out.push([`uses:${invite}`, { count: 1 }])
    out.push([`listed:${hex()}`, { space }])
    out.push([`~log:${String(i + 10).padStart(12, '0')}`, { type: 'invite/redeem', at: stamp, writer: hex(), by: maker, device: hex(), counted: true, identity: id, role: 'member', invite, maker }])
    out.push(['~count', i + 11])
  }
  const sizes = {}
  for (const [key, value] of out) {
    const len = bee.core.byteLength
    await bee.put(key, value)
    const prefix = key.slice(0, key.indexOf(':') + 1)
    const s = sizes[prefix] || (sizes[prefix] = { kv: 0, block: 0 })
    s.kv += Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value))
    s.block += bee.core.byteLength - len
  }
  await bee.close()
  await store.close()
  rm(dir)
  return { out, sizes }
}

// What State keeps per member: entries made as a view read makes them (fresh key strings
// and parsed values), the state built, the entries dropped.
async function memory (list) {
  const { State } = require(stateModule)
  const raw = list.filter(([k]) => !k.startsWith('~')).map(([k, v]) => [Buffer.from(k), Buffer.from(JSON.stringify(v))])
  const build = (prefix) => {
    const entries = []
    for (const [k, v] of raw) if (!prefix || k.toString().startsWith(prefix)) entries.push([k.toString(), JSON.parse(v)])
    return State.from(entries)
  }
  const parts = {}
  for (const prefix of ['member:', 'redeemed:', 'uses:', 'listed:']) {
    const m0 = mem().heap
    globalThis.keep = build(prefix)
    parts[prefix] = (mem().heap - m0) / N
    globalThis.keep = null
  }
  const m0 = mem().heap
  globalThis.keep = build(null)
  return { parts, total: (mem().heap - m0) / N }
}

main().then(async (log) => {
  const { out, sizes } = await entries()
  const m = await memory(out)
  const row = (name, s, memo) => console.log(`${name.padEnd(14)} ${String(Math.round(s.kv / N)).padStart(6)} B kv ${String(Math.round(s.block / N)).padStart(6)} B block ${memo === undefined ? '' : String(Math.round(memo)).padStart(6) + ' B memory'}`)
  console.log(`N = ${N}, state module ${stateModule}`)
  for (const [prefix, s] of Object.entries(sizes)) row(prefix, s, m.parts[prefix])
  console.log(`view growth    ${Math.round(log.listBytes)} B per join on a real view (${log.listBlocks} blocks)`)
  console.log(`decision       ${Math.round(log.decisionBytes)} B in the recorder's writer log (invite/redeem: invite + 2 proofs + Autobase node)`)
  console.log(`State total    ${Math.round(m.total)} B memory per member (all four entry kinds)`)
}).catch((err) => { console.error(err); process.exitCode = 1 })

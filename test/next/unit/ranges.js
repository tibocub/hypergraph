// Settling log lists by key ranges (spec 016, US5, research R7): counts and
// XOR digests of 16 sub-ranges per message; equal ones stop, small ones are
// answered with their keys, the rest recurse. Two sets converge to their
// union in a few rounds whatever their size; a peer whose keys don't match
// the counts it gave is ignored for that round.

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { Keys, Session, FEW } = require('../../../lib/ranges.js')

const keysOf = (n) => Array.from({ length: n }, () => crypto.randomBytes(32))
const setOf = (list) => { const k = new Keys(); for (const x of list) k.add(x); return k }
const hex = (b) => b4a.toString(b, 'hex')

test('range digests and counts match a brute-force computation', (t) => {
  const list = keysOf(3000)
  const set = setOf(list)
  t.is(set.size, 3000)
  const check = (prefix, bits) => {
    const parts = set.parts(prefix, bits)
    t.is(parts.length, 16)
    for (let i = 0; i < 16; i++) {
      const nib = (k) => (k[bits >> 3] >> (bits % 8 === 0 ? 4 : 0)) & 0x0f
      const inPrefix = (k) => {
        for (let b = 0; b < bits; b += 4) {
          const n = (k[b >> 3] >> (b % 8 === 0 ? 4 : 0)) & 0x0f
          const p = (prefix[b >> 3] >> (b % 8 === 0 ? 4 : 0)) & 0x0f
          if (n !== p) return false
        }
        return true
      }
      const mine = list.filter((k) => inPrefix(k) && nib(k) === i)
      const digest = b4a.alloc(32)
      for (const k of mine) for (let j = 0; j < 32; j++) digest[j] ^= k[j]
      if (parts[i].count !== mine.length || !b4a.equals(parts[i].digest, digest)) return false
    }
    return true
  }
  t.ok(check(b4a.alloc(0), 0), 'the whole set')
  const k = list[7]
  t.ok(check(k.subarray(0, 1), 4), 'one nibble deep')
  t.ok(check(k.subarray(0, 1), 8), 'two nibbles')
  t.ok(check(k.subarray(0, 2), 12), 'three nibbles')
  set.delete(list[0])
  t.is(set.size, 2999)
  t.absent(set.has(list[0]))
  t.ok(set.has(list[1]))
})

// Two peers exchanging messages in rounds until both are quiet; what each
// learns is added at once (as the gate would accept it).
function settle (a, b, { lie = null } = {}) {
  const sa = new Session(a)
  const sb = new Session(b)
  let toB = [sa.start()]
  let toA = []
  let rounds = 0
  let bytes = 0
  const size = (m) => (m.parts ? 4 + m.parts.length * 34 : 4 + m.keys.length * 32) + m.prefix.byteLength
  while (toA.length || toB.length) {
    rounds++
    const nextA = []
    const nextB = []
    for (const m of toB) {
      bytes += size(m)
      const r = m.parts ? { out: sb.onRanges(m), learn: [] } : sb.onKeys(m)
      for (const k of r.learn) b.add(k)
      nextA.push(...r.out)
    }
    for (let m of toA) {
      if (lie) m = lie(m)
      bytes += size(m)
      const r = m.parts ? { out: sa.onRanges(m), learn: [] } : sa.onKeys(m)
      for (const k of r.learn) a.add(k)
      nextB.push(...r.out)
    }
    toA = nextA
    toB = nextB
    if (rounds > 50) throw new Error('no end')
  }
  return { rounds, bytes }
}

for (const [shared, diff] of [[1000, 0], [1000, 1], [1000, 50], [200, 5000], [20000, 1]]) {
  test(`${shared} shared keys, ${diff} different: both end with the union`, (t) => {
    const common = keysOf(shared)
    const onlyA = keysOf(Math.ceil(diff / 2))
    const onlyB = keysOf(Math.floor(diff / 2))
    const a = setOf([...common, ...onlyA])
    const b = setOf([...common, ...onlyB])
    const { rounds, bytes } = settle(a, b)
    const union = new Set([...common, ...onlyA, ...onlyB].map(hex))
    t.is(a.size, union.size, 'a has the union')
    t.is(b.size, union.size, 'b has the union')
    const L = shared + diff
    const levels = Math.max(1, Math.ceil(Math.log(L / FEW) / Math.log(16)))
    if (diff === 0) t.is(rounds, 2, 'equal: one message and its done')
    if (diff === 1) t.ok(rounds <= levels + 4, `one difference: ${rounds} rounds (${levels} levels)`)
    if (diff === 1) t.ok(bytes < 3000, `one difference: ${bytes} bytes`)
  })
}

test('a peer whose keys don\'t match the counts it gave is ignored for that round', (t) => {
  const common = keysOf(2000) // a asks b for its keys two levels down, where b has a few
  const extra = keysOf(1)
  const a = setOf(common)
  const b = setOf([...common, ...extra])
  const junk = keysOf(3)
  // a's peer (b) answers a's request for its keys with made-up ones
  const out = settle(a, b, {
    lie: (m) => (m.keys && m.kind === 0 ? { ...m, keys: [...m.keys, ...junk.map((k) => { const x = b4a.from(k); x.set(m.prefix.subarray(0, m.prefix.byteLength)); return x })] } : m)
  })
  t.ok(out.rounds > 0)
  t.is(a.size, 2000, 'nothing learnt from the lying answer')
})

test('keys outside the range they claim are ignored', (t) => {
  const a = setOf(keysOf(10))
  const s = new Session(a)
  const outside = crypto.randomBytes(32)
  outside[0] = 0x00
  const r = s.onKeys({ prefix: b4a.from([0xf0]), bits: 4, kind: 2, keys: [outside] })
  t.is(r.learn.length, 0)
  t.ok(r.ignored)
})

test('a peer that doesn\'t take keys only offers its own', (t) => {
  const big = setOf(keysOf(2000))
  const mine = keysOf(1)
  const fresh = setOf(mine)
  const a = new Session(big)
  const b = new Session(fresh, { take: () => false })
  const out = b.onRanges(a.start())
  t.ok(out.every((m) => m.kind === 2 || m.kind === 3), 'only offers')
  t.is(out.reduce((n, m) => n + m.keys.length, 0), 1, 'its one key')
  const r = a.onKeys(out.find((m) => m.kind === 2))
  t.is(r.learn.length, 1)
  t.is(r.out.length, 0, 'nothing pushed back')
})

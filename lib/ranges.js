// Settling two log lists by key ranges (spec 016, US5, research R7: the
// Negentropy idea, kept minimal). Log keys are random 32 bytes, so a range is
// a prefix of `bits` bits (a multiple of 4); a `ranges` message gives the
// sender's count and XOR digest of each of its 16 sub-ranges (the next 4 bits).
// The receiver compares with its own: equal sub-ranges stop; a different one
// where either side holds at most FEW keys is settled with keys; the rest
// recurse. One new log among L costs about log16(L / FEW) messages of ~600 B.
//
// `keys` messages, by kind:
//   0  the sender's keys in the range: answer with yours they lack (2)
//   1  "send me yours": the sender saw at most FEW on your side (answered with 0)
//   2  keys the receiver lacks: nothing to answer
//   3  done: every answer to the sender's range or keys message (0, 1) was
//      sent before it, so the sender knows when an exchange is over
// An answer (0) to our "send me yours" must match the count and digest the
// peer gave for that range, or it is ignored for the round; keys outside the
// range they claim are ignored too. Whatever is learnt still goes through
// the gate (lib/gate.js) like any log key.
//
// Spec 017: each key comes with its log's length (`lengths`, one per key in
// keys messages), and a range's digest XORs `hash(key ‖ length)`, so a log a
// peer holds more of is found like a log it holds and this side lacks: "lack"
// is no entry with that key, or a shorter one. What is learnt is
// [{ key, length }].
//
// Pure: lib/directory.js sends the messages and considers what is learnt.

// Does this message wait for a `done` (kind 3) from the peer?
const answered = (m) => !!m.parts || m.kind === 0 || m.kind === 1

const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')

const PARTS = 16
const FEW = 32 // keys sent instead of recursing
const CHUNK = 1000 // keys per message
const MAX_BITS = 252 // the deepest prefix a range may have

const nibble = (key, bit) => (key[bit >> 3] >> (bit % 8 === 0 ? 4 : 0)) & 0x0f

// The smallest (fill 0) or largest (fill 0xff) key with this prefix.
function bound (prefix, bits, fill) {
  const out = b4a.alloc(32, fill)
  const whole = bits >> 3
  out.set(prefix.subarray(0, whole))
  if (bits % 8) out[whole] = (prefix[whole] & 0xf0) | (fill & 0x0f)
  return out
}

// The prefix of sub-range `i` of (prefix, bits).
function child (prefix, bits, i) {
  const out = b4a.alloc((bits + 4 + 7) >> 3)
  out.set(prefix.subarray(0, Math.min(prefix.byteLength, out.byteLength)))
  if (bits % 8 === 0) out[bits >> 3] = i << 4
  else out[bits >> 3] = (out[bits >> 3] & 0xf0) | i
  return out
}

function within (key, prefix, bits) {
  for (let b = 0; b < bits; b += 4) if (nibble(key, b) !== nibble(prefix, b)) return false
  return true
}

function valid (m) {
  if (m && m.prefix === null) m.prefix = b4a.alloc(0) // an empty buffer decodes as null
  return m && b4a.isBuffer(m.prefix) && Number.isInteger(m.bits) && m.bits >= 0 && m.bits <= MAX_BITS && m.bits % 4 === 0 && m.prefix.byteLength >= ((m.bits + 7) >> 3)
}

const hex = (b) => b4a.toString(b, 'hex')

// What an entry adds to a digest.
function itemOf (key, length) {
  return crypto.hash([key, c.encode(c.uint, length)])
}

const tag = (prefix, bits) => bits + ':' + b4a.toString(prefix.subarray(0, (bits + 7) >> 3), 'hex')

// The keys held, sorted, with their lengths: counts and digests of any range
// on demand; `digest`: the whole set's.
class Keys {
  constructor () {
    this.sorted = []
    this.entries = new Map() // hex -> { length, item }
    this.digest = b4a.alloc(32)
  }

  get size () { return this.sorted.length }

  #at (key) { // the first index whose key is >= key
    let lo = 0
    let hi = this.sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (b4a.compare(this.sorted[mid], key) < 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  has (key) {
    const i = this.#at(key)
    return i < this.sorted.length && b4a.equals(this.sorted[i], key)
  }

  // -1: not held.
  lengthOf (key) {
    const e = this.entries.get(hex(key))
    return e ? e.length : -1
  }

  add (key, length = 0) {
    this.set(key, length)
  }

  // Adds `key` with `length`, or changes its length.
  set (key, length) {
    const h = hex(key)
    const e = this.entries.get(h)
    if (e && e.length === length) return
    if (e) xor(this.digest, e.item)
    else this.sorted.splice(this.#at(key), 0, key)
    const item = itemOf(key, length)
    this.entries.set(h, { length, item })
    xor(this.digest, item)
  }

  delete (key) {
    const h = hex(key)
    const e = this.entries.get(h)
    if (!e) return
    xor(this.digest, e.item)
    this.entries.delete(h)
    this.sorted.splice(this.#at(key), 1)
  }

  // [start, end) of the keys with this prefix.
  #range (prefix, bits) {
    if (bits === 0) return [0, this.sorted.length]
    const start = this.#at(bound(prefix, bits, 0))
    let end = this.#at(bound(prefix, bits, 0xff))
    if (end < this.sorted.length && b4a.equals(this.sorted[end], bound(prefix, bits, 0xff))) end++
    return [start, end]
  }

  within (prefix, bits) {
    const [s, e] = this.#range(prefix, bits)
    return this.sorted.slice(s, e)
  }

  lengthsOf (keys) {
    return keys.map((k) => this.lengthOf(k))
  }

  count (prefix, bits) {
    const [s, e] = this.#range(prefix, bits)
    return e - s
  }

  // 16 × { count, digest } of the sub-ranges of (prefix, bits).
  parts (prefix, bits) {
    const out = Array.from({ length: PARTS }, () => ({ count: 0, digest: b4a.alloc(32) }))
    const [s, e] = this.#range(prefix, bits)
    for (let i = s; i < e; i++) {
      const key = this.sorted[i]
      const p = out[nibble(key, bits)]
      p.count++
      xor(p.digest, this.entries.get(hex(key)).item)
    }
    return out
  }
}

function xor (into, b) {
  for (let i = 0; i < 32; i++) into[i] ^= b[i]
}

function digestOf (keys, lengths) {
  const d = b4a.alloc(32)
  for (let i = 0; i < keys.length; i++) xor(d, itemOf(keys[i], lengths[i]))
  return d
}

// A keys message for these keys of `set`, with their lengths.
function keysMessage (set, prefix, bits, kind, keys) {
  return { prefix, bits, kind, keys, lengths: set.lengthsOf(keys) }
}

// One peer's side of the exchange with another. `take()` false: this peer
// doesn't want the other's keys (a newcomer to a big space reads by activity
// lists, story 9): it only offers its own (kind 2), never asks.
class Session {
  constructor (keys, { take = () => true } = {}) {
    this.keys = keys
    this.take = take
    this.expect = new Map() // tag -> the { count, digest } the peer gave for a range we asked keys of
  }

  start () {
    return { prefix: b4a.alloc(0), bits: 0, parts: this.keys.parts(b4a.alloc(0), 0) }
  }

  // A peer's ranges: what to send back.
  onRanges (m) {
    if (!valid(m) || !Array.isArray(m.parts) || m.parts.length !== PARTS || m.bits + 4 > MAX_BITS) return []
    const mine = this.keys.parts(m.prefix, m.bits)
    const out = []
    const done = { prefix: m.prefix, bits: m.bits, kind: 3, keys: [], lengths: [] }
    for (let i = 0; i < PARTS; i++) {
      const theirs = m.parts[i]
      if (theirs.count === mine[i].count && b4a.equals(theirs.digest, mine[i].digest)) continue
      const prefix = child(m.prefix, m.bits, i)
      const bits = m.bits + 4
      if (!this.take()) {
        if (mine[i].count > FEW) out.push({ prefix, bits, parts: this.keys.parts(prefix, bits) })
        else if (mine[i].count) out.push(keysMessage(this.keys, prefix, bits, 2, this.keys.within(prefix, bits)))
      } else if (theirs.count <= FEW) {
        this.expect.set(tag(prefix, bits), theirs)
        out.push({ prefix, bits, kind: 1, keys: [], lengths: [] })
      } else if (mine[i].count <= FEW) {
        out.push(keysMessage(this.keys, prefix, bits, 0, this.keys.within(prefix, bits)))
      } else {
        out.push({ prefix, bits, parts: this.keys.parts(prefix, bits) })
      }
    }
    out.push(done)
    return out
  }

  // A peer's keys: { out (to send back), learn ([{ key, length }]: logs to
  // consider, or held here shorter), ignored,
  // done (the end of the answers to one of ours) }.
  onKeys (m) {
    const none = { out: [], learn: [], ignored: true }
    if (!valid(m) || !Array.isArray(m.keys) || m.keys.length > CHUNK) return none
    if (m.kind === 3) return { out: [], learn: [], ignored: false, done: true }
    const done = { prefix: m.prefix, bits: m.bits, kind: 3, keys: [], lengths: [] }
    if (!m.keys.every((k) => b4a.isBuffer(k) && k.byteLength === 32 && within(k, m.prefix, m.bits))) return none
    if (!Array.isArray(m.lengths) || m.lengths.length !== m.keys.length || !m.lengths.every((n) => Number.isSafeInteger(n) && n >= 0)) return none
    if (m.kind === 1) {
      if (this.keys.count(m.prefix, m.bits) > FEW) return { out: [{ prefix: m.prefix, bits: m.bits, parts: this.keys.parts(m.prefix, m.bits) }, done], learn: [], ignored: false }
      return { out: [keysMessage(this.keys, m.prefix, m.bits, this.take() ? 0 : 2, this.keys.within(m.prefix, m.bits)), done], learn: [], ignored: false }
    }
    const learn = []
    for (let i = 0; i < m.keys.length; i++) if (m.lengths[i] > this.keys.lengthOf(m.keys[i])) learn.push({ key: m.keys[i], length: m.lengths[i] })
    if (m.kind === 2) return { out: [], learn, ignored: false }
    if (m.kind !== 0) return none
    const t = tag(m.prefix, m.bits)
    const expected = this.expect.get(t)
    this.expect.delete(t)
    if (expected && (expected.count !== m.keys.length || !b4a.equals(expected.digest, digestOf(m.keys, m.lengths)))) return { ...none, out: [done] }
    if (!expected && m.keys.length > FEW) return { ...none, out: [done] }
    const theirs = new Map(m.keys.map((k, i) => [hex(k), m.lengths[i]]))
    const lack = this.keys.within(m.prefix, m.bits).filter((k) => !(theirs.get(hex(k)) >= this.keys.lengthOf(k)))
    const out = []
    for (let i = 0; i < lack.length; i += CHUNK) out.push(keysMessage(this.keys, m.prefix, m.bits, 2, lack.slice(i, i + CHUNK)))
    out.push(done)
    return { out, learn, ignored: false }
  }
}

module.exports = { Keys, Session, child, within, answered, itemOf, FEW, PARTS, CHUNK }

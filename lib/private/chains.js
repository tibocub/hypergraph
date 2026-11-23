// Secure conversations (a private space with `history: 'hidden'`): one chain per
// writer log per epoch, a message key per record, and the device's own key
// store that never leaves it.
//
// - An epoch key reaches a device sealed to one of its prekeys (a fresh X25519
//   key it publishes in its log). The device derives one chain start per
//   writer log the epoch lists, stores them, then erases the epoch key; the
//   prekey's secret goes SPENT_MS later (two deciders changing the key at
//   once both seal to it).
// - Chain start: keyed BLAKE2b of (domain, space, log, commitment) under the
//   epoch key. Step n: MK_n = KDF(CK_n, 1), CK_{n+1} = KDF(CK_n, 2)
//   (crypto_kdf, BLAKE2b). A step's chain key is erased once the next one is.
// - Order, for crashes: the new state is stored before the old one is erased,
//   and a sender stores CK_{n+1} before appending record n. A crash loses a
//   step (readers see a skipped index), never reuses one.
// Erasure is best effort: JavaScript may keep copies of a buffer, and a
// database may keep deleted rows on disk for a while (the vault's job).

const sodium = require('sodium-universal')
const b4a = require('b4a')
const c = require('compact-encoding')

const KEY = 32
const CTX = b4a.from('hgchain1') // crypto_kdf context: 8 bytes
const CHAIN_DOMAIN = b4a.from('hypergraph/chain\0')

const MAX_INDEX = 65535 // a chain index past this in one epoch is refused
const MAX_SKIPPED = 100000 // skipped keys per space; the oldest go first
const SKIP_MS = 90 * 24 * 3600 * 1000 // a skipped key, or an old epoch's chain, unused this long is erased
const ROTATE_MS = 7 * 24 * 3600 * 1000 // a decider changes the key this often
const ROTATE_RECORDS = 1000 // or after this many records by one writer
const ASK_AGAIN_MS = 7 * 24 * 3600 * 1000 // a resend request is made again after this
const GIVE_UP_MS = 30 * 24 * 3600 * 1000 // and the record counts as gone this long after the first
const RESEND_BYTES = 1024 * 1024 // what an author resends per space per day
const DAY_MS = 24 * 3600 * 1000
const MAX_RESEND = 1000 // records per resend request
const SPENT_MS = 30000 // a prekey that opened a grant is kept this long: another decider's grant of the same moment may follow

/**
 * @typedef {{ ck: Uint8Array, n: number, epoch: number, at: number, newer: number }} Chain `newer`: the first block of its log sealed in a newer epoch (0: none seen).
 * @typedef {{ mk: Uint8Array, at: number }} Key `at`: the record's stamp (a kept key) or when it was skipped.
 * @typedef {{ since: number, asked: number }} Missing
 * @typedef {[string, Uint8Array | null][]} Ops Rows to write (null: delete), by name.
 */

/**
 * @param {Uint8Array} epochKey
 * @param {Uint8Array} space
 * @param {Uint8Array} log
 * @param {Uint8Array} commit The epoch's full commitment.
 * @returns {Uint8Array}
 */
function chainStart (epochKey, space, log, commit) {
  const out = b4a.alloc(KEY)
  sodium.crypto_generichash(out, b4a.concat([CHAIN_DOMAIN, space, log, commit]), epochKey)
  return out
}

/**
 * @param {Uint8Array} ck
 * @returns {{ mk: Uint8Array, next: Uint8Array }}
 */
function step (ck) {
  const mk = b4a.alloc(KEY)
  const next = b4a.alloc(KEY)
  sodium.crypto_kdf_derive_from_key(mk, 1, CTX, ck)
  sodium.crypto_kdf_derive_from_key(next, 2, CTX, ck)
  return { mk, next }
}

/** @param {Uint8Array | null | undefined} buf */
function wipe (buf) {
  if (buf) sodium.sodium_memzero(buf)
}

/** @returns {{ publicKey: Uint8Array, secretKey: Uint8Array }} */
function boxPair () {
  const publicKey = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_box_SECRETKEYBYTES)
  sodium.crypto_box_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

// Rows: fixed 32-byte keys then unsigned numbers.
/**
 * @param {Uint8Array[]} keys
 * @param {number[]} nums
 */
function row (keys, nums) {
  const state = { start: 0, end: 0, buffer: /** @type {Uint8Array | null} */ (null) }
  for (const k of keys) c.fixed32.preencode(state, k)
  for (const n of nums) c.uint.preencode(state, n)
  state.buffer = b4a.alloc(state.end)
  for (const k of keys) c.fixed32.encode(state, k)
  for (const n of nums) c.uint.encode(state, n)
  return state.buffer
}

/**
 * @param {Uint8Array} bytes
 * @param {number} keys
 * @returns {{ keys: Uint8Array[], nums: number[] }}
 */
function unrow (bytes, keys) {
  const state = { start: 0, end: bytes.byteLength, buffer: bytes }
  const out = { keys: /** @type {Uint8Array[]} */ ([]), nums: /** @type {number[]} */ ([]) }
  for (let i = 0; i < keys; i++) out.keys.push(b4a.from(c.fixed32.decode(state))) // a copy of its own: wiped later
  while (state.start < state.end) out.nums.push(c.uint.decode(state))
  return out
}

// One space's keys on this device. Kept in memory (records open
// synchronously) and mirrored to rows the caller stores (`write`), never
// replicated.
class KeyStore {
  /**
   * @param {{ now?: () => number, write?: (ops: Ops) => Promise<void> }} [opts]
   */
  constructor ({ now = Date.now, write = async () => {} } = {}) {
    this.now = now
    this.write = write
    /** @type {Map<number, { publicKey: Uint8Array, secretKey: Uint8Array, published: boolean, spent: number }>} */
    this.prekeys = new Map() // n -> pair; `spent`: when it opened a grant (0: unused)
    this.nextPrekey = 0
    /** @type {Map<string, number>} */
    this.epochs = new Map() // commitment (short hex) -> epoch, for each epoch whose chains were derived here
    /** @type {Map<string, Chain>} */
    this.chains = new Map() // `${commit}:${log hex}`
    /** @type {Map<string, Key>} */
    this.kept = new Map() // `${log hex}:${seq}`: the key of a record kept here
    /** @type {Map<string, Key>} */
    this.skipped = new Map() // `${commit}:${log hex}:${n}`, oldest first
    /** @type {Set<string>} */
    this.erased = new Set() // `${log hex}:${seq}`: keys erased on purpose (deleted, cut): never asked for again
    /** @type {Map<string, Missing>} */
    this.missing = new Map() // `${log hex}:${seq}`: a key this device should hold and doesn't
    /** @type {Map<string, { secretKey: Uint8Array, at: number }>} */
    this.replies = new Map() // a resend request's id (hex) -> its one-time reply key
    /** @type {Map<string, number>} */
    this.answered = new Map() // `${log hex}:${seq}:${device z32}` -> when
    this.day = { day: 0, bytes: 0 } // resend bytes sent today
    /** @type {Map<string, Uint8Array | null>} */
    this.pending = new Map()
    /** @type {Promise<void>} */
    this.flushing = Promise.resolve()
    this.timer = null
  }

  /**
   * @param {Iterable<{ name: string, value: Uint8Array }>} rows
   * @param {{ now?: () => number, write?: (ops: Ops) => Promise<void> }} [opts]
   */
  static load (rows, opts) {
    const ks = new KeyStore(opts)
    /** @type {[string, Key][]} */
    const skipped = []
    for (const { name, value } of rows) {
      const [kind, ...rest] = name.split(':')
      if (kind === 'p') {
        const { keys: [publicKey, secretKey], nums: [pub, spent = 0] } = unrow(value, 2)
        ks.prekeys.set(Number(rest[0]), { publicKey, secretKey, published: !!pub, spent })
      } else if (kind === 'pn') ks.nextPrekey = unrow(value, 0).nums[0]
      else if (kind === 'k') ks.epochs.set(rest[0], unrow(value, 0).nums[0])
      else if (kind === 'c') {
        const { keys: [ck], nums: [n, epoch, at, newer = 0] } = unrow(value, 1)
        ks.chains.set(rest.join(':'), { ck, n, epoch, at, newer })
      } else if (kind === 'm') {
        const { keys: [mk], nums: [at] } = unrow(value, 1)
        ks.kept.set(rest.join(':'), { mk, at })
      } else if (kind === 's') {
        const { keys: [mk], nums: [at] } = unrow(value, 1)
        skipped.push([rest.join(':'), { mk, at }])
      } else if (kind === 'e') ks.erased.add(rest.join(':'))
      else if (kind === 'g') {
        const { nums: [since, asked] } = unrow(value, 0)
        ks.missing.set(rest.join(':'), { since, asked })
      } else if (kind === 'q') {
        const { keys: [secretKey], nums: [at] } = unrow(value, 1)
        ks.replies.set(rest[0], { secretKey, at })
      } else if (kind === 'a') ks.answered.set(rest.join(':'), unrow(value, 0).nums[0])
      else if (kind === 'd') {
        const { nums: [day, bytes] } = unrow(value, 0)
        ks.day = { day, bytes }
      }
    }
    skipped.sort((a, b) => a[1].at - b[1].at)
    for (const [k, v] of skipped) ks.skipped.set(k, v)
    // a store that writes (the device's, not a copy) erases at once the
    // prekeys spent before it closed: it may have closed days ago
    if (opts && opts.write && ks.eraseSpent()) ks.flushLater()
    return ks
  }

  /**
   * @param {string} name
   * @param {Uint8Array | null} value
   */
  #put (name, value) {
    this.pending.set(name, value)
  }

  // Stores what changed; resolves once it is on disk.
  flush () {
    const run = this.flushing.then(async () => {
      if (!this.pending.size) return
      const ops = [...this.pending]
      this.pending = new Map()
      // the new state before the erasures: one transaction, but in that order too
      ops.sort((a, b) => (a[1] === null ? 1 : 0) - (b[1] === null ? 1 : 0))
      await this.write(ops)
    })
    this.flushing = run.catch(() => {})
    return run
  }

  flushLater () {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush().catch(() => {})
    }, 0)
  }

  close () {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  // Prekeys.

  /** @returns {{ n: number, publicKey: Uint8Array }} */
  newPrekey () {
    const n = this.nextPrekey++
    const pair = boxPair()
    this.prekeys.set(n, { ...pair, published: false, spent: 0 })
    this.#put('p:' + n, row([pair.publicKey, pair.secretKey], [0]))
    this.#put('pn', row([], [this.nextPrekey]))
    // only the two newest unused ones are kept
    const unused = [...this.prekeys].filter(([, p]) => !p.spent).map(([k]) => k)
    for (const old of unused.sort((a, b) => a - b).slice(0, -2)) this.usePrekey(old)
    return { n, publicKey: pair.publicKey }
  }

  /** @param {number} n */
  published (n) {
    const p = this.prekeys.get(n)
    if (!p || p.published) return
    p.published = true
    this.#put('p:' + n, row([p.publicKey, p.secretKey], [1]))
  }

  // The prekeys spent SPENT_MS ago or more, erased; whether there were any.
  eraseSpent () {
    const now = this.now()
    const due = [...this.prekeys].filter(([, p]) => p.spent && now - p.spent >= SPENT_MS)
    for (const [n] of due) this.usePrekey(n)
    return due.length > 0
  }

  // It opened a grant: erased SPENT_MS later (sweep, or the next load).
  /** @param {number} n */
  spendPrekey (n) {
    const p = this.prekeys.get(n)
    if (!p || p.spent) return
    p.spent = this.now()
    this.#put('p:' + n, row([p.publicKey, p.secretKey], [p.published ? 1 : 0, p.spent]))
  }

  /** @param {number} n */
  prekey (n) {
    return this.prekeys.get(n) || null
  }

  /** @param {number} n */
  usePrekey (n) {
    const p = this.prekeys.get(n)
    if (!p) return
    wipe(p.secretKey)
    this.prekeys.delete(n)
    this.#put('p:' + n, null)
  }

  // Epochs and chains.

  /** @param {string} commit */
  knows (commit) {
    return this.epochs.has(commit)
  }

  /**
   * An epoch key opened (or made) here: a chain start for each writer log it
   * lists. The caller erases the key afterwards (and spends the prekey it
   * came by), once this is stored.
   * @param {Uint8Array} epochKey
   * @param {{ epoch: number, commit: Uint8Array, space: Uint8Array, logs: Uint8Array[] }} epoch
   */
  addEpoch (epochKey, { epoch, commit, space, logs }) {
    const short = b4a.toString(commit.subarray(0, 8), 'hex')
    if (this.epochs.has(short)) return
    const at = this.now()
    for (const log of logs) this.#setChain(short + ':' + b4a.toString(log, 'hex'), { ck: chainStart(epochKey, space, log, commit), n: 0, epoch, at, newer: 0 })
    this.epochs.set(short, epoch)
    this.#put('k:' + short, row([], [epoch]))
  }

  /**
   * @param {string} k
   * @param {Chain} ch
   */
  #setChain (k, ch) {
    const old = this.chains.get(k)
    if (old && old.ck !== ch.ck) wipe(old.ck)
    this.chains.set(k, ch)
    this.#put('c:' + k, row([ch.ck], [ch.n, ch.epoch, ch.at, ch.newer]))
  }

  /** @param {string} k */
  #dropChain (k) {
    const ch = this.chains.get(k)
    if (!ch) return
    wipe(ch.ck)
    this.chains.delete(k)
    this.#put('c:' + k, null)
  }

  /**
   * @param {string} commit
   * @param {string} log
   */
  chain (commit, log) {
    return this.chains.get(commit + ':' + log) || null
  }

  // The message key of record `n` of `log`'s chain in an epoch: a skipped
  // one, or the chain moved on to it (the keys stepped over kept as
  // skipped). null: no chain, an index past the cap, or a key already used
  // or erased. `seq` (a reader's): where the record is, to know when an older
  // epoch's chain of that log is done with.
  /**
   * @param {string} commit
   * @param {string} log
   * @param {number} n
   * @param {number} [seq]
   * @returns {Uint8Array | null}
   */
  messageKey (commit, log, n, seq = 0) {
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_INDEX) return null
    const sk = commit + ':' + log + ':' + n
    const got = this.skipped.get(sk)
    if (got) {
      this.skipped.delete(sk)
      this.#put('s:' + sk, null)
      this.#newer(commit, log, seq)
      return got.mk
    }
    const k = commit + ':' + log
    const ch = this.chains.get(k)
    if (!ch || n < ch.n) return null
    let ck = ch.ck
    let mk = null
    const at = this.now()
    for (let i = ch.n; i <= n; i++) {
      const s = step(ck)
      if (ck !== ch.ck) wipe(ck)
      ck = s.next
      if (i === n) mk = s.mk
      else this.#skip(commit + ':' + log + ':' + i, { mk: s.mk, at })
    }
    this.#setChain(k, { ...ch, ck, n: n + 1, at })
    this.#newer(commit, log, seq)
    return mk
  }

  /**
   * @param {string} k
   * @param {Key} key
   */
  #skip (k, key) {
    this.skipped.set(k, key)
    this.#put('s:' + k, row([key.mk], [key.at]))
    while (this.skipped.size > MAX_SKIPPED) {
      const [oldest, v] = /** @type {[string, Key]} */ (this.skipped.entries().next().value)
      wipe(v.mk)
      this.skipped.delete(oldest)
      this.#put('s:' + oldest, null)
    }
  }

  // A record of `log` in a newer epoch than some of its chains, at `seq`.
  /**
   * @param {string} commit
   * @param {string} log
   * @param {number} seq
   */
  #newer (commit, log, seq) {
    const epoch = this.epochs.get(commit)
    if (!seq || epoch === undefined) return
    for (const [k, ch] of this.chains) {
      if (!k.endsWith(':' + log) || ch.epoch >= epoch || (ch.newer && ch.newer <= seq)) continue
      this.#setChain(k, { ...ch, newer: seq })
    }
  }

  // Record keys.

  /**
   * @param {string} log
   * @param {number} seq
   */
  keyOf (log, seq) {
    const k = this.kept.get(log + ':' + seq)
    return k ? k.mk : null
  }

  /**
   * @param {string} log
   * @param {number} seq
   * @param {Uint8Array} mk
   * @param {number} stamp
   */
  keep (log, seq, mk, stamp) {
    const k = log + ':' + seq
    const old = this.kept.get(k)
    if (old && b4a.equals(old.mk, mk)) return
    this.kept.set(k, { mk, at: stamp })
    this.#put('m:' + k, row([mk], [stamp]))
    if (this.missing.delete(k)) this.#put('g:' + k, null)
  }

  // A record's key erased on purpose (deleted by its author, cut): never
  // asked for again.
  /**
   * @param {string} log
   * @param {number} seq
   */
  erase (log, seq) {
    const k = log + ':' + seq
    const old = this.kept.get(k)
    if (old) {
      wipe(old.mk)
      this.kept.delete(k)
      this.#put('m:' + k, null)
    }
    if (this.missing.delete(k)) this.#put('g:' + k, null)
    if (!this.erased.has(k)) {
      this.erased.add(k)
      this.#put('e:' + k, b4a.alloc(0))
    }
  }

  /**
   * @param {string} log
   * @param {number} seq
   */
  wasErased (log, seq) {
    return this.erased.has(log + ':' + seq)
  }

  // Erases the keys of records that are gone anyway (trimmed, past the
  // disappearing timer): `gone(log, seq, stamp)`.
  /**
   * @param {(log: string, seq: number, stamp: number) => boolean} gone
   */
  eraseWhere (gone) {
    for (const [k, v] of this.kept) {
      const at = k.lastIndexOf(':')
      if (!gone(k.slice(0, at), Number(k.slice(at + 1)), v.at)) continue
      wipe(v.mk)
      this.kept.delete(k)
      this.#put('m:' + k, null)
    }
    for (const k of this.missing.keys()) {
      const at = k.lastIndexOf(':')
      if (gone(k.slice(0, at), Number(k.slice(at + 1)), Infinity)) {
        this.missing.delete(k)
        this.#put('g:' + k, null)
      }
    }
  }

  // Resends.

  // A record this device should read and can't any more (its key expired or
  // its chain dropped): noted the first time. Its state: 'ask' (now),
  // 'wait', or 'gone' (no answer for GIVE_UP_MS).
  /**
   * @param {string} log
   * @param {number} seq
   * @returns {'ask' | 'wait' | 'gone'}
   */
  lacks (log, seq) {
    const k = log + ':' + seq
    const now = this.now()
    let m = this.missing.get(k)
    if (!m) {
      m = { since: now, asked: 0 }
      this.missing.set(k, m)
      this.#put('g:' + k, row([], [m.since, m.asked]))
    }
    if (now - m.since >= GIVE_UP_MS) return 'gone'
    return !m.asked || now - m.asked >= ASK_AGAIN_MS ? 'ask' : 'wait'
  }

  /**
   * @param {string[]} keys `${log hex}:${seq}`
   */
  asked (keys) {
    const now = this.now()
    for (const k of keys) {
      const m = this.missing.get(k)
      if (!m) continue
      m.asked = now
      this.#put('g:' + k, row([], [m.since, m.asked]))
    }
  }

  /** @returns {{ id: string, publicKey: Uint8Array }} */
  newReply () {
    const pair = boxPair()
    const id = b4a.toString(pair.publicKey, 'hex')
    this.replies.set(id, { secretKey: pair.secretKey, at: this.now() })
    this.#put('q:' + id, row([pair.secretKey], [this.now()]))
    return { id, publicKey: pair.publicKey }
  }

  /** @param {string} id */
  dropReply (id) {
    const r = this.replies.get(id)
    if (!r) return
    wipe(r.secretKey)
    this.replies.delete(id)
    this.#put('q:' + id, null)
  }

  /** @param {string} id */
  reply (id) {
    const r = this.replies.get(id)
    return r ? { publicKey: b4a.from(id, 'hex'), secretKey: r.secretKey } : null
  }

  // May this device answer `device` for this record, within today's budget
  // of `bytes`? Counted if so.
  /**
   * @param {string} log
   * @param {number} seq
   * @param {string} device
   * @param {number} bytes
   */
  mayAnswer (log, seq, device, bytes) {
    const k = log + ':' + seq + ':' + device
    if (this.answered.has(k)) return false
    const day = Math.floor(this.now() / DAY_MS)
    if (this.day.day !== day) this.day = { day, bytes: 0 }
    if (this.day.bytes + bytes > RESEND_BYTES) return false
    this.day.bytes += bytes
    this.#put('d', row([], [this.day.day, this.day.bytes]))
    this.answered.set(k, this.now())
    this.#put('a:' + k, row([], [this.now()]))
    return true
  }

  // Expiry: skipped keys and reply keys unused for SKIP_MS; the chains of an
  // epoch other than `current` unused that long, or done with (`readTo(log)`:
  // the blocks of a log read without a gap: every block before its first one
  // in a newer epoch read); answered pairs after GIVE_UP_MS.
  /**
   * @param {{ current?: string | null, readTo?: (log: string) => number }} [opts]
   */
  sweep ({ current = null, readTo = () => 0 } = {}) {
    const now = this.now()
    this.eraseSpent()
    for (const [k, v] of this.skipped) {
      if (now - v.at < SKIP_MS) break // oldest first
      wipe(v.mk)
      this.skipped.delete(k)
      this.#put('s:' + k, null)
    }
    for (const [k, ch] of this.chains) {
      const [commit, log] = k.split(':')
      if (commit === current) continue
      if (now - ch.at >= SKIP_MS || (ch.newer && readTo(log) >= ch.newer)) this.#dropChain(k)
    }
    for (const [id, r] of this.replies) {
      if (now - r.at < SKIP_MS) continue
      wipe(r.secretKey)
      this.replies.delete(id)
      this.#put('q:' + id, null)
    }
    for (const [k, at] of this.answered) {
      if (now - at < GIVE_UP_MS) continue
      this.answered.delete(k)
      this.#put('a:' + k, null)
    }
  }
}

module.exports = { KeyStore, chainStart, step, wipe, MAX_INDEX, MAX_SKIPPED, SKIP_MS, ROTATE_MS, ROTATE_RECORDS, ASK_AGAIN_MS, GIVE_UP_MS, RESEND_BYTES, MAX_RESEND, DAY_MS, SPENT_MS }

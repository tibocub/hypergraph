const crypto = require('crypto')
const hcrypto = require('hypercore-crypto')
const b4a = require('b4a')
const { message } = require('./encodings')

// An author's messages for one channel (spec 007, research R5): a plain
// Hypercore, signed by a key pair derived from the author's identity, the
// community and the channel, so any of the author's devices reopens the
// same log. Messages need no signature of their own: Hypercore signs the log.

class AuthorLog {
  /**
   * @param {Object} store - Corestore
   * @param {{ keyPair?: Object, key?: Buffer }} opts - keyPair to write, key to read
   */
  constructor (store, { keyPair = null, key = null } = {}) {
    this.core = keyPair ? store.get({ keyPair }) : store.get({ key })
    this.lastT = 0
  }

  static keyPairFor (identity, communityKey, channelId) {
    const seed = identity.seed || crypto.createHash('sha256').update(identity.keyPair.secretKey).digest()
    const derived = crypto.createHash('sha256')
      .update('hg-v2-log\0').update(seed).update(communityKey).update(b4a.from(channelId))
      .digest()
    return hcrypto.keyPair(derived)
  }

  get key () { return this.core.key }
  get length () { return this.core.length }
  get writable () { return this.core.writable }

  async ready () {
    await this.core.ready()
    if (this.core.writable && this.core.length > 0) this.lastT = (await this.get(this.core.length - 1)).t
  }

  async close () { await this.core.close() }
  async update (opts) { return this.core.update(opts) }

  async append ({ text, reply = null }) {
    return this.appendRaw({ t: this.nextT(), text, reply })
  }

  /** The time the next message gets: now, never before the last one. */
  nextT () {
    return Math.max(Date.now(), this.lastT)
  }

  /** Append a message with the given time, as-is (tests, bulk history). */
  async appendRaw (m) {
    const block = message.encode(m.box ? { t: m.t, epoch: m.epoch, nonce: m.nonce, box: m.box } : m.reply ? m : { t: m.t, text: m.text })
    const { length } = await this.core.append(block)
    this.lastT = Math.max(this.lastT, m.t)
    return { seq: length - 1, t: m.t }
  }

  /** Append many messages at once (one write; bulk history for benchmarks). */
  async appendMany (messages) {
    const { length } = await this.core.append(messages.map(m => message.encode(m)))
    for (const m of messages) this.lastT = Math.max(this.lastT, m.t)
    return length - messages.length
  }

  async get (seq, opts) {
    const block = await this.core.get(seq, opts)
    return block ? { ...message.decode(block), seq } : null
  }

  /**
   * Messages [start, end), with times made non-decreasing: a block claiming
   * an earlier time than its predecessor is shown at the predecessor's time.
   */
  async range (start, end, opts) {
    const out = []
    let floor = 0
    if (start > 0) {
      const before = await this.get(start - 1, opts)
      if (before) floor = before.t
    }
    for (let i = start; i < end; i++) {
      const m = await this.get(i, opts)
      if (!m) break
      if (m.t < floor) m.t = floor
      floor = m.t
      out.push(m)
    }
    return out
  }

  /** The last `n` messages, newest first. */
  async tail (n) {
    const end = this.core.length
    const start = Math.max(0, end - n)
    return (await this.range(start, end)).reverse()
  }
}

module.exports = { AuthorLog }

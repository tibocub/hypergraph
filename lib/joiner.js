// A newcomer to a private space gets its disk key
// before opening anything of it. Opened without the key, the space would
// write its log header in the clear and read ciphertext as decisions. So the
// joiner takes the space's topic and opens a bare space channel
// (lib/directory.js: same protocol, id and capability handshake), sends the
// redemption, and waits for the key a decider sends once it recorded it,
// sealed to this device (or the code of its refusal). A key not matching the link's commitment is
// ignored. The space then opens as usual, with the key.

const c = require('compact-encoding')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const safetyCatch = require('safety-catch')
const enc = require('./encodings.js')
const pc = require('./private/crypto.js')
const { PROTOCOL, KEY_MESSAGE, capability } = require('./directory.js')

const REFUSALS = ['INVITE_EXPIRED', 'INVITE_USED_UP', 'INVITE_REVOKED', 'NOT_ALLOWED', 'CIRCLE_FULL']

/**
 * @typedef {import('./directory.js').SpaceChannel} SpaceChannel
 * @typedef {import('./private/crypto.js').KeyAnswer} KeyAnswer
 */
class Joiner {
  /**
   * @param {{ key: Uint8Array, redemption: Uint8Array, commit: Uint8Array, device: import('./identity.js').KeyPair }} opts
   */
  constructor ({ key, redemption, commit, device }) {
    this.keyBytes = key
    this.hex = b4a.toString(key, 'hex')
    this.discoveryKey = crypto.discoveryKey(key)
    this.redemption = redemption
    this.commit = commit
    this.box = pc.boxKeyPair(device)
    /** @type {Set<import('protomux').Channel>} */
    this.channels = new Set()
    this.closed = false
    this._pinned = false
    this._used = Date.now()
    /** @type {Uint8Array | null} */
    this.key = null
    /** @type {string | null} */
    this.refused = null
    /** @type {(answer: KeyAnswer | null) => void} */
    this._done = /** @type {(answer: KeyAnswer | null) => void} */ (/** @type {unknown} */ (null)) // set by the executor below
    /** @type {Promise<KeyAnswer | null>} */
    this.got = new Promise((resolve) => { this._done = resolve })
  }

  get directory () { return this }
  get peers () { return this.channels.size }

  /**
   * @param {import('protomux')} mux
   */
  attach (mux) {
    if (this.closed) return
    const ch = /** @type {import('protomux').Channel} */ (mux.createChannel({
      protocol: PROTOCOL,
      id: this.discoveryKey,
      handshake: c.fixed32,
      onopen: (proof) => {
        if (!b4a.equals(proof, capability(!mux.stream.isInitiator, this.keyBytes, mux.stream))) return ch.close()
        this.channels.add(ch)
        ch.messages[5].send({ redemption: this.redemption })
      },
      onclose: () => this.channels.delete(ch)
    }))
    if (!ch) return
    // The space channel's messages, in order: only the redeem (5) is sent and
    // the disk key read; the others are let through unread.
    for (let i = 0; i < KEY_MESSAGE; i++) ch.addMessage({ encoding: i === 5 ? enc.redeem : c.raw })
    ch.addMessage({ encoding: c.buffer, onmessage: (sealed) => this.#onKey(sealed) })
    ch.open(capability(mux.stream.isInitiator, this.keyBytes, mux.stream))
  }

  // A decider's answer: the disk key (checked against the link's
  // commitment), or a refusal's code. shortcut: a refusal is believed from
  // any peer that knows the space key (a link holder could fake one; it can
  // only make the join fail, as dropping the redemption would).
  /**
   * @param {Uint8Array} sealed
   */
  #onKey (sealed) {
    const answer = pc.readAnswer(pc.openSealed(sealed, this.box))
    if (!answer || this.key || this.refused) return
    if (answer.key && b4a.equals(pc.diskCommit(answer.key), this.commit)) {
      this.key = answer.key
      this._done(answer)
    } else if (answer.refused && REFUSALS.includes(answer.refused)) {
      this.refused = answer.refused
      this._done(answer)
    }
  }

  /**
   * @param {number} ms
   * @returns {Promise<KeyAnswer | null>}
   */
  async wait (ms) {
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null
    const key = await Promise.race([this.got, new Promise((resolve) => { timer = setTimeout(resolve, ms, null) })])
    clearTimeout(timer)
    return key
  }

  close () {
    this.closed = true
    this._done(null)
    for (const ch of this.channels) {
      try { ch.close() } catch (err) { safetyCatch(err) }
    }
    this.channels.clear()
  }
}

module.exports = { Joiner }

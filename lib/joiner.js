// Spec 022 (research.md R2): a newcomer to a private space gets its disk key
// before opening anything of it. Opened without the key, the space would
// write its log header in the clear and read ciphertext as decisions. So the
// joiner takes the space's topic and opens a bare space channel
// (lib/directory.js: same protocol, id and capability handshake), sends the
// redemption, and waits for the key a decider sends once it recorded it,
// sealed to this device. A key not matching the link's commitment is
// ignored. The space then opens as usual, with the key.

const c = require('compact-encoding')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const safetyCatch = require('safety-catch')
const enc = require('./encodings.js')
const pc = require('./private/crypto.js')
const { PROTOCOL, KEY_MESSAGE, capability } = require('./directory.js')

class Joiner {
  // key: the space's (a sub-space's own); redemption: its encoding; commit:
  // the link's commitment to the disk key; device: this device's key pair.
  constructor ({ key, redemption, commit, device }) {
    this.keyBytes = key
    this.hex = b4a.toString(key, 'hex')
    this.discoveryKey = crypto.discoveryKey(key)
    this.redemption = redemption
    this.commit = commit
    this.box = pc.boxKeyPair(device)
    this.channels = new Set()
    this.closed = false
    this._pinned = false
    this._used = Date.now()
    this.key = null
    this._done = null
    this.got = new Promise((resolve) => { this._done = resolve })
  }

  // What lib/network.js looks for on a space: its "directory" (this) and peers.
  get directory () { return this }
  get peers () { return this.channels.size }

  attach (mux) {
    if (this.closed) return
    const ch = mux.createChannel({
      protocol: PROTOCOL,
      id: this.discoveryKey,
      handshake: c.fixed32,
      onopen: (proof) => {
        if (!b4a.equals(proof, capability(!mux.stream.isInitiator, this.keyBytes, mux.stream))) return ch.close()
        this.channels.add(ch)
        ch.messages[5].send({ redemption: this.redemption })
      },
      onclose: () => this.channels.delete(ch)
    })
    if (!ch) return
    // The space channel's messages, in order: only the redeem (5) is sent and
    // the disk key read; the others are let through unread.
    for (let i = 0; i < KEY_MESSAGE; i++) ch.addMessage({ encoding: i === 5 ? enc.redeem : c.raw })
    ch.addMessage({ encoding: c.buffer, onmessage: (sealed) => this.#onKey(sealed) })
    ch.open(capability(mux.stream.isInitiator, this.keyBytes, mux.stream))
  }

  #onKey (sealed) {
    const key = pc.openSealed(sealed, this.box)
    if (!key || this.key || !b4a.equals(pc.diskCommit(key), this.commit)) return
    this.key = key
    this._done(key)
  }

  // The disk key, or null after `ms`.
  async wait (ms) {
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

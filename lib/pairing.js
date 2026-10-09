// Join by code (research R9, A7): blind-pairing (Holepunch's pairing library)
// over the instance's own swarm. A device already in shows a code; the new
// device, opened with it, sends its device key and name, and receives the
// identity and its recovery phrase in blind-pairing's reply, which is
// encrypted to it, with the personal space's key and encryption key. It then
// proves itself from the phrase, as a restore does. A code works once, until
// it expires. blind-pairing doesn't tell a refused candidate (it keeps
// asking: T002), so joining has its own time limit.

const BlindPairing = require('blind-pairing')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const z32 = require('z32')
const safetyCatch = require('safety-catch')
const enc = require('./encodings.js')
const { HypergraphError } = require('./errors.js')

const POLL_MS = 1000 // how often each side looks on the DHT while pairing
const ADD_MS = 10 * 60 * 1000 // a code nobody used expires
const JOIN_MS = 60000
const LINGER_MS = 5000 // the adding side stays a moment after confirming, for the reply to go out

const request = enc.struct([['device', c.fixed32], ['name', c.string]])
const reply = enc.struct([['identity', c.fixed32], ['phrase', c.string]])

class Pairing {
  constructor (swarm) {
    this.blind = new BlindPairing(swarm, { poll: POLL_MS })
    this.timers = new Set()
    this.waiting = new Set() // resolve(null) of codes not used yet
    this.current = null // closes the latest code's listener (a new code replaces it)
    this.closed = false
  }

  // A code for a new device. `added` resolves to { publicKey, name } once a
  // device used it, or null when it expires or the instance closes.
  // One code at a time (blind-pairing listens once per account): a new code
  // replaces the previous one, whose `added` resolves to null if unused.
  async add ({ key, encryptionKey, identity, phrase, timeout = ADD_MS }) {
    if (this.current) await this.current()
    const { invite, publicKey, discoveryKey, seed } = BlindPairing.createInvite(key)
    let used = false
    let done = null
    const added = new Promise((resolve) => { done = resolve })
    const finish = (result, linger) => {
      if (!done) return
      const resolve = done
      done = null
      this.waiting.delete(expire)
      clearTimeout(expiry)
      this.#later(() => member.close().catch(safetyCatch), linger)
      resolve(result)
    }
    const expire = () => finish(null, 0)
    const member = this.blind.addMember({
      discoveryKey,
      onadd: async (candidate) => {
        const userData = candidate.open(publicKey)
        let req = null
        try { req = c.decode(request, userData) } catch {}
        if (used || !req) return candidate.deny()
        used = true
        const data = c.encode(reply, { identity, phrase })
        candidate.confirm({ key, encryptionKey, additional: { data, signature: crypto.sign(data, crypto.keyPair(seed).secretKey) } })
        finish({ publicKey: z32.encode(req.device), name: req.name }, LINGER_MS)
      }
    })
    const expiry = this.#later(expire, timeout)
    this.waiting.add(expire)
    const replace = this.current = async () => {
      if (this.current === replace) this.current = null
      finish(null, 0) // unused: resolves null; used: its reply already went out
      await member.close().catch(safetyCatch)
    }
    await member.flushed().catch(safetyCatch)
    return { code: z32.encode(invite), added }
  }

  // Uses a code: { identity, phrase, key, encryptionKey }; INVITE_INVALID for
  // a code that isn't one, or when nobody let us in within `timeout`.
  async join (code, { device, name = '', timeout = JOIN_MS }) {
    let invite = null
    try {
      invite = z32.decode(code)
      BlindPairing.decodeInvite(invite)
    } catch {
      throw new HypergraphError('INVITE_INVALID', 'Not a device code')
    }
    const candidate = this.blind.addCandidate({ invite, userData: c.encode(request, { device, name }), onadd: async () => {} })
    let timer = null
    const paired = await Promise.race([candidate.pairing, new Promise((resolve) => { timer = setTimeout(resolve, timeout, null) })])
    clearTimeout(timer)
    await candidate.close().catch(safetyCatch)
    if (!paired || !paired.data) {
      throw new HypergraphError('INVITE_INVALID', `No device of the account answered within ${Math.round(timeout / 1000)} s (the code may be used or expired, or the device offline)`)
    }
    const { identity, phrase } = c.decode(reply, paired.data)
    return { identity, phrase, key: paired.key, encryptionKey: paired.encryptionKey }
  }

  #later (fn, ms) {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      fn()
    }, ms)
    this.timers.add(timer)
    return timer
  }

  async close () {
    this.closed = true
    for (const expire of [...this.waiting]) expire()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    await this.blind.close().catch(safetyCatch)
  }
}

module.exports = { Pairing }

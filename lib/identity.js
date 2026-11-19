// A person's identity (keet-identity-key):
// a recovery phrase derives the identity key; each device holds a proof that
// it belongs to the identity, and signs data on its behalf (attestData).
// Readers verify a proof once per device log.

const IdentityKey = require('keet-identity-key')
const { ProofEncoding } = require('keet-identity-key/lib/encoding.js')
const c = require('compact-encoding')
const Hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')

/**
 * @typedef {{ publicKey: Uint8Array, secretKey: Uint8Array }} KeyPair
 * @typedef {{ identity: Uint8Array, device: Uint8Array }} Signer Who signed: the identity, and the device on its behalf.
 */
class Identity {
  /**
   * @param {{ publicKey: Uint8Array, device: KeyPair, proof: Uint8Array, mnemonic?: string | null }} opts
   */
  constructor ({ publicKey, device, proof, mnemonic = null }) {
    this.publicKey = publicKey // the identity's key: the person
    this.device = device // this device's key pair
    this.proof = proof // proof that this device belongs to the identity
    /**
     * @type {null}
     */
    /** @type {string | null} */
    this.recoveryPhrase = mnemonic
  }

  /**
   * @param {{ device: KeyPair, mnemonic?: string | null }} opts
   * @returns {Promise<Identity>}
   */
  static async create ({ device, mnemonic = null }) {
    const phrase = mnemonic || IdentityKey.generateMnemonic()
    const key = await IdentityKey.from({ mnemonic: phrase })
    const proof = await key.bootstrap(device.publicKey)
    const identity = new Identity({ publicKey: key.identityPublicKey, device, proof, mnemonic: phrase })
    key.clear()
    return identity
  }

  /**
   * @param {string} mnemonic
   * @returns {Promise<Uint8Array>}
   */
  static async publicKeyOf (mnemonic) {
    const key = await IdentityKey.from({ mnemonic })
    const publicKey = key.identityPublicKey
    key.clear()
    return publicKey
  }

  // What only the recovery phrase gives: the identity's own
  // key pair (it signs device removals and identity logs), and the personal
  // space's first key pair and encryption key, the same wherever the phrase
  // is. Null for a phrase that isn't one.
  /**
   * @param {string} mnemonic
   * @returns {Promise<{ publicKey: Uint8Array, keyPair: KeyPair, personal: { keyPair: KeyPair, encryptionKey: Uint8Array } } | null>}
   */
  static async secrets (mnemonic) {
    let key = null
    try { key = await IdentityKey.from({ mnemonic }) } catch { return null }
    const chain = key.keyChain
    const keyPair = { publicKey: b4a.from(key.identityKeyPair.publicKey), secretKey: b4a.from(key.identityKeyPair.secretKey) }
    const personal = {
      keyPair: crypto.keyPair(b4a.from(chain.getSymmetricKey(['hypergraph', 'personal space']))),
      encryptionKey: b4a.from(chain.getSymmetricKey(['hypergraph', 'personal space encryption']))
    }
    key.clear()
    return { publicKey: keyPair.publicKey, keyPair, personal }
  }

  // The personal space's key: its first writer's core key, as Corestore
  // derives it from the key pair (so a device restored from the phrase finds
  // the same personal space without being told).
  /**
   * @param {{ publicKey: Uint8Array }} keyPair
   * @param {number} [manifestVersion]
   * @returns {Uint8Array}
   */
  static personalKey (keyPair, manifestVersion = 1) {
    return Hypercore.key({ version: manifestVersion, signers: [{ publicKey: keyPair.publicKey }] })
  }

  /**
   * @param {Uint8Array} data
   * @param {KeyPair} keyPair
   * @returns {Uint8Array}
   */
  static attestAsIdentity (data, keyPair) {
    return IdentityKey.attestData(data, keyPair, null)
  }

  /**
   * @param {{ device: KeyPair, proof: Uint8Array, mnemonic?: string | null }} opts
   * @returns {Identity | null}
   */
  static fromProof ({ device, proof, mnemonic = null }) {
    const info = Identity.verifyDevice(proof)
    if (!info || !b4a.equals(info.device, device.publicKey)) return null
    return new Identity({ publicKey: info.identity, device, proof, mnemonic })
  }

  /**
   * @param {Uint8Array} data
   * @returns {Uint8Array}
   */
  attest (data) {
    return IdentityKey.attestData(data, this.device, this.proof)
  }

  // { identity, device } if `proof` attests `data`, else null. Never throws.
  // Only the identity key itself, or a device it bootstrapped, may sign: a
  // device attesting another device would let a stolen device mint devices
  // no removal names.
  /**
   * @param {Uint8Array | object} proof Its bytes, or decoded.
   * @param {Uint8Array | null} data
   * @returns {Signer | null}
   */
  static verify (proof, data) {
    try {
      /** @type {{ chain?: unknown[] } | null} */
      const decoded = b4a.isBuffer(proof) ? c.decode(ProofEncoding, proof) : proof
      if (!decoded || !decoded.chain || decoded.chain.length > 1) return null
      const info = IdentityKey.verify(decoded, data)
      return info ? { identity: info.identityPublicKey, device: info.devicePublicKey } : null
    } catch {
      return null
    }
  }

  /**
   * @param {Uint8Array} proof
   * @returns {Signer | null}
   */
  static verifyDevice (proof) {
    return Identity.verify(proof, null)
  }

  toJSON () {
    return { proof: b4a.toString(this.proof, 'hex'), mnemonic: this.recoveryPhrase }
  }
}

module.exports = { Identity }

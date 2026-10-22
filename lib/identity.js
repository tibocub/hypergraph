// A person's identity (keet-identity-key, as v1's src/identity-manager.js):
// a recovery phrase derives the identity key; each device holds a proof that
// it belongs to the identity, and signs data on its behalf (attestData).
// Readers verify a proof once per device log.

const IdentityKey = require('keet-identity-key')
const { ProofEncoding } = require('keet-identity-key/lib/encoding.js')
const c = require('compact-encoding')
const Hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')

class Identity {
  constructor ({ publicKey, device, proof, mnemonic = null }) {
    this.publicKey = publicKey // the identity's key: the person
    this.device = device // this device's key pair
    this.proof = proof // proof that this device belongs to the identity
    this.recoveryPhrase = mnemonic
  }

  // A new identity (or one restored from its phrase) on this device.
  static async create ({ device, mnemonic = null }) {
    const phrase = mnemonic || IdentityKey.generateMnemonic()
    const key = await IdentityKey.from({ mnemonic: phrase })
    const proof = await key.bootstrap(device.publicKey)
    const identity = new Identity({ publicKey: key.identityPublicKey, device, proof, mnemonic: phrase })
    key.clear()
    return identity
  }

  // The identity a recovery phrase restores.
  static async publicKeyOf (mnemonic) {
    const key = await IdentityKey.from({ mnemonic })
    const publicKey = key.identityPublicKey
    key.clear()
    return publicKey
  }

  // What only the recovery phrase gives (research.md A7): the identity's own
  // key pair (it signs device removals and identity logs), and the personal
  // space's first key pair and encryption key, the same wherever the phrase
  // is. Null for a phrase that isn't one.
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
  static personalKey (keyPair, manifestVersion = 1) {
    return Hypercore.key({ version: manifestVersion, signers: [{ publicKey: keyPair.publicKey }] })
  }

  // Signs data as the identity itself (a proof with no device in it).
  static attestAsIdentity (data, keyPair) {
    return IdentityKey.attestData(data, keyPair, null)
  }

  // This device, from a proof saved earlier or given by another device.
  // Null if the proof isn't for this device.
  static fromProof ({ device, proof, mnemonic = null }) {
    const info = Identity.verifyDevice(proof)
    if (!info || !b4a.equals(info.device, device.publicKey)) return null
    return new Identity({ publicKey: info.identity, device, proof, mnemonic })
  }

  // Signs data on the identity's behalf.
  attest (data) {
    return IdentityKey.attestData(data, this.device, this.proof)
  }

  // { identity, device } if `proof` attests `data`, else null. Never throws.
  // Only the identity key itself, or a device it bootstrapped, may sign: a
  // device attesting another device would let a stolen device mint devices
  // no removal names (research.md A8).
  static verify (proof, data) {
    try {
      const decoded = b4a.isBuffer(proof) ? c.decode(ProofEncoding, proof) : proof
      if (!decoded || !decoded.chain || decoded.chain.length > 1) return null
      const info = IdentityKey.verify(decoded, data)
      return info ? { identity: info.identityPublicKey, device: info.devicePublicKey } : null
    } catch {
      return null
    }
  }

  static verifyDevice (proof) {
    return Identity.verify(proof, null)
  }

  toJSON () {
    return { proof: b4a.toString(this.proof, 'hex'), mnemonic: this.recoveryPhrase }
  }
}

module.exports = { Identity }

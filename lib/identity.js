// A person's identity (keet-identity-key, as v1's src/identity-manager.js):
// a recovery phrase derives the identity key; each device holds a proof that
// it belongs to the identity, and signs data on its behalf (attestData).
// Readers verify a proof once per device log.

const IdentityKey = require('keet-identity-key')
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

  // This device, from a proof saved earlier or given by another device.
  // Null if the proof isn't for this device.
  static fromProof ({ device, proof, mnemonic = null }) {
    const info = Identity.verifyDevice(proof)
    if (!info || !b4a.equals(info.device, device.publicKey)) return null
    return new Identity({ publicKey: info.identity, device, proof, mnemonic })
  }

  // A proof for another device of this identity (story 3).
  attestDevice (publicKey) {
    return IdentityKey.attestDevice(publicKey, this.device, this.proof)
  }

  // Signs data on the identity's behalf.
  attest (data) {
    return IdentityKey.attestData(data, this.device, this.proof)
  }

  // { identity, device } if `proof` attests `data`, else null. Never throws.
  static verify (proof, data) {
    try {
      const info = IdentityKey.verify(proof, data)
      return info ? { identity: info.identityPublicKey, device: info.devicePublicKey } : null
    } catch {
      return null
    }
  }

  static verifyDevice (proof) {
    try {
      const info = IdentityKey.verify(proof, null)
      return info ? { identity: info.identityPublicKey, device: info.devicePublicKey } : null
    } catch {
      return null
    }
  }

  toJSON () {
    return { proof: b4a.toString(this.proof, 'hex'), mnemonic: this.recoveryPhrase }
  }
}

module.exports = { Identity }

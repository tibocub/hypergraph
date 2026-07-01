const IdentityKey = require('keet-identity-key')
const b4a = require('b4a')
const hypercoreCrypto = require('hypercore-crypto')

/**
 * IdentityManager handles keet-identity-key integration for hypergraph.
 * 
 * Manages hierarchical deterministic keypairs for identity recovery via mnemonic
 * and multi-device support with device attestation.
 * 
 * NOTE: This module is a candidate for extraction to a separate package
 * (hyper-identity) for reuse across projects. It's currently kept in hypergraph
 * for simplicity during early development, but is well-encapsulated for easy
 * extraction later.
 */
class IdentityManager {
  #identityKey
  #deviceKeyPair
  #attestationProof

  /**
   * Create a new IdentityManager instance.
   *
   * @param {Object} opts
   * @param {string} [opts.mnemonic] - Recover identity from mnemonic
   * @param {Buffer} [opts.seed] - Recover identity from seed
   * @param {IdentityKey} [opts.identityKey] - Use existing IdentityKey instance
   * @param {Object} [opts.deviceKeyPair] - Use existing device keyPair for persistence
   */
  constructor (opts = {}) {
    if (opts.identityKey) {
      this.#identityKey = opts.identityKey
    } else {
      this.#identityKey = null
    }

    // Use provided device keyPair or generate a new one
    this.#deviceKeyPair = opts.deviceKeyPair || hypercoreCrypto.keyPair()

    // Attestation will be set after identity is initialized
    this.#attestationProof = null

    // Store initialization options for async init
    this._initOpts = { mnemonic: opts.mnemonic, seed: opts.seed }
  }

  /**
   * Initialize the identity (async for mnemonic/seed cases).
   * 
   * @returns {Promise<void>}
   */
  async init () {
    if (this.#identityKey) {
      // Already initialized
      if (!this.#attestationProof) {
        this.#attestationProof = this.#identityKey.bootstrap(this.#deviceKeyPair.publicKey)
      }
      return
    }

    // Initialize from mnemonic or seed
    if (this._initOpts.mnemonic || this._initOpts.seed) {
      this.#identityKey = await IdentityKey.from({ 
        mnemonic: this._initOpts.mnemonic, 
        seed: this._initOpts.seed 
      })
    } else {
      // Generate new identity
      this.#identityKey = await IdentityKey.from({ seed: hypercoreCrypto.randomBytes(32) })
    }

    // Bootstrap device attestation
    this.#attestationProof = this.#identityKey.bootstrap(this.#deviceKeyPair.publicKey)
  }

  /**
   * Generate a new mnemonic for identity recovery.
   * 
   * @static
   * @returns {string} 12-word mnemonic phrase
   */
  static generateMnemonic () {
    return IdentityKey.generateMnemonic()
  }

  /**
   * Create an IdentityManager from a mnemonic.
   * 
   * @static
   * @param {string} mnemonic - 12-word mnemonic phrase
   * @returns {IdentityManager} New IdentityManager instance
   */
  static fromMnemonic (mnemonic) {
    return new IdentityManager({ mnemonic })
  }

  /**
   * Get the identity's public key (canonical user identifier).
   * 
   * @returns {Buffer} 32-byte public key
   */
  get identityPublicKey () {
    return this.#identityKey.identityPublicKey
  }

  /**
   * Get the current device's keyPair for signing.
   * 
   * @returns {Object} KeyPair with publicKey and secretKey
   */
  get deviceKeyPair () {
    return this.#deviceKeyPair
  }

  /**
   * Get the profile discovery keyPair.
   * 
   * @returns {Object} KeyPair with publicKey and secretKey
   */
  get profileDiscoveryKeyPair () {
    return this.#identityKey.profileDiscoveryKeyPair
  }

  /**
   * Get the profile discovery public key.
   * 
   * @returns {Buffer} 32-byte public key
   */
  get profileDiscoveryPublicKey () {
    return this.#identityKey.profileDiscoveryPublicKey
  }

  /**
   * Get the device attestation proof.
   * 
   * @returns {Buffer} Proof linking device to identity
   */
  get attestationProof () {
    return this.#attestationProof
  }

  /**
   * Attest to a new device key.
   * 
   * @param {Buffer} devicePublicKey - Public key of the device to attest
   * @returns {Buffer} Proof linking the device to this identity
   */
  attestDevice (devicePublicKey) {
    return IdentityKey.attestDevice(devicePublicKey, this.#deviceKeyPair, this.#attestationProof)
  }

  /**
   * Verify a device attestation proof.
   * 
   * @param {Buffer} proof - Proof to verify
   * @param {Object} [opts] - Verification options
   * @param {Buffer} [opts.expectedIdentity] - Expected identity public key
   * @param {Buffer} [opts.expectedDevice] - Expected device public key
   * @returns {Object|null} Verification info with identityPublicKey and devicePublicKey, or null if invalid
   */
  verifyProof (proof, opts = {}) {
    const info = IdentityKey.verify(proof, null, opts)
    return info
  }

  /**
   * Clear all private data from memory.
   */
  clear () {
    this.#identityKey.clear()
    this.#deviceKeyPair = null
    this.#attestationProof = null
  }
}

module.exports = IdentityManager

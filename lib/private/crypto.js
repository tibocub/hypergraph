// Private spaces: sealing records.
//
// - A space's content is encrypted with symmetric keys in epochs. An epoch key
//   travels only sealed to one device (crypto_box_seal, in a `hg/grant`
//   record), and the decision log records a commitment to it (`key/rotate`),
//   so a grant opening to any other key is ignored.
// - Each device's box key pair is its device key pair converted to X25519:
//   anyone can seal to a device knowing only its public key (from its log
// header's proof), and only that device opens it. (Not one pair per
// identity from its seed: a device may not hold the recovery
// phrase unlocked, and grants per device let a removed device be left out.)
// - A record's fields and links are XChaCha20-Poly1305 with the space, its
//   log, its position and the epoch as additional data: a box copied
//   anywhere else doesn't open.
// Uses sodium-universal only (the same on Node and Bare). Keys never leave
// this module's callers' private fields: nothing here logs or returns them in
// errors.

const sodium = require('sodium-universal')
const b4a = require('b4a')
const c = require('compact-encoding')
const { paddedSize, PAD_SCHEME, MAX_RECORD } = require('../encodings.js')

const NONCE_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
const TAG_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES
const KEY_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES

/**
 * @typedef {import('../identity.js').KeyPair} KeyPair
 * @typedef {{ fields: Uint8Array, links: Uint8Array[] }} Payload
 * @typedef {{ scheme: number, epoch: number, commit: Uint8Array, n: number, nonce: Uint8Array, box: Uint8Array | null }} Envelope `scheme`: EPOCH_KEY (sealed with the epoch key) or CHAIN (with message key `n` of its log's chain).
 * @typedef {{ key: Uint8Array, past?: { top: Uint8Array, key: Uint8Array }[], refused?: undefined } | { refused: string, key?: undefined }} KeyAnswer
 */

/**
 * @param {...(Uint8Array | string)} parts
 * @returns {Uint8Array}
 */
function hash (...parts) {
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, b4a.concat(parts.map((p) => (typeof p === 'string' ? b4a.from(p) : p))))
  return out
}

// A device's box key pair, from its (Ed25519) device key pair.
/**
 * @param {KeyPair} device
 * @returns {KeyPair}
 */
function boxKeyPair (device) {
  const publicKey = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_box_SECRETKEYBYTES)
  sodium.crypto_sign_ed25519_pk_to_curve25519(publicKey, device.publicKey)
  sodium.crypto_sign_ed25519_sk_to_curve25519(secretKey, device.secretKey)
  return { publicKey, secretKey }
}

/**
 * @param {Uint8Array} devicePublicKey
 * @returns {Uint8Array | null}
 */
function boxPublicKey (devicePublicKey) {
  const out = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  try {
    sodium.crypto_sign_ed25519_pk_to_curve25519(out, devicePublicKey)
    return out
  } catch {
    return null
  }
}

/**
 * @param {Uint8Array} message
 * @param {Uint8Array} publicKey
 * @returns {Uint8Array}
 */
function seal (message, publicKey) {
  const out = b4a.alloc(message.byteLength + sodium.crypto_box_SEALBYTES)
  sodium.crypto_box_seal(out, message, publicKey)
  return out
}

/**
 * @param {unknown} sealed
 * @param {KeyPair} keyPair
 * @returns {Uint8Array | null}
 */
function openSealed (sealed, keyPair) {
  if (!b4a.isBuffer(sealed) || sealed.byteLength < sodium.crypto_box_SEALBYTES) return null
  const out = b4a.alloc(sealed.byteLength - sodium.crypto_box_SEALBYTES)
  try {
    return sodium.crypto_box_seal_open(out, sealed, keyPair.publicKey, keyPair.secretKey) ? out : null
  } catch {
    return null
  }
}

/**
 * @returns {Uint8Array}
 */
function newEpochKey () {
  const key = b4a.alloc(KEY_BYTES)
  sodium.randombytes_buf(key)
  return key
}

// What the decision log records for an epoch: a grant must open to a key
// with this commitment.
/**
 * @param {Uint8Array} key
 */
function commitOf (key) {
  return hash('hypergraph/epoch\0', key)
}

const EPOCH_KEY = 0 // a "keep history" space's records
const CHAIN = 1 // a secure conversation's (lib/private/chains.js)
const SHARED = 2 // a `shared` type's, in a private top space: every holder of the disk key reads it
// room for a deniable scheme after these

// A shared type's key: from the disk key, which every member gets at join
// and keeps (an ex-member too, until the space is renewed).
/** @param {Uint8Array} diskKey */
const sharedKey = (diskKey) => hash('hypergraph/shared\0', diskKey)

/**
 * @param {Uint8Array} space
 * @param {Uint8Array} log
 * @param {number} seq
 * @param {number} epoch
 * @param {number} [n] The chain index (CHAIN).
 * @param {number} [scheme]
 */
function recordAD (space, log, seq, epoch, n = 0, scheme = EPOCH_KEY) {
  return hash('hypergraph/record\0', space, log, `\0${seq}\0${epoch}\0${scheme}\0${n}`)
}

/** @type {import('../encodings.js').Codec<Payload>} */
const payload = {
  preencode (state, v) { c.buffer.preencode(state, v.fields); c.array(c.buffer).preencode(state, v.links) },
  encode (state, v) { c.buffer.encode(state, v.fields); c.array(c.buffer).encode(state, v.links) },
  /**
   * @param {c.State<Uint8Array>} state
   */
  decode (state) { return { fields: c.buffer.decode(state) || b4a.alloc(0), links: c.array(c.buffer).decode(state) } }
}
// { scheme, epoch, commit (the key's commitment, first 8 bytes: which key,
// even for a rotation that lost a race), n (the chain index), nonce, box }
const COMMIT_BYTES = 8
/** @type {import('../encodings.js').Codec<Envelope>} */
const envelope = {
  preencode (state, /** @type {Envelope & { box: Uint8Array }} */ v) { c.uint.preencode(state, v.scheme); c.uint.preencode(state, v.epoch); c.fixed(COMMIT_BYTES).preencode(state, v.commit); c.uint.preencode(state, v.n); c.fixed(NONCE_BYTES).preencode(state, v.nonce); c.buffer.preencode(state, v.box) },
  encode (state, /** @type {Envelope & { box: Uint8Array }} */ v) { c.uint.encode(state, v.scheme); c.uint.encode(state, v.epoch); c.fixed(COMMIT_BYTES).encode(state, v.commit); c.uint.encode(state, v.n); c.fixed(NONCE_BYTES).encode(state, v.nonce); c.buffer.encode(state, v.box) },
  /**
   * @param {c.State<Uint8Array>} state
   */
  decode (state) { return { scheme: c.uint.decode(state), epoch: c.uint.decode(state), commit: c.fixed(COMMIT_BYTES).decode(state), n: c.uint.decode(state), nonce: c.fixed(NONCE_BYTES).decode(state), box: c.buffer.decode(state) } }
}

/** @param {Uint8Array} commit */
const shortCommit = (commit) => b4a.toString(commit.subarray(0, COMMIT_BYTES), 'hex')

// A record's fields and links sealed with an epoch key: the bytes that take
// the record's `fields` (its `links` stay empty).
/**
 * @param {Uint8Array} key The epoch key, or the record's message key (CHAIN).
 * @param {number} epoch
 * @param {Uint8Array} ad
 * @param {Payload} record
 * @param {{ pad?: boolean, scheme?: number, n?: number, commit?: Uint8Array }} [opts] `pad`: for a log with no disk key, whose blocks aren't padded; `commit`: the epoch's (CHAIN: a message key isn't the epoch key).
 * @returns {Uint8Array}
 */
function sealRecord (key, epoch, ad, { fields, links }, { pad = false, scheme = EPOCH_KEY, n = 0, commit = commitOf(key) } = {}) {
  let plain = c.encode(payload, { fields, links })
  if (pad) { // the payload ends itself, so readers skip the scheme byte and zeros after it
    const room = MAX_RECORD - 1024 // a record near the limit still fits once padded
    const padded = b4a.alloc(Math.max(plain.byteLength + 1, Math.min(paddedSize(plain.byteLength + 1 + TAG_BYTES), room) - TAG_BYTES))
    padded.set(plain)
    padded[plain.byteLength] = PAD_SCHEME
    plain = padded
  }
  const nonce = b4a.alloc(NONCE_BYTES)
  sodium.randombytes_buf(nonce)
  const box = b4a.alloc(plain.byteLength + TAG_BYTES)
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(box, plain, ad, null, nonce, key)
  return c.encode(envelope, { scheme, epoch, commit: commit.subarray(0, COMMIT_BYTES), n, nonce, box })
}

/**
 * @param {Uint8Array} sealed
 * @returns {{ scheme: number, epoch: number, commit: string, n: number } | null}
 */
function sealedWith (sealed) {
  try {
    const env = c.decode(envelope, sealed)
    return { scheme: env.scheme, epoch: env.epoch, commit: b4a.toString(env.commit, 'hex'), n: env.n }
  } catch {
    return null
  }
}

/**
 * @param {Uint8Array} key
 * @param {Uint8Array} ad
 * @param {Uint8Array} sealed
 * @returns {Payload | null}
 */
function openRecord (key, ad, sealed) {
  /** @type {Envelope | null} */
  let env = null
  try { env = c.decode(envelope, sealed) } catch { return null }
  if (!b4a.isBuffer(env.box) || env.box.byteLength < TAG_BYTES) return null
  const out = b4a.alloc(env.box.byteLength - TAG_BYTES)
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(out, null, env.box, ad, env.nonce, key)
    return c.decode(payload, out)
  } catch {
    return null
  }
}

// An older epoch key sealed with a newer one (a key link); `ad` names the
// space and the older key's commitment.
/**
 * @param {Uint8Array} space
 * @param {Uint8Array} commit
 */
function linkAD (space, commit) {
  return hash('hypergraph/key-link\0', space, commit)
}

/**
 * @param {Uint8Array} withKey
 * @param {Uint8Array} key
 * @param {Uint8Array} ad
 */
function sealKey (withKey, key, ad) {
  const nonce = b4a.alloc(NONCE_BYTES)
  sodium.randombytes_buf(nonce)
  const box = b4a.alloc(key.byteLength + TAG_BYTES)
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(box, key, ad, null, nonce, withKey)
  return b4a.concat([nonce, box])
}

/**
 * @param {Uint8Array} withKey
 * @param {unknown} sealed
 * @param {Uint8Array} ad
 * @returns {Uint8Array | null}
 */
function openKey (withKey, sealed, ad) {
  if (!b4a.isBuffer(sealed) || sealed.byteLength !== NONCE_BYTES + KEY_BYTES + TAG_BYTES) return null
  const out = b4a.alloc(KEY_BYTES)
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(out, null, sealed.subarray(NONCE_BYTES), ad, sealed.subarray(0, NONCE_BYTES), withKey)
    return out
  } catch {
    return null
  }
}

// What an invite link carries of a private space's disk key: a
// commitment (16 bytes), so the newcomer checks the key it gets; never the key.
/**
 * @param {Uint8Array} key
 */
function diskCommit (key) {
  return hash('hypergraph/disk\0', key).subarray(0, 16)
}

// What a decider answers a newcomer to a private space, sealed
// to its device: the disk key (tag 0) or a refusal's code (tag 1).
// A renewed space's answer also carries the disk keys of the
// spaces it renewed (`past`: [{ top, key }], tag 2), for a newcomer who reads
// its history.
/** @param {Uint8Array} key @param {{ top: Uint8Array, key: Uint8Array }[]} [past] */
const keyAnswer = (key, past = []) => past.length ? b4a.concat([b4a.from([2]), key, ...past.flatMap((p) => [p.top, p.key])]) : b4a.concat([b4a.from([0]), key])
/** @param {string} code */
const refusalAnswer = (code) => b4a.concat([b4a.from([1]), b4a.from(code)])
/**
 * @param {Uint8Array | null} bytes
 * @returns {KeyAnswer | null}
 */
function readAnswer (bytes) {
  if (!bytes || !bytes.byteLength) return null
  if (bytes[0] === 0 && bytes.byteLength === 33) return { key: bytes.subarray(1) }
  if (bytes[0] === 2 && bytes.byteLength >= 33 && (bytes.byteLength - 33) % 64 === 0) {
    /** @type {{ top: Uint8Array, key: Uint8Array }[]} */
    const past = []
    for (let i = 33; i < bytes.byteLength; i += 64) past.push({ top: bytes.subarray(i, i + 32), key: bytes.subarray(i + 32, i + 64) })
    return { key: bytes.subarray(1, 33), past }
  }
  if (bytes[0] === 1) return { refused: b4a.toString(bytes.subarray(1)) }
  return null
}

module.exports = { EPOCH_KEY, CHAIN, SHARED, sharedKey, keyAnswer, refusalAnswer, readAnswer, diskCommit, linkAD, sealKey, openKey, boxKeyPair, boxPublicKey, seal, openSealed, newEpochKey, commitOf, recordAD, sealRecord, openRecord, sealedWith, shortCommit, hash }

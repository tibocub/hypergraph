// I2P destinations: base64 with I2P's alphabet, hashed (sha256) to a 32-byte address written as a .b32.i2p name.
// Ed25519 destinations only (SAM SIGNATURE_TYPE=7): their key signs our DHT records.
const b4a = require('b4a')
const sodium = require('sodium-universal')

const SIG_TYPE = 7 // EdDSA_SHA512_Ed25519
const B32 = 'abcdefghijklmnopqrstuvwxyz234567'
const SIGNING_KEY_END = 384 // 256 bytes of encryption key, then 128 of signing key, padded at the front

/** @param {string} b64 I2P base64 (`-` and `~` for `+` and `/`) @returns {Uint8Array} */
const fromI2PBase64 = (b64) => b4a.from(b64.replace(/-/g, '+').replace(/~/g, '/'), 'base64')

/** @param {Uint8Array} buf @returns {string} */
const toI2PBase64 = (buf) => b4a.toString(buf, 'base64').replace(/\+/g, '-').replace(/\//g, '~')

/** @param {Uint8Array} buf @returns {Uint8Array} */
function sha256 (buf) {
  const out = b4a.alloc(32)
  sodium.crypto_hash_sha256(out, buf)
  return out
}

/** @param {Uint8Array} buf 32 bytes @returns {string} 52 characters */
function toBase32 (buf) {
  let bits = 0
  let val = 0
  let out = ''
  for (const b of buf) {
    val = (val << 8) | b
    bits += 8
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31]
  return out
}

/** @param {string} s 52 characters @returns {Uint8Array} 32 bytes; throws on anything else */
function fromBase32 (s) {
  if (s.length !== 52) throw new Error('not an I2P address')
  const out = b4a.alloc(32)
  let bits = 0
  let val = 0
  let i = 0
  for (const ch of s) {
    const v = B32.indexOf(ch)
    if (v === -1) throw new Error('not an I2P address')
    val = (val << 5) | v
    bits += 5
    if (bits >= 8) { if (i < 32) out[i++] = (val >>> (bits - 8)) & 255; bits -= 8 }
  }
  return out
}

/**
 * A destination's address: the base32 of its hash, without `.b32.i2p`.
 * @param {Uint8Array} dest binary destination
 */
const addressOf = (dest) => toBase32(sha256(dest))

/**
 * The public destination at the start of a private one: 384 bytes of keys, then a certificate (type, 2-byte length).
 * @param {Uint8Array} priv
 */
function publicOf (priv) {
  const len = 387 + ((priv[385] << 8) | priv[386])
  return priv.subarray(0, len)
}

/**
 * The Ed25519 key pair of a private destination (its signing private key, a 32-byte seed, ends it).
 * @param {Uint8Array} priv
 * @returns {{ publicKey: Uint8Array, secretKey: Uint8Array }}
 */
function signingKeyPair (priv) {
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_seed_keypair(publicKey, secretKey, priv.subarray(priv.length - 32))
  if (!b4a.equals(publicKey, signingKeyOf(publicOf(priv)))) throw new Error('not an Ed25519 destination')
  return { publicKey, secretKey }
}

/** @param {Uint8Array} dest a public destination @returns {Uint8Array} */
const signingKeyOf = (dest) => dest.subarray(SIGNING_KEY_END - 32, SIGNING_KEY_END)

/** @param {Uint8Array} dest @returns {boolean} an Ed25519 key certificate (type 5, sig type 7) */
const isEd25519 = (dest) => dest.length >= 391 && dest[384] === 5 && ((dest[387] << 8) | dest[388]) === SIG_TYPE

module.exports = { SIG_TYPE, fromI2PBase64, toI2PBase64, sha256, toBase32, fromBase32, addressOf, publicOf, signingKeyPair, signingKeyOf, isEd25519 }

// Private spaces: sealing records (story 8, research.md A13), adapted from
// src/v2/crypto.js (spec 008, research R2–R4).
//
// - A space's content is encrypted with symmetric keys in epochs. An epoch key
//   travels only sealed to one device (crypto_box_seal, in a `hg/grant`
//   record), and the decision log records a commitment to it (`key/rotate`),
//   so a grant opening to any other key is ignored.
// - Each device's box key pair is its device key pair converted to X25519:
//   anyone can seal to a device knowing only its public key (from its log
//   header's proof), and only that device opens it. (Spec 008 derived one
//   pair per identity from its seed; here a device may not hold the recovery
//   phrase unlocked, and grants per device let a removed device be left out.)
// - A record's fields and links are XChaCha20-Poly1305 with the space, its
//   log, its position and the epoch as additional data: a box copied
//   anywhere else doesn't open.
// Uses sodium-universal only (the same on Node and Bare). Keys never leave
// this module's callers' private fields: nothing here logs or returns them in
// errors.

const sodium = require('sodium-universal')
const b4a = require('b4a')
const c = require('compact-encoding')

const NONCE_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
const TAG_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES
const KEY_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES

function hash (...parts) {
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, b4a.concat(parts.map((p) => (typeof p === 'string' ? b4a.from(p) : p))))
  return out
}

// A device's box key pair, from its (Ed25519) device key pair.
function boxKeyPair (device) {
  const publicKey = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_box_SECRETKEYBYTES)
  sodium.crypto_sign_ed25519_pk_to_curve25519(publicKey, device.publicKey)
  sodium.crypto_sign_ed25519_sk_to_curve25519(secretKey, device.secretKey)
  return { publicKey, secretKey }
}

// A device's box public key, from its device public key; null if it isn't one.
function boxPublicKey (devicePublicKey) {
  const out = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  try {
    sodium.crypto_sign_ed25519_pk_to_curve25519(out, devicePublicKey)
    return out
  } catch {
    return null
  }
}

function seal (message, publicKey) {
  const out = b4a.alloc(message.byteLength + sodium.crypto_box_SEALBYTES)
  sodium.crypto_box_seal(out, message, publicKey)
  return out
}

// The sealed message, or null if it isn't for this key pair (or is garbage).
function openSealed (sealed, keyPair) {
  if (!b4a.isBuffer(sealed) || sealed.byteLength < sodium.crypto_box_SEALBYTES) return null
  const out = b4a.alloc(sealed.byteLength - sodium.crypto_box_SEALBYTES)
  try {
    return sodium.crypto_box_seal_open(out, sealed, keyPair.publicKey, keyPair.secretKey) ? out : null
  } catch {
    return null
  }
}

function newEpochKey () {
  const key = b4a.alloc(KEY_BYTES)
  sodium.randombytes_buf(key)
  return key
}

// What the decision log records for an epoch: a grant must open to a key
// with this commitment.
function commitOf (key) {
  return hash('hypergraph/epoch\0', key)
}

function recordAD (space, log, seq, epoch) {
  return hash('hypergraph/record\0', space, log, `\0${seq}\0${epoch}`)
}

const payload = {
  preencode (state, v) { c.buffer.preencode(state, v.fields); c.array(c.buffer).preencode(state, v.links) },
  encode (state, v) { c.buffer.encode(state, v.fields); c.array(c.buffer).encode(state, v.links) },
  decode (state) { return { fields: c.buffer.decode(state) || b4a.alloc(0), links: c.array(c.buffer).decode(state) } }
}
// { epoch, commit (the key's commitment, first 8 bytes: which key, even for
// a rotation that lost a race), nonce, box }
const COMMIT_BYTES = 8
const envelope = {
  preencode (state, v) { c.uint.preencode(state, v.epoch); c.fixed(COMMIT_BYTES).preencode(state, v.commit); c.fixed(NONCE_BYTES).preencode(state, v.nonce); c.buffer.preencode(state, v.box) },
  encode (state, v) { c.uint.encode(state, v.epoch); c.fixed(COMMIT_BYTES).encode(state, v.commit); c.fixed(NONCE_BYTES).encode(state, v.nonce); c.buffer.encode(state, v.box) },
  decode (state) { return { epoch: c.uint.decode(state), commit: c.fixed(COMMIT_BYTES).decode(state), nonce: c.fixed(NONCE_BYTES).decode(state), box: c.buffer.decode(state) } }
}

// The short form of a commitment a sealed record names (hex).
const shortCommit = (commit) => b4a.toString(commit.subarray(0, COMMIT_BYTES), 'hex')

// A record's fields and links sealed with an epoch key: the bytes that take
// the record's `fields` (its `links` stay empty).
function sealRecord (key, epoch, ad, { fields, links }) {
  const plain = c.encode(payload, { fields, links })
  const nonce = b4a.alloc(NONCE_BYTES)
  sodium.randombytes_buf(nonce)
  const box = b4a.alloc(plain.byteLength + TAG_BYTES)
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(box, plain, ad, null, nonce, key)
  return c.encode(envelope, { epoch, commit: commitOf(key).subarray(0, COMMIT_BYTES), nonce, box })
}

// { epoch, commit (short form, hex) } a sealed record's bytes name, or null
// if they aren't an envelope.
function sealedWith (sealed) {
  try {
    const env = c.decode(envelope, sealed)
    return { epoch: env.epoch, commit: b4a.toString(env.commit, 'hex') }
  } catch {
    return null
  }
}

// { fields, links } of a sealed record, or null if the key, the additional
// data or the box doesn't match.
function openRecord (key, ad, sealed) {
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

module.exports = { boxKeyPair, boxPublicKey, seal, openSealed, newEpochKey, commitOf, recordAD, sealRecord, openRecord, sealedWith, shortCommit, hash }

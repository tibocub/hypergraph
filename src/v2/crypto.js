const sodium = require('sodium-universal')
const nodeCrypto = require('crypto')
const b4a = require('b4a')

// Encryption for v2 private channels (spec 008, research R2-R4).
//
// - Each identity has one encryption key pair, derived from its seed like
//   v2's other per-identity keys, so every device of a member opens the
//   same grants.
// - A channel has symmetric keys in epochs; an epoch key travels only
//   sealed to one member (crypto_box_seal), and the control log records a
//   commitment to it, so a grant with any other key is ignored.
// - A message is XChaCha20-Poly1305 with the community, channel, author
//   log, epoch and time as additional data: a box copied anywhere else
//   doesn't open.

const NONCE_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
const TAG_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES

const sha256 = (...parts) => {
  const h = nodeCrypto.createHash('sha256')
  for (const p of parts) h.update(typeof p === 'string' ? b4a.from(p) : p)
  return h.digest()
}

function boxKeyPair (identity) {
  const seed = identity.seed || sha256(identity.keyPair.secretKey)
  const publicKey = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_box_SECRETKEYBYTES)
  sodium.crypto_box_seed_keypair(publicKey, secretKey, sha256('hg-v2-box\0', seed))
  return { publicKey, secretKey }
}

function seal (message, publicKey) {
  const out = b4a.alloc(message.length + sodium.crypto_box_SEALBYTES)
  sodium.crypto_box_seal(out, message, publicKey)
  return out
}

/** The sealed message, or null if it isn't for this key pair (or is garbage). */
function openSealed (sealed, keyPair) {
  if (!b4a.isBuffer(sealed) || sealed.length < sodium.crypto_box_SEALBYTES) return null
  const out = b4a.alloc(sealed.length - sodium.crypto_box_SEALBYTES)
  try {
    return sodium.crypto_box_seal_open(out, sealed, keyPair.publicKey, keyPair.secretKey) ? out : null
  } catch {
    return null
  }
}

function newEpochKey () {
  const key = b4a.alloc(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  sodium.randombytes_buf(key)
  return key
}

/** What the control log records for an epoch: a grant must open to a key with this hash. */
function commitOf (key) {
  return sha256('hg-v2-epoch\0', key)
}

function messageAD (communityKey, channel, logKey, epoch, t) {
  return sha256('hg-v2-msg\0', communityKey, channel + '\0', logKey, `${epoch}\0${t}`)
}

function encryptMessage (key, ad, plaintext) {
  const nonce = b4a.alloc(NONCE_BYTES)
  sodium.randombytes_buf(nonce)
  const box = b4a.alloc(plaintext.length + TAG_BYTES)
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(box, plaintext, ad, null, nonce, key)
  return { nonce, box }
}

/** The plaintext, or null if the key, context or box doesn't match. */
function decryptMessage (key, ad, nonce, box) {
  if (!b4a.isBuffer(box) || box.length < TAG_BYTES || !b4a.isBuffer(nonce) || nonce.length !== NONCE_BYTES) return null
  const out = b4a.alloc(box.length - TAG_BYTES)
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(out, null, box, ad, nonce, key)
    return out
  } catch {
    return null
  }
}

module.exports = { boxKeyPair, seal, openSealed, newEpochKey, commitOf, messageAD, encryptMessage, decryptMessage, sha256, NONCE_BYTES }

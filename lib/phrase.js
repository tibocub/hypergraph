// The recovery phrase on this device (research.md A4): the person chooses what
// happens to it once it is shown. Until then it stays in its own file in the
// instance folder (not in the index, whose database keeps old copies of
// overwritten values); `protect` replaces it with a copy sealed by a password
// (Argon2id + XSalsa20-Poly1305), `forget` overwrites the file and removes it.
// Devices never need the phrase to work; only restoring elsewhere does.

const fs = require('fs')
const path = require('path')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const { HypergraphError } = require('./errors.js')

const FILE = 'recovery-phrase'

const file = (dir) => path.join(dir, FILE)

// { phrase } | { sealed: { salt, nonce, box } } | null
function read (dir) {
  let text = null
  try { text = fs.readFileSync(file(dir), 'utf-8') } catch { return null }
  try { return JSON.parse(text) } catch { return null }
}

function write (dir, value) {
  const tmp = file(dir) + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value))
  fs.renameSync(tmp, file(dir))
}

function save (dir, phrase) {
  write(dir, { phrase })
}

// Overwrites the file before removing it, so the words don't stay in its
// freed blocks.
function forget (dir) {
  let size = 0
  try { size = fs.statSync(file(dir)).size } catch { return }
  fs.writeFileSync(file(dir), b4a.alloc(size))
  fs.unlinkSync(file(dir))
}

function keyFrom (password, salt) {
  const key = b4a.alloc(sodium.crypto_secretbox_KEYBYTES)
  sodium.crypto_pwhash(key, b4a.from(password), salt, sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE, sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE, sodium.crypto_pwhash_ALG_DEFAULT)
  return key
}

function protect (dir, password) {
  if (typeof password !== 'string' || !password) throw new TypeError('A password is a non-empty string')
  const held = read(dir)
  if (!held) throw new HypergraphError('NOT_FOUND', 'This device holds no recovery phrase (forgotten, or added by another device)')
  if (held.sealed) throw new HypergraphError('NOT_ALLOWED', 'The recovery phrase is already protected by a password')
  const salt = b4a.alloc(sodium.crypto_pwhash_SALTBYTES)
  const nonce = b4a.alloc(sodium.crypto_secretbox_NONCEBYTES)
  sodium.randombytes_buf(salt)
  sodium.randombytes_buf(nonce)
  const message = b4a.from(held.phrase)
  const box = b4a.alloc(message.byteLength + sodium.crypto_secretbox_MACBYTES)
  sodium.crypto_secretbox_easy(box, message, nonce, keyFrom(password, salt))
  forget(dir)
  write(dir, { sealed: { salt: hex(salt), nonce: hex(nonce), box: hex(box) } })
}

// The phrase, null if this device holds none; NOT_ALLOWED without the right
// password once it is protected.
function open (dir, password) {
  const held = read(dir)
  if (!held) return null
  if (!held.sealed) return held.phrase
  if (typeof password !== 'string') throw new HypergraphError('NOT_ALLOWED', 'The recovery phrase is protected by a password: recoveryPhrase(password)')
  const box = b4a.from(held.sealed.box, 'hex')
  const message = b4a.alloc(box.byteLength - sodium.crypto_secretbox_MACBYTES)
  const ok = sodium.crypto_secretbox_open_easy(message, box, b4a.from(held.sealed.nonce, 'hex'), keyFrom(password, b4a.from(held.sealed.salt, 'hex')))
  if (!ok) throw new HypergraphError('NOT_ALLOWED', 'Wrong password for the recovery phrase')
  return b4a.toString(message)
}

function hex (b) {
  return b4a.toString(b, 'hex')
}

module.exports = { save, forget, protect, open }

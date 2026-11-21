// A deniable vault, prototype. One file of a fixed size, all random-looking:
//
//   [ salt 32 B ][ 16 header slots x 4 KiB ][ pages x 4 KiB ... ]
//
// A password runs Argon2id once (with the file's salt) and tries every slot:
// the slot whose AEAD tag checks is that identity's. Unused slots and pages are
// the random fill, so nothing says how many identities exist.
// Each page: nonce 24 B | ciphertext | tag 16 B, its index as associated data
// (a page moved elsewhere fails to open). An identity's header lists the pages
// of its page map; the map lists its data pages.
//
// shortcut: allocation avoids only the pages of identities opened together
// (pass every password, or nest them as Shufflecake does); writing with one
// identity open can overwrite another's pages. See research.md.
// shortcut: the header holds at most ~1,000 map pages (~1 M data pages, 4 GiB).

const fs = require('fs')
const sodium = require('sodium-native')

const SALT = 32
const SLOTS = 16
const PAGE = 4096
const NONCE = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES // 24
const TAG = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES // 16
const PAYLOAD = PAGE - NONCE - TAG // 4056
const DATA = SALT + SLOTS * PAGE
const PER_MAP = Math.floor(PAYLOAD / 4) - 1 // page numbers per map page (first u32: count)

const KDF = { ops: sodium.crypto_pwhash_OPSLIMIT_MODERATE, mem: sodium.crypto_pwhash_MEMLIMIT_MODERATE }

function format (file, size, { fill = 64 << 20 } = {}) {
  const pages = Math.floor((size - DATA) / PAGE)
  if (pages < 1) throw new Error('too small')
  const fd = fs.openSync(file, 'w')
  const buf = Buffer.alloc(fill)
  for (let pos = 0, end = DATA + pages * PAGE; pos < end; pos += fill) {
    const n = Math.min(fill, end - pos)
    sodium.randombytes_buf(buf.subarray(0, n))
    fs.writeSync(fd, buf, 0, n, pos)
  }
  fs.closeSync(fd)
  return pages
}

function deriveKey (salt, password, kdf = KDF) {
  const key = Buffer.alloc(32)
  sodium.crypto_pwhash(key, Buffer.from(password), salt.subarray(0, sodium.crypto_pwhash_SALTBYTES), kdf.ops, kdf.mem, sodium.crypto_pwhash_ALG_ARGON2ID13)
  return key
}

// One key per password; header and pages get their own subkeys.
function subkey (key, ctx) {
  const out = Buffer.alloc(32)
  sodium.crypto_generichash(out, Buffer.from(ctx), key)
  return out
}

function seal (key, plain, ad) {
  const out = Buffer.alloc(PAGE)
  sodium.randombytes_buf(out.subarray(0, NONCE))
  const body = Buffer.alloc(PAYLOAD)
  plain.copy(body)
  if (plain.length < PAYLOAD) sodium.randombytes_buf(body.subarray(plain.length)) // pad with random, not zeros
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(out.subarray(NONCE), body, ad, null, out.subarray(0, NONCE), key)
  return out
}

function unseal (key, page, ad) {
  const plain = Buffer.alloc(PAYLOAD)
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(plain, null, page.subarray(NONCE), ad, page.subarray(0, NONCE), key)
    return plain
  } catch { return null }
}

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }

class Vault {
  constructor (fd, pages) {
    this.fd = fd
    this.pages = pages
    this.ids = [] // opened identities: { slot, hkey, pkey, map: [page numbers], mapPages: [] }
  }

  static open (file, passwords, { kdf = KDF, create = false } = {}) {
    const fd = fs.openSync(file, 'r+')
    const size = fs.fstatSync(fd).size
    const v = new Vault(fd, Math.floor((size - DATA) / PAGE))
    const salt = Buffer.alloc(SALT)
    fs.readSync(fd, salt, 0, SALT, 0)
    const slots = Buffer.alloc(SLOTS * PAGE)
    fs.readSync(fd, slots, 0, slots.length, SALT)
    for (const pw of passwords) {
      const key = deriveKey(salt, pw, kdf)
      const hkey = subkey(key, 'header')
      const pkey = subkey(key, 'pages')
      let found = null
      for (let s = 0; s < SLOTS && !found; s++) {
        const plain = unseal(hkey, slots.subarray(s * PAGE, (s + 1) * PAGE), u32(s))
        if (plain) found = { slot: s, plain }
      }
      if (found) {
        const id = { slot: found.slot, hkey, pkey, mapPages: [], map: [] }
        const n = found.plain.readUInt32LE(0)
        for (let i = 0; i < n; i++) id.mapPages.push(found.plain.readUInt32LE(4 + i * 4))
        for (const mp of id.mapPages) {
          const plain = v._readRaw(pkey, mp)
          if (!plain) throw new Error('map page damaged (overwritten by another identity?)')
          const k = plain.readUInt32LE(0)
          for (let i = 0; i < k; i++) id.map.push(plain.readUInt32LE(4 + i * 4))
        }
        v.ids.push(id)
      } else if (create) {
        // A free slot: one no opened identity uses. shortcut: a slot used by an
        // unopened identity looks free too; the creator must pass all passwords.
        const used = new Set(v.ids.map((i) => i.slot))
        const free = []
        for (let s = 0; s < SLOTS; s++) if (!used.has(s)) free.push(s)
        if (!free.length) throw new Error('no free slot')
        const slot = free[sodium.randombytes_uniform(free.length)]
        const id = { slot, hkey, pkey, mapPages: [], map: [] }
        v.ids.push(id)
        v._writeHeader(id)
      } else {
        v.ids.push(null) // wrong password, or no identity: indistinguishable
      }
    }
    return v
  }

  _readRaw (pkey, n) {
    const page = Buffer.alloc(PAGE)
    fs.readSync(this.fd, page, 0, PAGE, DATA + n * PAGE)
    return unseal(pkey, page, u32(n))
  }

  _writeRaw (pkey, n, plain) {
    fs.writeSync(this.fd, seal(pkey, plain, u32(n)), 0, PAGE, DATA + n * PAGE)
  }

  _writeHeader (id) {
    const plain = Buffer.alloc(4 + id.mapPages.length * 4)
    plain.writeUInt32LE(id.mapPages.length, 0)
    id.mapPages.forEach((p, i) => plain.writeUInt32LE(p, 4 + i * 4))
    if (plain.length > PAYLOAD) throw new Error('header full')
    fs.writeSync(this.fd, seal(id.hkey, plain, u32(id.slot)), 0, PAGE, SALT + id.slot * PAGE)
  }

  // Pages taken by every opened identity; picks a random free one.
  _alloc (taken) {
    for (let tries = 0; tries < 1000; tries++) {
      const n = sodium.randombytes_uniform(this.pages)
      if (!taken.has(n)) { taken.add(n); return n }
    }
    throw new Error('vault full (as far as the opened identities know)')
  }

  _taken () {
    const t = new Set()
    for (const id of this.ids) if (id) { for (const p of id.map) t.add(p); for (const p of id.mapPages) t.add(p) }
    return t
  }

  // Logical page i of identity `who` (index in ids).
  write (who, i, data, taken = this._taken()) {
    const id = this.ids[who]
    while (id.map.length <= i) id.map.push(this._alloc(taken))
    this._writeRaw(id.pkey, id.map[i], data)
  }

  read (who, i) {
    const id = this.ids[who]
    if (i >= id.map.length) return null
    return this._readRaw(id.pkey, id.map[i])
  }

  // Writes the page map and header. A real vault would copy-on-write the map
  // (a crash mid-write loses it); fine for a prototype.
  commit (who) {
    const id = this.ids[who]
    const taken = this._taken()
    const need = Math.ceil(id.map.length / PER_MAP)
    while (id.mapPages.length < need) id.mapPages.push(this._alloc(taken))
    for (let m = 0; m < need; m++) {
      const part = id.map.slice(m * PER_MAP, (m + 1) * PER_MAP)
      const plain = Buffer.alloc(4 + part.length * 4)
      plain.writeUInt32LE(part.length, 0)
      part.forEach((p, k) => plain.writeUInt32LE(p, 4 + k * 4))
      this._writeRaw(id.pkey, id.mapPages[m], plain)
    }
    this._writeHeader(id)
  }

  close () { fs.closeSync(this.fd) }
}

module.exports = { Vault, format, deriveKey, KDF, PAGE, PAYLOAD, DATA, SLOTS, SALT }

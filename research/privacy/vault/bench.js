// Vault speed: node research/privacy/vault/bench.js [sizeMB=256] [writeMB=32]
// KDF time, random fill, encrypted page write/read (random placement) against
// a plain file written the same way and sequentially.
const fs = require('fs')
const path = require('path')
const os = require('os')
const sodium = require('sodium-native')
const { Vault, format, deriveKey, PAYLOAD, PAGE } = require('./vault.js')

const sizeMB = +process.argv[2] || 256
const writeMB = +process.argv[3] || 32
const dir = fs.mkdtempSync(path.join(process.env.HG_TEST_TMP || os.tmpdir(), 'vault-bench-'))
const file = path.join(dir, 'vault.bin')
const t = () => Number(process.hrtime.bigint()) / 1e6
const mbs = (bytes, ms) => (bytes / 1e6 / (ms / 1000)).toFixed(1) + ' MB/s'
const out = {}

for (const [name, kdf] of Object.entries({
  interactive: { ops: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE, mem: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE },
  moderate: { ops: sodium.crypto_pwhash_OPSLIMIT_MODERATE, mem: sodium.crypto_pwhash_MEMLIMIT_MODERATE },
  sensitive: { ops: sodium.crypto_pwhash_OPSLIMIT_SENSITIVE, mem: sodium.crypto_pwhash_MEMLIMIT_SENSITIVE }
})) {
  const s = t(); deriveKey(Buffer.alloc(32, 1), 'pw', kdf)
  out['argon2id ' + name + ` (ops ${kdf.ops}, ${kdf.mem >> 20} MiB)`] = (t() - s).toFixed(0) + ' ms'
}

// CPU only: sealing pages in memory.
{
  const key = Buffer.alloc(32, 2); const body = Buffer.alloc(PAYLOAD); const page = Buffer.alloc(PAGE); const ad = Buffer.alloc(4)
  const n = 20000; const s = t()
  for (let i = 0; i < n; i++) sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(page.subarray(24), body, ad, null, page.subarray(0, 24), key)
  out['seal in memory (CPU)'] = mbs(n * PAYLOAD, t() - s)
}

let s = t(); format(file, sizeMB << 20)
out[`format ${sizeMB} MB (random fill)`] = mbs(sizeMB << 20, t() - s)

const FAST = { ops: 1, mem: 8 << 20 }
const v = Vault.open(file, ['bench'], { kdf: FAST, create: true })
const n = Math.floor((writeMB << 20) / PAYLOAD)
const data = Buffer.alloc(PAYLOAD, 7)
const taken = v._taken()
s = t(); for (let i = 0; i < n; i++) v.write(0, i, data, taken); v.commit(0); fs.fsyncSync(v.fd)
out[`vault write ${writeMB} MB, random pages + fsync`] = mbs(n * PAYLOAD, t() - s)
s = t(); for (let i = 0; i < n; i++) v.read(0, i)
out[`vault read ${writeMB} MB, random pages (OS cache warm)`] = mbs(n * PAYLOAD, t() - s)
v.close()

// Plain file, same pages: sequential, then random.
const plain = path.join(dir, 'plain.bin')
let fd = fs.openSync(plain, 'w'); const buf = Buffer.alloc(PAGE, 7)
s = t(); for (let i = 0; i < n; i++) fs.writeSync(fd, buf, 0, PAGE, i * PAGE); fs.fsyncSync(fd)
out[`plain write ${writeMB} MB, sequential + fsync`] = mbs(n * PAYLOAD, t() - s)
fs.closeSync(fd)
fd = fs.openSync(file, 'r+')
const pages = Math.floor((sizeMB << 20) / PAGE) - 20
s = t(); for (let i = 0; i < n; i++) fs.writeSync(fd, buf, 0, PAGE, sodium.randombytes_uniform(pages) * PAGE); fs.fsyncSync(fd)
out[`plain write ${writeMB} MB, random pages + fsync`] = mbs(n * PAYLOAD, t() - s)
// Random 1 MiB extents, pages in order inside each: what a log-structured vault would do.
const ext = Buffer.alloc(1 << 20, 7); const extents = Math.floor((sizeMB << 20) / ext.length) - 1
s = t(); for (let i = 0; i < writeMB; i++) fs.writeSync(fd, ext, 0, ext.length, (1 + sodium.randombytes_uniform(extents)) * ext.length); fs.fsyncSync(fd)
out[`plain write ${writeMB} MB, random 1 MiB extents + fsync`] = mbs(writeMB << 20, t() - s)
fs.closeSync(fd)

out.disk = process.env.HG_TEST_TMP || os.tmpdir()
console.log(JSON.stringify(out, null, 2))
fs.rmSync(dir, { recursive: true })

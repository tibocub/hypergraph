// Self-check for vault.js (not in npm test): node research/privacy/vault/test.js
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { Vault, format, PAYLOAD } = require('./vault.js')

const FAST = { ops: 1, mem: 8 << 20 } // tests only
const dir = fs.mkdtempSync(path.join(process.env.HG_TEST_TMP || os.tmpdir(), 'vault-'))
const file = path.join(dir, 'vault.bin')

// Chi-square of byte counts: random data stays near 255 (df), < 330 at p = 0.001.
function chi2 (buf) {
  const counts = new Array(256).fill(0)
  for (const b of buf) counts[b]++
  const e = buf.length / 256
  return counts.reduce((s, c) => s + (c - e) ** 2 / e, 0)
}

format(file, 8 << 20)
let v = Vault.open(file, ['alice', 'bob'], { kdf: FAST, create: true })
const msg = (s) => Buffer.from(s.padEnd(100, '.'))
for (let i = 0; i < 50; i++) { v.write(0, i, msg('alice ' + i)); v.write(1, i, msg('bob ' + i)) }
v.commit(0); v.commit(1); v.close()

assert.ok(chi2(fs.readFileSync(file)) < 330, 'the vault looks random')

v = Vault.open(file, ['bob'], { kdf: FAST })
assert.strictEqual(v.read(0, 7).subarray(0, 5).toString(), 'bob 7')
v.close()
v = Vault.open(file, ['nobody'], { kdf: FAST })
assert.strictEqual(v.ids[0], null, 'a wrong password finds nothing')
v.close()

// The known limit: alice alone doesn't know bob's pages and may overwrite them.
v = Vault.open(file, ['alice'], { kdf: FAST })
for (let i = 50; i < 1500; i++) v.write(0, i, Buffer.alloc(PAYLOAD, 1))
v.commit(0); v.close()
let lost = 0
try {
  v = Vault.open(file, ['bob'], { kdf: FAST })
  for (let i = 0; i < 50; i++) if (!v.read(0, i)) lost++
  v.close()
} catch { lost = 'map' }
console.log('bob pages lost after alice wrote 1,450 pages alone (of ~2,030):', lost)
assert.ok(lost === 'map' || lost > 0, 'writing alone overwrote a hidden identity, as expected')

fs.rmSync(dir, { recursive: true })
console.log('ok')

// What secure conversations would cost per message and per key change, against today's private
// spaces. Runs on Node and Bare: `node research/secure-chats/cost.js`, `bare research/secure-chats/cost.js`.
// Crypto only (sodium-universal, as lib/private/crypto.js): no network, no disk, no index.
// Record sizes reuse lib/encodings.js's padding; the fields around a chat text are an assumption
// (RECORD_EXTRA), see the spec.

const sodium = require('sodium-universal')
const b4a = require('b4a')
const { paddedSize } = require('../../lib/encodings.js')

const KEY = 32
const NONCE = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
const TAG = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES
const CTX = b4a.from('hgchain1') // crypto_kdf context: 8 bytes
const RECORD_EXTRA = 60 // a chat record's type, stamp, field framing around its text (assumed)
const ENVELOPE_TODAY = 1 + 8 + NONCE + 2 + TAG // epoch, commit (8 B), nonce, box length, tag
const varint = (n) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : 5) // compact-encoding uint

// Chat lines: log-normal lengths, median 40 characters (as spec 030's chat lines).
let seed = 7
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
const lengths = Array.from({ length: 20000 }, () => Math.max(1, Math.round(40 * Math.exp(0.9 * Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand())))))

function kdfStep (ck, nextCk, mk) {
  sodium.crypto_kdf_derive_from_key(mk, 1, CTX, ck)
  sodium.crypto_kdf_derive_from_key(nextCk, 2, CTX, ck)
}

function seal (key, plain, out, nonce) {
  sodium.randombytes_buf(nonce)
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(out, plain, null, null, nonce, key)
}

function open (key, box, out, nonce) {
  sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(out, null, box, null, nonce, key)
}

// Median of 5 runs of fn(i) for n iterations, in microseconds per iteration.
function bench (n, fn) {
  const runs = []
  for (let r = 0; r < 5; r++) {
    const t = Date.now()
    for (let i = 0; i < n; i++) fn(i)
    runs.push(((Date.now() - t) * 1000) / n)
  }
  runs.sort((a, b) => a - b)
  return runs[2]
}

const runtime = typeof Bare !== 'undefined' ? 'Bare ' + Bare.version : 'Node ' + process.version // eslint-disable-line no-undef
console.log(`# ${runtime}`)

// Bytes: the padded block of each chat line, today and with a chain index in the envelope.
let today = 0
let chains = 0
let crossed = 0
for (let i = 0; i < lengths.length; i++) {
  const inner = lengths[i] + RECORD_EXTRA
  const a = paddedSize(3 + inner + ENVELOPE_TODAY)
  const b = paddedSize(3 + inner + ENVELOPE_TODAY + varint(i % 5000))
  today += a
  chains += b
  if (b !== a) crossed++
}
console.log(`bytes per chat line, padded: today ${(today / lengths.length).toFixed(1)} B, with chains ${(chains / lengths.length).toFixed(1)} B (+${(100 * (chains - today) / today).toFixed(2)}%), ${(100 * crossed / lengths.length).toFixed(2)}% move up one size`)

// CPU per message: the sealing alone (today) vs a chain step and the sealing (new).
const ck = b4a.alloc(KEY)
const next = b4a.alloc(KEY)
const mk = b4a.alloc(KEY)
const epochKey = b4a.alloc(KEY)
sodium.randombytes_buf(ck)
sodium.randombytes_buf(epochKey)
const plain = b4a.alloc(256 - 3 - ENVELOPE_TODAY) // the common case: a line under the 256 B minimum
const box = b4a.alloc(plain.byteLength + TAG)
const back = b4a.alloc(plain.byteLength)
const nonce = b4a.alloc(NONCE)
const N = 20000
const send0 = bench(N, () => seal(epochKey, plain, box, nonce))
const send1 = bench(N, () => { kdfStep(ck, next, mk); ck.set(next); seal(mk, plain, box, nonce); mk.fill(0) })
seal(epochKey, plain, box, nonce)
const recv0 = bench(N, () => open(epochKey, box, back, nonce))
const recv1 = bench(N, () => { kdfStep(ck, next, mk); ck.set(next); open(epochKey, box, back, nonce) }) // same work as opening with mk
console.log(`send, µs/message: today ${send0.toFixed(2)}, with chains ${send1.toFixed(2)}`)
console.log(`receive, µs/message: today ${recv0.toFixed(2)}, with chains ${recv1.toFixed(2)}`)
const skip = bench(N, () => { kdfStep(ck, next, mk); ck.set(next) })
console.log(`skipping ahead, µs/skipped key: ${skip.toFixed(2)} (10,000 skipped: ${(skip * 10).toFixed(1)} ms; kept, 32 B each: 320 KB)`)

// Per key change, for a conversation of `devices` devices: the decider seals the new epoch key to
// each device's prekey; each device opens its grant, derives every writer's chain start and makes
// its next prekey.
const kp = { publicKey: b4a.alloc(32), secretKey: b4a.alloc(32) }
sodium.crypto_box_keypair(kp.publicKey, kp.secretKey)
const sealed = b4a.alloc(KEY + sodium.crypto_box_SEALBYTES)
const opened = b4a.alloc(KEY)
const chainStart = b4a.alloc(KEY)
const writer = b4a.alloc(32 + 32 + 8) // space key, writer log key, commitment
const pk = b4a.alloc(32)
const sk = b4a.alloc(32)
for (const devices of [2, 10, 50, 100]) {
  const grant = bench(Math.max(20, 2000 / devices), () => { for (let d = 0; d < devices; d++) sodium.crypto_box_seal(sealed, epochKey, kp.publicKey) })
  sodium.crypto_box_seal(sealed, epochKey, kp.publicKey)
  const join = bench(Math.max(20, 2000 / devices), () => {
    sodium.crypto_box_seal_open(opened, sealed, kp.publicKey, kp.secretKey)
    for (let w = 0; w < devices; w++) sodium.crypto_generichash(chainStart, writer, opened)
    sodium.crypto_box_keypair(pk, sk)
  })
  // a grant record (to, epoch, commitment, sealed key) and a prekey record are each one 256 B block
  console.log(`key change, ${devices} devices: decider ${(grant / 1000).toFixed(2)} ms, each device ${(join / 1000).toFixed(3)} ms, written ${(devices * 2 * 256 / 1024).toFixed(1)} KB (${devices} grants + ${devices} prekeys, 256 B blocks)`)
}

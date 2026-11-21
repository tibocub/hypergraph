// Padding cost on hypergraph's real blocks: node research/privacy/padding/measure.js
// Writes a mix of chat lines, posts, comments and votes into a private forum
// (the forum scenario API, offline), then reads every block as a holder sees
// it (ciphertext, no key) and prices padding schemes on those sizes.
// Text lengths: log-normal, medians chat 40, comment 150, post 600 characters
// (assumed; see research.md).
const fs = require('fs')
const path = require('path')
const os = require('os')
const Corestore = require('corestore')
const forum = require('../../../test/next/forum/forum.js')

const tmp = fs.mkdtempSync(path.join(process.env.HG_TEST_TMP || os.tmpdir(), 'pad-'))
let seed = 42
const rand = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } // mulberry32
const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand())
const words = 'the a of to and in is it you that was for on are with as I his they be at one have this from'.split(' ')
const text = (median, sigma = 1) => {
  const n = Math.max(1, Math.min(20000, Math.round(median * Math.exp(sigma * gauss()))))
  let s = ''
  while (s.length < n) s += words[Math.floor(rand() * words.length)] + ' '
  return s.slice(0, n)
}

const SCHEMES = {
  none: (n) => n,
  'Signal-style 160 B steps': (n) => Math.ceil(n / 160) * 160,
  'Padmé (PURBs)': (n) => {
    if (n < 2) return n
    const e = Math.floor(Math.log2(n)); const s = Math.floor(Math.log2(e)) + 1
    const z = e - s; const mask = (1 << z) - 1
    return (n + mask) & ~mask
  },
  'at least 256 B, then Padmé': (n) => n <= 256 ? 256 : SCHEMES['Padmé (PURBs)'](n),
  'buckets 256 B / 1 / 4 / 16 / 64 KiB': (n) => [256, 1024, 4096, 16384, 65536].find((b) => b >= n) || n,
  'powers of 2 from 256 B': (n) => Math.max(256, 2 ** Math.ceil(Math.log2(n))),
  'buckets 512 B / 4 KiB / 16 KiB / 64 KiB': (n) => [512, 4096, 16384, 65536].find((b) => b >= n) || n,
  'buckets 1 KiB / 16 KiB / 64 KiB': (n) => [1024, 16384, 65536].find((b) => b >= n) || n
}

;(async () => {
  const dir = path.join(tmp, 'a')
  const hg = await forum.signUp(dir, { bootstrap: [] }) // connectToSwarm with no DHT: fine offline
  const f = await forum.createForum(hg, 'Private room', { private: true })
  const posts = []
  for (let i = 0; i < 100; i++) posts.push(await forum.post(f, text(40, 0.5), text(600, 0.9), 'topic' + (i % 5)))
  const counts = { chat: 0, comment: 0, vote: 0 }
  for (let i = 0; i < 1500; i++) {
    const on = posts[Math.floor(rand() * posts.length)]
    const r = rand()
    if (r < 0.5) { await forum.comment(f, on, text(40)); counts.chat++ } // chat lines: short replies
    else if (r < 0.75) { await forum.comment(f, on, text(150)); counts.comment++ } else { await forum.vote(f, on, 1); counts.vote++ }
  }
  await hg.close()

  // Every block as stored and replicated (encrypted: read without its key).
  const store = new Corestore(path.join(dir, 'cores'))
  const sizes = []
  for await (const dk of store.storage.createDiscoveryKeyStream()) {
    const core = store.get({ discoveryKey: dk })
    await core.ready()
    for (let i = 0; i < core.length; i++) sizes.push((await core.get(i, { valueEncoding: 'binary', wait: false })).byteLength)
    await core.close()
  }
  await store.close()
  sizes.sort((a, b) => a - b)
  const q = (p) => sizes[Math.floor(p * (sizes.length - 1))]
  const total = sizes.reduce((a, b) => a + b, 0)
  console.log(`written: 100 posts, ${counts.chat} chat lines, ${counts.comment} comments, ${counts.vote} votes`)
  console.log(`blocks: ${sizes.length}, bytes ${total}, median ${q(0.5)} B, p10 ${q(0.1)}, p90 ${q(0.9)}, p99 ${q(0.99)}, max ${sizes[sizes.length - 1]}`)
  for (const [name, f] of Object.entries(SCHEMES)) {
    const padded = sizes.map(f)
    const sum = padded.reduce((a, b) => a + b, 0)
    console.log(`${name.padEnd(42)} +${((sum / total - 1) * 100).toFixed(0).padStart(4)}%   distinct sizes: ${new Set(padded).size}`)
  }
  fs.rmSync(tmp, { recursive: true })
})()

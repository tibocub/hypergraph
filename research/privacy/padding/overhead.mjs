// What padding costs on a private forum's real blocks, per record type, and what each deferred
// optimization would save (estimates; none is built): node research/privacy/padding/overhead.mjs
// Three members on a local DHT write posts, chat lines, comments and votes; then the owner reads
// every block of every member's log. Texts are slices of the repo's own docs (English prose, for
// compression); lengths log-normal, medians chat 40, comment 150, post 600 characters (assumed).
// Times are simulated: each action a log-normal gap after the last (median 20 s), the records one
// action writes at the same instant (packing within 200 ms groups those).

import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { fileURLToPath } from 'url'
import c from 'compact-encoding'
import { context, eventually } from '../../../perf/harness.mjs'
import setup from '../../../test/next/forum/_setup.js'
import forum from '../../../test/next/forum/forum.js'
import testing from '../../../lib/testing.js'
import enc from '../../../lib/encodings.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const corpus = fs.readdirSync(path.join(root, 'docs/next')).filter((f) => f.endsWith('.md'))
  .map((f) => fs.readFileSync(path.join(root, 'docs/next', f), 'utf-8')).join(' ').replace(/[`#*|>[\]()_-]+/g, ' ').replace(/\s+/g, ' ')
let seed = 42
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
const gauss = () => Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand())
const text = (median, sigma = 1) => {
  const n = Math.max(1, Math.min(8000, Math.round(median * Math.exp(sigma * gauss()))))
  const at = Math.floor(rand() * (corpus.length - n))
  return corpus.slice(at, at + n)
}

const p256 = enc.paddedSize
const p128 = (n) => n <= 128 ? 128 : p256(n)
const head = (n) => 2 + (n < 0xfd ? 1 : 3) // the padded block's marker, scheme and length

const t = context()
try {
  const hgs = [await setup.account(t, 'a'), await setup.account(t, 'b'), await setup.account(t, 'c')]
  const fa = await forum.createForum(hgs[0], 'Club', { private: true })
  const spaces = [fa]
  for (const hg of hgs.slice(1)) spaces.push(await forum.join(hg, await forum.invite(fa)))

  const what = new Map() // block "log:seq" -> category
  const when = new Map() // block -> simulated ms
  let clock = 0
  const act = async (space, category, fn) => {
    clock += 20000 * Math.exp(1.5 * gauss())
    const before = space.own ? space.own.length : 1
    const r = await fn()
    if (r && r.id) what.set(r.id, category)
    const log = space.own
    for (let i = before; i < log.length; i++) when.set(enc.idToString({ log: log.key, seq: i }), clock)
  }
  const posts = []
  for (let i = 0; i < 1200; i++) {
    const s = spaces[Math.floor(rand() * 3)]
    const r = rand()
    if (r < 0.05 || !posts.length) await act(s, 'post', async () => { const p = await forum.post(s, text(40, 0.5).slice(0, 200), text(600, 0.9), 'general'); posts.push(p); return p })
    else if (r < 0.55) await act(s, 'chat line', () => forum.comment(s, posts[posts.length - 1], text(40)))
    else if (r < 0.75) await act(s, 'comment', () => forum.comment(s, posts[Math.floor(rand() * posts.length)], text(150)))
    else await act(s, 'vote (reaction)', () => forum.vote(s, posts[Math.floor(rand() * posts.length)], 1))
  }
  const total = () => spaces.reduce((n, s) => n + s.own.length - 1, 0)
  if (!await eventually(() => testing.indexedBlocks(fa) >= total(), 120000, 50)) throw new Error('the owner never got every record')

  const rows = new Map() // category -> stats
  const blocks = [] // { log, at, inner } for packing
  for (const held of fa.directory.logs.values()) {
    for (let seq = 1; seq < held.length; seq++) {
      const bytes = await fa.directory.get(held, seq, { wait: false })
      if (!bytes) continue
      const record = enc.decodeRecord(bytes)
      const inner = c.encode(enc.record, record).byteLength
      const id = enc.idToString({ log: held.key, seq })
      const category = what.get(id) || `${record.type} (members' and system records)`
      const opened = fa._unsealed(held, seq, bytes)
      const plain = opened && !record.type.startsWith('hg/') ? opened.fields : null
      const deflated = plain ? Math.min(plain.byteLength, zlib.deflateRawSync(plain, { level: 9 }).byteLength) : null
      const r = rows.get(category) || { n: 0, inner: 0, padded: 0, p128: 0, compressed: 0, sizes: new Set() }
      r.n++
      r.inner += inner
      r.padded += bytes.byteLength
      r.p128 += p128(inner + head(inner))
      r.compressed += plain ? p256(inner - plain.byteLength + deflated + head(inner)) : bytes.byteLength
      r.sizes.add(bytes.byteLength)
      rows.set(category, r)
      blocks.push({ log: id.slice(0, 10), at: when.get(id) ?? 0, inner, padded: bytes.byteLength })
    }
  }

  // Packing: a log's records written within 200 ms of the first of a group share one block,
  // each with a length prefix.
  blocks.sort((x, y) => x.log.localeCompare(y.log) || x.at - y.at)
  let packed = 0
  let groups = 0
  for (let i = 0; i < blocks.length;) {
    let j = i
    let bytes = 0
    while (j < blocks.length && blocks[j].log === blocks[i].log && blocks[j].at - blocks[i].at <= 200) bytes += blocks[j++].inner + 2
    packed += p256(bytes + head(bytes))
    groups++
    i = j
  }

  // A burst written by code (an import, a folder of small files): one log's records back to
  // back, packed into blocks of up to 4 KB.
  let bulk = 0
  for (let i = 0; i < blocks.length;) {
    let bytes = 0
    let j = i
    while (j < blocks.length && blocks[j].log === blocks[i].log && bytes + blocks[j].inner + 2 <= 4096) bytes += blocks[j++].inner + 2
    if (j === i) bytes = blocks[j++].inner + 2
    bulk += p256(bytes + head(bytes))
    i = j
  }

  // The decision log (Autobase): its blocks' sizes as stored, by its own framing.
  const local = fa.decisionLog.base.local
  const dsizes = []
  for (let i = 0; i < local.length; i++) dsizes.push((await local.get(i, { raw: true })).byteLength)

  const fmt = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(0) + '%'
  const all = { n: 0, inner: 0, padded: 0, p128: 0, compressed: 0 }
  console.log('| Records | n | real B (mean) | padded B (mean) | overhead | sizes seen | 128 B minimum | compress first |')
  console.log('|---|---|---|---|---|---|---|---|')
  for (const [category, r] of [...rows].sort((x, y) => y[1].n - x[1].n)) {
    for (const k of Object.keys(all)) all[k] += r[k]
    console.log(`| ${category} | ${r.n} | ${Math.round(r.inner / r.n)} | ${Math.round(r.padded / r.n)} | ${fmt(r.padded / r.inner - 1)} | ${r.sizes.size} | ${fmt(r.p128 / r.inner - 1)} | ${fmt(r.compressed / r.inner - 1)} |`)
  }
  console.log(`| all | ${all.n} | ${Math.round(all.inner / all.n)} | ${Math.round(all.padded / all.n)} | ${fmt(all.padded / all.inner - 1)} | | ${fmt(all.p128 / all.inner - 1)} | ${fmt(all.compressed / all.inner - 1)} |`)
  console.log(`\nbytes: real ${all.inner}, padded ${all.padded}, 128 B minimum ${all.p128}, compressed first ${all.compressed}, packed within 200 ms ${packed} (${blocks.length} records in ${groups} blocks)`)
  console.log(`a burst written back to back, packed into blocks of up to 4 KB: ${bulk} B, ${fmt(bulk / all.padded - 1)} vs padded`)
  console.log(`decision log blocks (owner, raw): ${dsizes.join(' ')}`)
  console.log(`savings vs padded: 128 B minimum ${fmt(all.p128 / all.padded - 1)}, compress first ${fmt(all.compressed / all.padded - 1)}, pack ${fmt(packed / all.padded - 1)}`)
} finally {
  await t.close()
}

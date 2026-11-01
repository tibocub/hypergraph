// swarmwire at one big file (SWARMWIRE env: its folder, default ../../../swarmwire):
// - memory of a GroupTree (one 32 B Buffer per 16 KB group, lib/tree.js) and of
//   a download's NodeStore (lib/nodes.js), for G groups;
// - how fast the pure-JS BLAKE3 hashes (lib/source.js buildTree: every open of
//   a file whose hashes don't fit the 32 MB cache, i.e. any file over 16 GB);
// - the `have` bitfield and Availability counts per peer.
//   node --expose-gc bench/scale-audit/swarmwire-tree.mjs 100000,1000000
import crypto from 'crypto'
import path from 'path'
import { pathToFileURL } from 'url'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { mb, mem } = require('./_tmp.js')

const SW = process.env.SWARMWIRE || path.resolve(import.meta.dirname, '../../../../../../swarmwire')
const { GroupTree, GroupTreeBuilder } = await import(pathToFileURL(path.join(SW, 'lib/tree.js')))
const { NodeStore } = await import(pathToFileURL(path.join(SW, 'lib/nodes.js')))
const { Availability } = await import(pathToFileURL(path.join(SW, 'lib/select.js')))

const sizes = (process.argv[2] || '100000,1000000').split(',').map(Number)
const GROUP = 16384

for (const g of sizes) {
  const before = mem()
  const hashes = []
  for (let i = 0; i < g; i++) hashes.push(crypto.randomBytes(32))
  const tree = GroupTree.fromGroupHashes(hashes, { size: g * GROUP })
  hashes.length = 0
  const t = Date.now()
  for (let i = 0; i < 1000; i++) tree.proof(Math.floor(Math.random() * g))
  const proofMs = (Date.now() - t) / 1000
  const after = mem()
  globalThis.keep = tree
  const b2 = mem()
  const ns = new NodeStore(g)
  for (let i = 0; i < g; i++) ns.set(i, i + 1, crypto.randomBytes(32))
  const a2 = mem()
  const av = new Availability(g)
  if (!tree.groupCount || !ns.count) throw new Error("unreachable") // both kept alive until measured
  console.log(`${g} groups (${(g * GROUP / 2 ** 30).toFixed(1)} GiB file): GroupTree +${mb(after.heap - before.heap + after.ext - before.ext)} (heap+buffers), proof ${(proofMs).toFixed(2)} ms after warm-up of 1000; NodeStore with every group +${mb(a2.heap - b2.heap + a2.ext - b2.ext)}; have bitfield ${mb(g / 8)} per peer; Availability ${mb(av.counts.byteLength)}`)
}

// BLAKE3 speed: 256 MB through GroupTreeBuilder in 16 KB groups
const buf = crypto.randomBytes(GROUP)
const total = 256 * 1048576
const b = new GroupTreeBuilder({})
const t = Date.now()
for (let off = 0; off < total; off += GROUP) b.push(buf)
b.finalize()
const s = (Date.now() - t) / 1000
console.log(`hashing: ${(total / 1048576 / s).toFixed(0)} MB/s (pure JS, one core) → 100 GB in ${(100 * 1024 / (total / 1048576 / s) / 60).toFixed(0)} min`)

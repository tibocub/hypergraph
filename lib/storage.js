// Storage budgets (research R14, A10; FR-027). One budget for the whole app,
// an optional budget for a space taken out of it, the rest shared by the
// other spaces in proportion to what each holds. What is never dropped (this
// identity's records, decision logs, the personal space) is never asked to go:
// the others give way.
//
// Sizes are stored bytes, estimated (src/v2's lesson: count what storing
// costs, not content). Measured on this core (2026-10-09, 2,000 records of
// 100 B and of 2 KB, after compaction): a record costs its content plus
// ~150 B in its log (Merkle nodes, bitfield, keys), and its content plus
// ~550 B in the local index (the row and its own index entries); an app
// index entry or tag key costs more (IX_OVERHEAD).

const fs = require('fs')

// App index entries and tag keys (core follow-ups, bench/next/ix-cost.js,
// 2026-10-09: 1,600 records with 3 indexes): each costs ~160 B plus its key
// twice (in the row, and in the index). Kept with their row, never dropped.
const BLOCK_OVERHEAD = 150
const ROW_OVERHEAD = 550
const IX_OVERHEAD = 160
const DEFAULT_BUDGET = 5e9
const INSTANCE = 200e3 // an empty instance's two databases

// Stored bytes of `blocks` records holding `content` bytes, of which
// `droppedBlocks` records (`droppedContent` bytes) had their content dropped:
// their rows stay in the index, without content.
// `ixBytes`: what their rows' index entries cost (ixCost).
function stored ({ content = 0, blocks = 0, droppedContent = 0, droppedBlocks = 0, ixBytes = 0 }) {
  return 2 * Math.max(0, content - droppedContent) + blocks * ROW_OVERHEAD + Math.max(0, blocks - droppedBlocks) * BLOCK_OVERHEAD + ixBytes
}

// What a row's index keys (app indexes and tags, lib/index/indexer.js) cost.
function ixCost (keys) {
  let n = 0
  for (const k of keys || []) n += IX_OVERHEAD + 2 * k.length
  return n
}

// The share of each space: Map id -> bytes. `spaces`: [{ id, used, floor,
// budget, keep }] — `used` what it stores, `floor` what it can't drop,
// `budget` its own (or null), `keep` never dropped at all (the personal
// space). `fixed`: bytes the app uses outside any space.
function shares ({ app, spaces, fixed = 0 }) {
  const out = new Map()
  let pool = app - fixed
  let rest = []
  for (const s of spaces) {
    if (s.keep) out.set(s.id, s.used)
    else if (s.budget !== null && s.budget !== undefined) out.set(s.id, Math.max(s.budget, s.floor))
    else {
      rest.push(s)
      continue
    }
    pool -= out.get(s.id)
  }
  // In proportion to what each holds; a space whose share would be below what
  // it can't drop gets that, and the others share what is left.
  for (;;) {
    const total = rest.reduce((n, s) => n + s.used, 0)
    const share = (s) => Math.max(0, total > 0 ? pool * s.used / total : pool / rest.length)
    const low = rest.filter((s) => share(s) < s.floor)
    if (!low.length) {
      for (const s of rest) out.set(s.id, share(s))
      return out
    }
    for (const s of low) {
      out.set(s.id, s.floor)
      pool -= s.floor
    }
    rest = rest.filter((s) => !low.includes(s))
  }
}

// The app's budget when it sets none: 5 GB, or what it holds plus half the
// free disk if that is smaller. `free` null: the runtime can't tell.
function defaultBudget ({ free, used = 0 }) {
  if (typeof free !== 'number') return DEFAULT_BUDGET
  return Math.min(DEFAULT_BUDGET, used + Math.floor(free / 2))
}

// Free bytes on the disk holding `dir`, or null if this runtime can't tell
// (statfs: Node 18.15+, bare-fs 4+).
function freeDisk (dir) {
  return new Promise((resolve) => {
    if (typeof fs.statfs !== 'function') return resolve(null)
    try {
      fs.statfs(dir, (err, st) => resolve(err || !st ? null : Number(st.bavail) * Number(st.bsize)))
    } catch {
      resolve(null)
    }
  })
}

module.exports = { stored, ixCost, IX_OVERHEAD, shares, defaultBudget, freeDisk, BLOCK_OVERHEAD, ROW_OVERHEAD, DEFAULT_BUDGET, INSTANCE }

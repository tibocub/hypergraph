// Story 6 (FR-027, research.md A10): the app budget, how it is shared between
// spaces, and how much storing records costs. Pure functions, no network.

const test = require('brittle')
const storage = require('../../../lib/storage.js')
const { tmpDir } = require('../helpers.js')

const GB = 1e9

test('a space with its own budget gets it; the others share the rest in proportion to what they hold', (t) => {
  const shares = storage.shares({
    app: 10 * GB,
    spaces: [
      { id: 'own', used: 3 * GB, floor: 0, budget: 1 * GB },
      { id: 'big', used: 12 * GB, floor: 0, budget: null },
      { id: 'small', used: 6 * GB, floor: 0, budget: null }
    ]
  })
  t.is(shares.get('own'), 1 * GB, 'its own budget')
  t.is(shares.get('big'), 6 * GB, 'two thirds of the 9 GB left')
  t.is(shares.get('small'), 3 * GB, 'one third')
})

test('spaces that fit keep a share at least as big as what they hold', (t) => {
  const shares = storage.shares({ app: 10 * GB, spaces: [{ id: 'a', used: 1 * GB, floor: 0, budget: null }, { id: 'b', used: 3 * GB, floor: 0, budget: null }] })
  t.ok(shares.get('a') >= 1 * GB && shares.get('b') >= 3 * GB)
  t.is(shares.get('a') + shares.get('b'), 10 * GB)
})

test('what can\'t be dropped is never asked to go: the others give way', (t) => {
  const shares = storage.shares({
    app: 10 * GB,
    spaces: [
      { id: 'personal', used: 1 * GB, floor: 1 * GB, budget: null, keep: true },
      { id: 'mine', used: 8 * GB, floor: 6 * GB, budget: null },
      { id: 'other', used: 8 * GB, floor: 0, budget: null }
    ]
  })
  t.is(shares.get('personal'), 1 * GB, 'the personal space keeps everything')
  t.is(shares.get('mine'), 6 * GB, 'never below what it can\'t drop (its own records)')
  t.is(shares.get('other'), 3 * GB, 'the rest')
})

test('an app budget smaller than what can\'t be dropped: every space at its floor', (t) => {
  const shares = storage.shares({ app: 1 * GB, spaces: [{ id: 'a', used: 3 * GB, floor: 2 * GB, budget: null }, { id: 'b', used: 3 * GB, floor: 0, budget: null }] })
  t.is(shares.get('a'), 2 * GB)
  t.is(shares.get('b'), 0)
})

test('stored bytes: content twice (log and index), plus per record ~150 B in the log and ~550 B in the index', (t) => {
  const full = storage.stored({ content: 2000 * 2000, blocks: 2000 })
  t.ok(Math.abs(full / 2000 - 4734) / 4734 < 0.05, `about what the real core measured per 2 KB post (${full / 2000} B)`)
  const dropped = storage.stored({ content: 2000 * 2000, blocks: 2000, droppedContent: 1000 * 2000, droppedBlocks: 1000 })
  t.is(full - dropped, 1000 * (2 * 2000 + storage.BLOCK_OVERHEAD), 'dropping a record frees its content twice and its block\'s overhead; its row stays')
})

test('the default app budget: 5 GB, or less when half the free disk is smaller', (t) => {
  t.is(storage.defaultBudget({ free: 100 * GB, used: 0 }), 5 * GB)
  t.is(storage.defaultBudget({ free: 4 * GB, used: 1 * GB }), 3 * GB, 'what it holds plus half the free disk')
  t.is(storage.defaultBudget({ free: null, used: 0 }), 5 * GB, 'the runtime can\'t tell: 5 GB')
})

test('free disk is reported on this runtime (Node and Bare)', async (t) => {
  const free = await storage.freeDisk(tmpDir(t))
  t.ok(typeof free === 'number' && free > 0, `free: ${free}`)
  t.is(await storage.freeDisk('/no/such/folder/at/all'), null, 'null when it can\'t tell')
})

test('app index entries count (core follow-ups): each ~160 B plus its key twice (the row and the index)', (t) => {
  t.is(storage.ixCost([]), 0)
  t.is(storage.ixCost(['topic\0rust']), storage.IX_OVERHEAD + 2 * 10, 'measured: bench/next/ix-cost.js')
  const without = storage.stored({ content: 1000, blocks: 10 })
  t.is(storage.stored({ content: 1000, blocks: 10, ixBytes: 1800 }), without + 1800, 'added as they are: never dropped')
  t.is(storage.stored({ content: 1000, blocks: 10, droppedContent: 1000, droppedBlocks: 10, ixBytes: 1800 }), 10 * storage.ROW_OVERHEAD + 1800, 'a dropped record keeps its entries')
})

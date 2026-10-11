// Clearing a block must not hide the blocks after it from peers. Hypercore
// 11.37 tells peers "I hold blocks 0..n" as a contiguous length without
// per-block bits; a later "dropped block k" sets that length to k, so peers
// forget the holder still has k+1..n. A peer asks again ("want") only once
// per 2M blocks, so one that already asked for a block the holder lacked
// never gets them (specs/research/upstream/hypercore.md; research.md A5).
// lib/replication.js's clearBlocks() announces them again.

const test = require('brittle')
const Hypercore = require('hypercore')
const path = require('path')
const { clearBlocks } = require('../../../lib/replication.js')
const { tmpDir, eventually, codeOf } = require('../helpers.js')

async function pair (t) {
  const dir = tmpDir(t, 'clear')
  const writer = new Hypercore(path.join(dir, 'w'))
  await writer.ready()
  await writer.append(['header', 'deleted', 'kept', 'kept too'])
  const reader = new Hypercore(path.join(dir, 'r'), writer.key)
  await reader.ready()
  const s1 = writer.replicate(true)
  const s2 = reader.replicate(false)
  s1.pipe(s2).pipe(s1)
  t.teardown(async () => { await reader.close(); await writer.close() }, { order: 0 })
  await reader.get(0)
  const peer = reader.replicator.peers[0]
  await eventually(() => peer.remoteContiguousLength === 4, 2000)
  return { writer, reader, peer }
}

// Does the reader know the writer holds block i?
const knows = (peer, i) => peer.remoteContiguousLength > i || peer.remoteBitfield.get(i)

test('after clearing a block, peers still know the blocks after it are held', async (t) => {
  const { writer, peer } = await pair(t)
  t.ok(knows(peer, 2), 'before: the reader knows the writer holds block 2')
  await clearBlocks(writer, 1, 2)
  t.ok(await eventually(() => !knows(peer, 1), 2000), 'the reader learns block 1 is gone')
  t.ok(await eventually(() => knows(peer, 2) && knows(peer, 3), 2000), 'and still knows blocks 2 and 3 are held')
})

test('after clearing a block, a peer that already asked for a missing block still gets the blocks after it', async (t) => {
  const { writer, reader } = await pair(t)
  t.is(await codeOf(reader.get(10, { timeout: 300 })), 'REQUEST_TIMEOUT', 'the reader asks for a block the writer lacks')
  await clearBlocks(writer, 1, 2)
  t.is(await codeOf(reader.get(3, { timeout: 3000 })), null, 'it still gets block 3 from the writer')
})

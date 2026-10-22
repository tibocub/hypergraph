// Plain Hypercore only (specs/research/upstream/hypercore.md). A holds blocks
// 0..9, B is connected to A alone. A clears block 5. Can B still get block 7?
// hypercore-clear-repro.js (the lead's) says yes; this one says: not if B
// had already sent A a "want" before the clear, which a get() of a block A
// didn't have yet does ('range' mode, a finished download range, still works).
//
//   node specs/research/upstream/hypercore-clear-stall.js [plain|wanted|range]

const Hypercore = require('hypercore')
const os = require('os')
const path = require('path')
const fs = require('fs')

const mode = process.argv[2] || 'wanted'

;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-stall-'))
  const a = new Hypercore(path.join(dir, 'a'))
  await a.ready()
  for (let i = 0; i < 10; i++) await a.append('block ' + i)
  const b = new Hypercore(path.join(dir, 'b'), a.key)
  await b.ready()
  const s1 = a.replicate(true)
  const s2 = b.replicate(false)
  s1.pipe(s2).pipe(s1)
  await b.update({ wait: true })
  const peer = b.replicator.peers[0]

  // Before the clear, B asks A for something, the way apps do.
  if (mode === 'wanted') await b.get(12, { timeout: 300 }).catch(() => {}) // a block A doesn't have yet
  if (mode === 'range') await b.download({ start: 0, end: 3 }).done() // fetching a few blocks
  await new Promise((resolve) => setTimeout(resolve, 300))

  await a.clear(5, 6) // A drops block 5 only
  await new Promise((resolve) => setTimeout(resolve, 300))

  const got = await b.get(7, { timeout: 5000 }).then((x) => x.toString(), (err) => err.code)
  console.log(`${mode}: A has block 7: ${await a.has(7)}; B thinks A has it: ${peer._remoteHasBlock(7)}; wants B sent A: ${peer.stats.wireWant.tx}; B.get(7): ${got}`)
  await b.close()
  await a.close()
  fs.rmSync(dir, { recursive: true, force: true })
})()

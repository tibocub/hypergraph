// Plain Hypercore only: A holds blocks 0..9, B is connected to A alone.
// A clears block 5. Can B still get block 7 from A?
const Hypercore = require('hypercore')
const RAM = require('random-access-memory')
const os = require('os'), path = require('path'), fs = require('fs')
;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-clear-'))
  const a = new Hypercore(path.join(dir, 'a'))
  await a.ready()
  for (let i = 0; i < 10; i++) await a.append('block ' + i)
  const b = new Hypercore(path.join(dir, 'b'), a.key)
  await b.ready()
  const s1 = a.replicate(true), s2 = b.replicate(false)
  s1.pipe(s2).pipe(s1)
  await b.update({ wait: true })
  console.log('B sees length', b.length)
  await new Promise(r => setTimeout(r, 300))
  await a.clear(5, 6)                       // A drops block 5 only
  await new Promise(r => setTimeout(r, 300))
  console.log('A still has block 7:', await a.has(7))
  const peer = b.replicator.peers[0]
  console.log('B thinks A has block 7:', peer._remoteHasBlock(7), '(contiguous length B records for A:', peer._remoteContiguousLength + ')')
  const got = await Promise.race([b.get(7).then(x => x.toString()), new Promise(r => setTimeout(() => r('TIMEOUT after 5 s'), 5000))])
  console.log('B.get(7):', got)
  process.exit(0)
})()

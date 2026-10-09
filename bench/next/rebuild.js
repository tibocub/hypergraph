// SC-008: a lost index is rebuilt from the held logs. Writes N forum-shaped
// records (10% posts, 60% comments, 30% votes, as experiment 2), deletes the
// index, reopens, and times how long until every record is indexed again.
//
//   node bench/next/rebuild.js            # 10,000 records (quick)
//   node bench/next/rebuild.js 100000     # the SC-008 size (target: <= 30 s); run it alone
//
// One process, one member (its own log): the rebuild's cost per record is the
// same for other members' logs (header checks: ~0.1 ms per log).

const fs = require('fs')
const os = require('os')
const path = require('path')
const { Hypergraph } = require('../../lib/index.js')
const testing = require('../../lib/testing.js')

const N = Number(process.argv[2]) || 10000
const types = {
  post: { fields: { title: 'string', text: 'text' } },
  comment: { fields: { text: 'text', on: 'link' }, links: { on: ['post', 'comment'] } },
  vote: { fields: { value: 'int', on: 'link' }, links: { on: ['post', 'comment'] }, onePerMember: true }
}

async function main () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-bench-rebuild-'))
  try {
    let hg = await Hypergraph.open(dir, { types })
    const space = await hg.createSpace({ name: 'bench' })
    const posts = []
    const t0 = Date.now()
    for (let i = 0; i < N; i++) {
      const r = i % 10
      if (r === 0 || !posts.length) {
        posts.push(await testing.writeRaw(space, { kind: 'put', type: 'post', fields: { title: `post ${i}`, text: 'a post of about eighty bytes, like the ones experiment 2 measured' } }))
      } else if (r <= 6) {
        await testing.writeRaw(space, { kind: 'put', type: 'comment', fields: { text: `comment ${i} on a post`, on: posts[i % posts.length] } })
      } else {
        await testing.writeRaw(space, { kind: 'put', type: 'vote', fields: { value: 1, on: posts[(i * 7) % posts.length] } })
      }
    }
    await waitIndexed(space, N)
    console.log(`wrote and indexed ${N} records in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    const key = space.key
    await hg.close()

    fs.rmSync(path.join(dir, 'index'), { recursive: true, force: true })
    const t1 = Date.now()
    hg = await Hypergraph.open(dir, { types })
    const opened = Date.now() - t1
    await waitIndexed(hg.space(key), N)
    const ms = Date.now() - t1
    const count = (await hg.space(key).inspect()).records
    console.log(`rebuilt: ${(ms / 1000).toFixed(1)} s (open ${opened} ms), ${Math.round(N / (ms / 1000))} records/s; records ${JSON.stringify(count)}`)
    console.log(N >= 100000 ? `SC-008 (100,000 within 30 s): ${ms * 100000 / N <= 30000 ? 'met' : 'NOT met'}` : '(run with 100000 for SC-008)')
    await hg.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// Until `length` blocks of the space were indexed since it opened (cheap to
// poll, unlike inspect(), which counts every record).
async function waitIndexed (space, length) {
  while (testing.indexedBlocks(space) < length) await new Promise((resolve) => setTimeout(resolve, 50))
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})

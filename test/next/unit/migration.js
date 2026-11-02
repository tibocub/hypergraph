// Spec 015 (US6): a folder written before spec 015 opens with no index
// rebuild: its spaces are read with the folder-wide types they were indexed
// with until the owner's app records them in each space, which then changes
// nothing to index. The folder from before is made here (testing.js
// recordNoTypes, oldLayout): a copied folder can't be a fixture (Corestore
// refuses a folder moved or copied: its device file).

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { Hypergraph } = require('../../../lib/index.js')
const testing = require('../../../lib/testing.js')
const { tmpDir } = require('../helpers.js')

const types = {
  post: { fields: { title: 'string', text: 'text', topic: 'string' }, index: [['topic', 'stamp']] },
  comment: { fields: { text: 'text', on: 'link' }, links: { on: ['post', 'comment'] } }
}

// Forum-like types, 3 spaces (one a sub-space), 20 posts, as before spec 015.
async function folderFromBefore (t) {
  const dir = tmpDir(t, 'migration')
  const hg = await Hypergraph.open(dir, { types, bootstrap: null })
  testing.recordNoTypes(hg)
  const a = await hg.createSpace({ name: 'Forum A' })
  const b = await hg.createSpace({ name: 'Forum B' })
  const sub = await a.createSubspace({ name: 'General' })
  for (let i = 0; i < 20; i++) await [a, b, sub][i % 3].put('post', { title: 'Post ' + i, text: 'text', topic: i % 2 ? 'odd' : 'even' })
  const spaces = [a, b, sub].map((s) => s.key)
  t.is(a.typesVersion, 0, 'no types recorded')
  await testing.oldLayout(hg)
  await hg.close()
  return { dir, spaces }
}

test('a folder from before opens without indexing anything again; its spaces record their types', async (t) => {
  const { dir, spaces } = await folderFromBefore(t)
  let hg = await Hypergraph.open(dir, { types, bootstrap: null })
  let total = 0
  for (const key of spaces) {
    const s = hg.space(key)
    total += (await s.query('post').latest(50)).items.length
    t.is(testing.indexedBlocks(s), 0, 'not indexed again')
  }
  t.is(total, 20, 'every post readable')
  const forum = hg.space(spaces[0])
  t.is((await forum.query('post').where({ topic: 'even' }).latest(50)).items.length > 0, true, 'its index works')
  const recorded = await new Promise((resolve) => {
    const check = () => { if (forum.typesVersion === 1) resolve(true) }
    check()
    forum.on('decisions', check)
  })
  t.ok(recorded, 'the owner\'s app recorded the types in the space')
  await hg.close()

  hg = await Hypergraph.open(dir, { types, bootstrap: null })
  t.teardown(() => hg.close())
  for (const key of spaces) {
    const s = hg.space(key)
    await s.ready()
    t.is(testing.indexedBlocks(s), 0, 'reopened: still nothing indexed again')
  }
  t.ok(JSON.parse(fs.readFileSync(path.join(dir, 'instance.json'), 'utf-8')).types, 'the folder-wide types kept (older spaces may still need them)')
})

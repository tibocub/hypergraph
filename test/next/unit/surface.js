// What apps see: the test-only helpers (writing raw records, looking at held
// blocks and logs, opening a space without joining) are not methods of
// Hypergraph or Space; tests reach them through lib/testing.js.

const test = require('brittle')
const { Hypergraph } = require('../../../lib/index.js')
const { Space } = require('../../../lib/space.js')
const testing = require('../../../lib/testing.js')

const HELPERS = ['_writeRaw', '_holdsBlock', '_logs', '_ownLog', '_openSpace']

test('test-only helpers are not on the public classes', (t) => {
  for (const name of HELPERS) {
    t.is(Hypergraph.prototype[name], undefined, `Hypergraph has no ${name}`)
    t.is(Space.prototype[name], undefined, `Space has no ${name}`)
  }
})

test('tests reach them through lib/testing.js', (t) => {
  for (const name of ['writeRaw', 'holdsBlock', 'logs', 'ownLog', 'openSpace', 'personalKeys', 'announce', 'rawBlock', 'setClock', 'writeHeads', 'headsOf', 'removeDeviceAnyway']) t.is(typeof testing[name], 'function', name)
})

// Spec 015: an engine's limits are options of Hypergraph.open.
test('maxOpen, maxAnnounced, memory and idleMs are positive numbers', async (t) => {
  const { tmpDir } = require('../helpers.js')
  for (const name of ['maxOpen', 'maxAnnounced', 'memory', 'idleMs']) {
    for (const bad of [0, -1, 'x', NaN]) {
      await t.exception.all(Hypergraph.open(tmpDir(t), { [name]: bad }), TypeError, `${name}: ${bad}`)
    }
  }
  const hg = await Hypergraph.open(tmpDir(t), { maxOpen: 8, maxAnnounced: 4, memory: 1e8, idleMs: 1000 })
  t.is(hg._network.maxAnnounced, 4)
  await hg.close()
})

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
  for (const name of ['writeRaw', 'holdsBlock', 'logs', 'ownLog', 'openSpace']) t.is(typeof testing[name], 'function', name)
})

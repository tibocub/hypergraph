// The new core loads on Node and Bare, by path and as hypergraph/next.

const test = require('brittle')

test('lib/ loads', (t) => {
  t.ok(require('../../../lib/index.js'))
})

test('hypergraph/next resolves to lib/', (t) => {
  t.is(require('hypergraph/next'), require('../../../lib/index.js'))
})

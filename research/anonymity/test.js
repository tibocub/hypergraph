// Self-check: hypergraph replicates a space over the stream adapter, with no
// DHT. Not in `npm test` (research, not the library).
// node research/anonymity/test.js

const assert = require('assert')
const { run } = require('./bench.js')

run('tcp', { records: 3, bulk: 3 }).then((r) => {
  assert.ok(r.joinMs > 0, 'the newcomer got the first post')
  assert.strictEqual(r.latencyMs.n, 3, 'every post arrived')
  assert.strictEqual(r.bulk.records, 3)
  console.log('ok', JSON.stringify(r))
}, (err) => { console.error(err); process.exitCode = 1 })

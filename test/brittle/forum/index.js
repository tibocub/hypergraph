const test = require('brittle')
const h = require('./harness')

const scenarios = [
  ['basic-replication', require('./scenarios/basic-replication')],
  ['late-joiner', require('./scenarios/late-joiner')],
  ['concurrent-writes', require('./scenarios/concurrent-writes')],
  ['moderation-propagation', require('./scenarios/moderation-propagation')],
  ['out-of-order-replication', require('./scenarios/out-of-order-replication')],
  ['reply-before-parent', require('./scenarios/reply-before-parent')],
  ['partial-replication', require('./scenarios/partial-replication')],
  ['writer-set-convergence', require('./scenarios/writer-set-convergence')],
  ['idempotency', require('./scenarios/idempotency')],
  ['moderation-conflict', require('./scenarios/moderation-conflict')],
  ['identity-lww', require('./scenarios/identity-lww')],
  ['cross-context-integrity', require('./scenarios/cross-context-integrity')]
]

for (const [name, fn] of scenarios) {
  test(`forum/${name}`, async t => fn(t, h))
}

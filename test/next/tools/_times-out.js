// A fixture for test-runner.js, not run by the runner (it starts with _): its
// second test times out, which ends the process before any summary.

const test = require('brittle')

test('passes', (t) => { t.pass() })
test('times out', { timeout: 100 }, async () => { await new Promise((resolve) => setTimeout(resolve, 2000)) })
test('never runs', (t) => { t.pass() })

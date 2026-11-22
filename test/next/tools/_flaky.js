// A fixture for test-runner.js, not run by the runner (it starts with _):
// fails the first time, passes the next (HG_FLAKY_MARKER is the file that
// remembers the first run).

const test = require('brittle')
const fs = require('fs')

test('fails once', (t) => {
  const marker = process.env.HG_FLAKY_MARKER
  if (fs.existsSync(marker)) return t.pass('second run')
  fs.writeFileSync(marker, '')
  t.fail('first run')
})

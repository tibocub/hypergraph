// scripts/test-runner.js: a file that times out (no "# tests" summary) still
// counts its tests and shows as failed; the total never shrinks to hide it
// (it once said "299/299 passed" for 311 tests). Node only: the runner is a
// Node script.

const test = require('brittle')

if (typeof Bare !== 'undefined') {
  test('test runner: skipped on Bare (a Node script)', (t) => { t.pass('skipped on Bare') })
} else {
  const { execFile } = require('child_process')
  const path = require('path')

  test('a file that times out counts all its tests, as failed', async (t) => {
    const root = path.join(__dirname, '..', '..', '..')
    const out = await new Promise((resolve) => {
      execFile(process.execPath, ['scripts/test-runner.js', '--jobs', '1', 'test/next/tools/_times-out.js'], { cwd: root }, (err, stdout) => resolve({ code: err ? err.code : 0, stdout }))
    })
    t.is(out.code, 1, 'the run fails')
    t.ok(/^FAIL .*_times-out\.js/m.test(out.stdout), 'the file is listed as failed')
    t.ok(/1\/3 tests passed in 1 files \(1 FAILED\)/.test(out.stdout), 'its 3 tests count, 1 passed')
  })
}

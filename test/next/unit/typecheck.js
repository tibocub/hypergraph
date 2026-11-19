// npm run typecheck: tsc in strict mode over lib/ (jsconfig.json) reports no error.

const test = require('brittle')

if (typeof Bare !== 'undefined') {
  test('typecheck: skipped on Bare (a Node script)', (t) => t.pass('skipped on Bare'))
} else {
  const path = require('path')
  const { spawnSync } = require('child_process')

  test('typecheck: lib/ has no type error', { timeout: 120000 }, (t) => {
    const root = path.join(__dirname, '../../..')
    const tsc = require.resolve('typescript/bin/tsc', { paths: [root] })
    const res = spawnSync(process.execPath, [tsc, '-p', path.join(root, 'jsconfig.json')], { cwd: root, encoding: 'utf8' })
    t.is(res.status, 0, res.stdout.split('\n').slice(0, 20).join('\n') || 'no error')
  })
}

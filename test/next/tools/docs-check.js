// scripts/docs-check.js (npm run docs:check): finds what has no JSDoc and @param names that aren't parameters.

const test = require('brittle')

if (typeof Bare !== 'undefined') {
  test('docs-check: skipped on Bare (a Node script)', (t) => t.pass('skipped on Bare'))
} else {
  const fs = require('fs')
  const path = require('path')
  const { tmpDir } = require('../../../lib/app-testing.js')
  const { check } = require('../../../scripts/docs-check.js')

  test('docs-check: missing JSDoc and wrong @param names', (t) => {
    const file = path.join(tmpDir(t, 'docs-check'), 'fixture.js')
    fs.writeFileSync(file, `
/** A. */
class A {
  /** @param {string} x @param {object} opts @param {number} [opts.n=1] */
  m (x, { n = 1 } = {}) {}
  /** @param {string} y */
  b (x) {}
  c () {}
  _internal () {}
  #own () {}
  /** A getter. */
  get g () { return 1 }
}
function f (a) {}
const s = (ms) => ms
function notExported () {}
module.exports = { A, f, s }
`)
    t.alike(check(file, true).map((p) => p.replace(/^.*fixture\.js:\d+ /, '')), [
      'A.b: @param y is not a parameter',
      'A.c: no JSDoc',
      'f: no JSDoc',
      's: no JSDoc'
    ])
    t.alike(check(file, false).map((p) => p.replace(/^.*fixture\.js:\d+ /, '')), ['A.b: @param y is not a parameter', 'A.c: no JSDoc'], 'functions only in entry files')
  })

  test('docs-check: the public API passes', (t) => {
    const root = path.join(__dirname, '../../..')
    const files = ['lib/index.js', 'lib/space.js', 'lib/scope.js', 'lib/index/query.js', 'lib/errors.js']
    t.alike(files.flatMap((f) => check(path.join(root, f), false)), [])
    t.alike(check(path.join(root, 'lib/app-testing.js'), true), [])
  })
}

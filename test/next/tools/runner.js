// scripts/test-runner.js: a file that times out (no "# tests" summary) still
// counts its tests and shows as failed; the total never shrinks to hide it
// (it once said "299/299 passed" for 311 tests). A failure that passes when
// run again alone is FLAKY, never a plain pass. --quick/--merge pick from the
// test map (per function), and run everything when it can't be trusted. Node only: the runner
// is a Node script.

const test = require('brittle')

if (typeof Bare !== 'undefined') {
  test('test runner: skipped on Bare (a Node script)', (t) => { t.pass('skipped on Bare') })
} else {
  const { execFile } = require('child_process')
  const path = require('path')
  const fs = require('fs')
  const os = require('os')
  const root = path.join(__dirname, '..', '..', '..')
  const { pick, editsOf, tempRoot, SHARED } = require(path.join(root, 'scripts', 'test-runner.js'))

  const runner = (args, env = {}) => new Promise((resolve) => {
    execFile(process.execPath, ['scripts/test-runner.js', '--jobs', '1', ...args], { cwd: root, env: { ...process.env, ...env } }, (err, stdout) => resolve({ code: err ? err.code : 0, stdout }))
  })

  test('a file that times out counts all its tests, as failed', async (t) => {
    const out = await runner(['test/next/tools/_times-out.js'])
    t.is(out.code, 1, 'the run fails')
    t.ok(/^FAIL again .*_times-out\.js/m.test(out.stdout), 'the file is listed as failed, after a retry alone')
    t.ok(/1\/3 tests passed in 1 files \(1 FAILED\)/.test(out.stdout), 'its 3 tests count, 1 passed')
  })

  test('a failure that passes alone is reported FLAKY, and counted', async (t) => {
    const marker = path.join(os.tmpdir(), `hg-flaky-${process.pid}-${Date.now()}`)
    t.teardown(() => fs.rmSync(marker, { force: true }))
    const out = await runner(['test/next/tools/_flaky.js'], { HG_FLAKY_MARKER: marker })
    t.ok(/^FAIL .*_flaky\.js/m.test(out.stdout), 'the first run fails')
    t.ok(/^FLAKY \(passed alone\) .*_flaky\.js/m.test(out.stdout), 'the retry passes, reported as FLAKY')
    t.ok(/\(1 FLAKY\)/.test(out.stdout), 'the summary counts it')
    t.absent(/^ok .*_flaky\.js/m.test(out.stdout), 'never a plain pass')
    t.is(out.code, 0, 'a flaky file alone does not fail the run')
  })

  const candidates = ['test/next/unit/a.js', 'test/next/unit/b.js', 'test/next/forum/c.js']
  // lib/space.js: `const LIMIT = 5` at the top, then two functions; a runs one, b the other.
  const space = 'const LIMIT = 5\nfunction one () {\n  return LIMIT\n}\nfunction two () {\n  return 2\n}\n'
  const at = (s) => space.indexOf(s)
  const map = {
    known: ['lib/space.js', 'lib/circles.js', 'lib/index/spec/hyperdb/db.json', 'test/next/helpers.js', 'examples/x.js', ...candidates],
    sources: { 'lib/space.js': space },
    fns: { 'lib/space.js': [[at('function one'), at('function two') - 1], [at('function two'), space.length - 1]], 'lib/circles.js': [[0, 10]] },
    tests: {
      'test/next/unit/a.js': { 'lib/space.js': [0], 'test/next/unit/a.js': [] },
      'test/next/unit/b.js': { 'lib/space.js': [1], 'lib/circles.js': [0], 'test/next/unit/b.js': [] },
      'test/next/forum/c.js': { 'lib/circles.js': [], 'hypergraph:lib/space.js': [], 'test/next/forum/c.js': [] }
    }
  }
  const picked = (changed, extra = {}) => {
    const r = pick({ candidates, changed, map, stale: null, ...extra })
    return r.all ? r.why : [...r.picked.keys()].sort()
  }
  const edit = (text) => ({ edits: { 'lib/space.js': [[at(text), at(text) + text.length]] } })

  test('picks the tests that ran a changed function', (t) => {
    t.alike(picked(['lib/space.js'], edit('  return LIMIT\n')), ['test/next/unit/a.js'], 'inside one(): a only')
    t.alike(picked(['lib/space.js'], edit('  return 2\n')), ['test/next/unit/b.js'], 'inside two(): b only')
    t.alike(picked(['lib/space.js'], edit('const LIMIT = 5\n')), ['test/next/unit/a.js', 'test/next/unit/b.js'], 'the top level: every test that loaded it')
    t.alike(picked(['lib/space.js']), ['test/next/unit/a.js', 'test/next/unit/b.js'], 'no edits known: every test that loaded it')
    t.alike(picked(['lib/circles.js']), ['test/next/forum/c.js', 'test/next/unit/b.js'], 'loading is enough when the edits are unknown')
    t.alike(picked(['lib/space.js', 'README.md', 'docs/next/api.md'], edit('  return 2\n')), ['test/next/unit/b.js'], 'docs change nothing')
    t.alike(picked(['test/next/unit/a.js']), ['test/next/unit/a.js'], 'a changed test')
    t.alike(picked(['examples/x.js']), [], 'a file no test loaded picks nothing')
    const reads = { ...SHARED, readsSources: ['test/next/forum/c.js'] }
    t.alike(picked(['lib/space.js'], { ...edit('  return 2\n'), shared: reads }), ['test/next/forum/c.js', 'test/next/unit/b.js'], 'a test that reads every source runs on any source change')
    t.alike(picked(['examples/x.js'], { shared: reads }), [], 'but not for a file outside the sources')
    t.alike(picked([], { siblingsChanged: ['hypergraph'] }), ['test/next/forum/c.js'], 'a changed linked package: every test that ran any of it')
    const r = pick({ candidates, changed: ['lib/space.js'], map, stale: null, ...edit('  return LIMIT\n') })
    t.is(r.picked.get('test/next/unit/a.js'), 'ran a changed function of lib/space.js', 'says why')
  })

  test('edits: a change made after the map, and one already in it, land in the map\'s copy', (t) => {
    const mine = space.replace(/\n/g, '\r\n') // the run saw the working tree: CRLF on Windows
    const cut = (r) => mine.slice(r[0], r[1])
    const after = mine.replace('return 2', 'return 3')
    const [e] = editsOf('lib/space.js', { sources: { 'lib/space.js': mine } }, null, { now: after, base: mine })
    t.is(cut(e), '  return 2\r\n', 'changed after the map: the old line')
    const [f] = editsOf('lib/space.js', { sources: { 'lib/space.js': mine } }, null, { now: mine, base: space.replace('return LIMIT', 'return 1') })
    t.is(cut(f), '  return LIMIT\r\n', 'already in the map: its line there')
    const [g] = editsOf('lib/space.js', { sources: { 'lib/space.js': mine } }, null, { now: mine.replace('function two', 'function zero () {}\r\nfunction two'), base: mine })
    t.is(g[0], g[1], 'an added line is a point')
    t.is(g[0], mine.indexOf('function two'), 'where it went')
  })

  test('edits: a file unchanged since the base, read from git, has none (its final newline kept)', (t) => {
    const { execFileSync } = require('child_process')
    const text = execFileSync('git', ['show', 'HEAD:README.md'], { cwd: root, encoding: 'utf-8' })
    const now = fs.readFileSync(path.join(root, 'README.md'), 'utf-8')
    if (now.replace(/\r\n/g, '\n') !== text) return t.pass('README.md has local changes: nothing to compare')
    t.alike(editsOf('README.md', { sources: { 'README.md': now } }, 'HEAD'), [], 'no edits')
  })

  test('a test missing from the map runs', (t) => {
    t.alike(picked([], { candidates: [...candidates, 'test/next/unit/new.js'] }), ['test/next/unit/new.js'])
  })

  test('temp: the system folder or HG_TEST_TMP; HG_TEST_TMP_FALLBACK under 3 GB free, said', (t) => {
    const said = []
    const say = (/** @type {string} */ line) => { said.push(line) }
    const freeOf = (/** @type {string} */ dir) => (dir === 'main' ? ROOM.main : ROOM.spare)
    const ROOM = { main: 9e9, spare: 70e9 }
    t.is(tempRoot({ env: { HG_TEST_TMP: 'main', HG_TEST_TMP_FALLBACK: 'spare' }, freeOf, say }), 'main', 'room: the chosen folder')
    t.alike(said, [], 'nothing said')
    ROOM.main = 2e9
    t.is(tempRoot({ env: { HG_TEST_TMP: 'main', HG_TEST_TMP_FALLBACK: 'spare' }, freeOf, say }), 'spare', 'under 3 GB: the fallback')
    t.ok(/2000 MB free in main, under 3 GB: using spare/.test(said[0]), 'said: ' + said[0])
    ROOM.spare = 1e9
    t.is(tempRoot({ env: { HG_TEST_TMP: 'main', HG_TEST_TMP_FALLBACK: 'spare' }, freeOf, say }), 'main', 'both low: stays, warned')
    t.ok(/warning/.test(said[1]))
    t.is(tempRoot({ env: {}, freeOf: () => 9e9, say }), os.tmpdir(), 'no setting: the system temp folder')
  })

  test('temp: each file gets its own folder, removed after it ran', async (t) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-root-'))
    t.teardown(() => fs.rmSync(tmpRoot, { recursive: true, force: true }))
    const out = await new Promise((resolve) => {
      execFile(process.execPath, ['scripts/test-runner.js', '--jobs', '1', 'test/next/tools/_writes-temp.js'], { cwd: root, env: { ...process.env, HG_TEST_TMP: tmpRoot, EXPECT_ROOT: tmpRoot } }, (err, stdout) => resolve({ code: err ? err.code : 0, stdout }))
    })
    t.is(out.code, 0, out.stdout)
    t.ok(/1\/1 tests passed/.test(out.stdout), 'it wrote in a folder of its own')
    t.alike(fs.readdirSync(tmpRoot), [], 'and the folder is gone')
  })

  test('falls back to everything when the map can\'t be trusted', (t) => {
    t.ok(/no test map/.test(pick({ candidates, changed: ['lib/space.js'], map: null, stale: null }).why), 'no map')
    t.ok(/changed after/.test(pick({ candidates, changed: [], map, stale: 'test helpers or config changed after the map was made' }).why), 'a stale map')
    t.ok(/test helper changed: test\/next\/helpers\.js/.test(picked(['test/next/helpers.js'])), 'a helper changed')
    t.ok(/test helper changed: test\/next\/forum\/_setup\.js/.test(picked(['test/next/forum/_setup.js'])), 'a new helper')
    t.ok(/package-lock\.json changed/.test(picked(['package-lock.json'])), 'the lockfile')
    t.ok(/scripts\/test-runner\.js changed/.test(picked(['scripts/test-runner.js'])), 'the runner')
    t.ok(/lib\/new\.js is new/.test(picked(['lib/new.js'])), 'a new source file')
    t.ok(/not JS/.test(picked(['lib/index/spec/hyperdb/db.json'])), 'a non-JS source file')
    t.ok(SHARED.config.includes('package.json'))
  })
}

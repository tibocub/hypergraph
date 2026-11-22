#!/usr/bin/env node
// Runs test files in parallel, one process per file, and reports how long
// each took.
//
//   node scripts/test-runner.js [--quick | --merge] [--jobs N] [--slowest K] [--bare] [group|file ...]
//
// Groups: core, networking, replication, forum, integration, v2 (default: all
// of these), and next (the new core: test/next/unit, net, forum, tools).
// --bare runs the files on Bare (the repo's own `bare`) instead of Node.
// Files starting with _ (shared helpers) are not run.
//
// Levels (see CONTRIBUTING.md):
//   --quick  the tests affected by your change (vs master, plus uncommitted), on Node.
//   --merge  the affected tests on Node, then on Bare, plus MERGE_FLOWS.
//   (none)   everything given, as before. A full Node run of `next` also
//            records which source files each test executed (.test-map.json),
//            which is what --quick and --merge pick from.
// Both levels default to the `next` group and fall back to everything when
// the map can't be trusted (they say why).
//
// A file that fails runs once more, alone, after the others: passing then,
// it is reported FLAKY (passed alone), never as a plain pass.
//
// --jobs defaults to the number of CPU cores minus two (HG_TEST_JOBS overrides);
// test processes run at below-normal priority, and a file waits to start
// while free memory is under 1.5 GB. Files start longest first
// (by their last run, kept in .test-times.json). Each file gets its own
// process, so a file that hangs or force-exits can't take others down, and
// every file must report its own "# tests = n/n" line to count as passed.
// Temp folders: the system's (HG_TEST_TMP overrides it), one per file, removed after it;
// HG_TEST_TMP_FALLBACK when it has under 3 GB free. The files mostly wait on that disk's
// syncs (accounts opening and closing): a fast disk matters more than more jobs.

const { spawn, execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { pathToFileURL } = require('url')

const ROOT = path.join(__dirname, '..')
// Each file's last duration, to start the longest first (otherwise a long
// file picked up last runs alone at the end while the other cores idle).
const TIMES = path.join(ROOT, '.test-times.json')
const MAP = path.join(ROOT, '.test-map.json')
// Files run as plain scripts (`node file`, `bare file`), not through brittle's
// CLI: with no flags the CLI only imports the file, but first its glob walks
// the whole cwd (node_modules, .claude/worktrees...) to resolve the name,
// ~4 s per file (0.1 s for the same file as a plain script).
const BARE = path.join(ROOT, 'node_modules', 'bare', 'bin', 'bare') // a Node script starting the runtime
const GROUPS = {
  core: 'test/brittle/core',
  networking: 'test/brittle/networking',
  replication: 'test/brittle/replication',
  forum: ['test/brittle/forum/index.js'],
  integration: 'test/brittle/integration',
  v2: 'test/brittle/v2',
  next: ['test/next/unit', 'test/next/net', 'test/next/forum', 'test/next/tools']
}
const DEFAULT_GROUPS = ['core', 'networking', 'replication', 'forum', 'integration', 'v2']
const MAPPED_GROUP = 'next'

// Always run by --merge: whole forum flows through the public API. They catch
// what a per-file map can't: a test that only reads a changed file's constant
// without calling into it, and timing between peers that a change elsewhere shifts.
const MERGE_FLOWS = [
  'test/next/forum/public.js', // join, post, comment, vote across peers
  'test/next/forum/private.js', // the encrypted path end to end
  'test/next/forum/invites.js', // pairing over the DHT
  'test/next/forum/live.js' // updates reaching a peer live
]

// Picking is only as good as the map: a change to any of these runs everything.
const SHARED = {
  helpers: ['test/next/', 'lib/app-testing.js', 'lib/testing.js'], // non-test files there are test helpers
  config: ['package.json', 'package-lock.json', 'scripts/test-runner.js', 'jsconfig.json'],
  sources: ['lib/', 'tools/', 'bin/'], // a new file here, or a non-JS one changed, can't be mapped
  ignored: [/\.md$/, /\.d\.ts$/, /^(docs|specs|research|\.specify|\.claude)\//, /^LICENSE$/],
  // these read every source file as text (types, rules), so coverage never shows them: run on any source or linked-package change
  readsSources: ['test/next/unit/bare-rules.js', 'test/next/unit/deps.js', 'test/next/unit/typecheck.js', 'test/next/unit/types-consumer.js', 'test/next/tools/docs-check.js'],
  siblings: [] // packages linked with file: (their real folder is read), none here
}

const MIN_DISK = 3e9 // under this, tests fail with "not enough space", which reads like a bug
let TMP = '' // set by tempRoot() when the run starts

// Where the test files' temp folders go: HG_TEST_TMP, else the system's temp folder; when that
// has under 3 GB free, HG_TEST_TMP_FALLBACK (if set). Each file gets its own folder in it,
// removed once the file is done.
// opts: env, freeOf(dir) and say(line), for the tests
function tempRoot ({ env = process.env, freeOf = freeSpace, say = (line) => process.stdout.write(line + '\n') } = {}) {
  const mb = (n) => Math.round(n / 1e6)
  const main = env.HG_TEST_TMP || os.tmpdir()
  const room = freeOf(main)
  if (room >= MIN_DISK) return main
  const fallback = env.HG_TEST_TMP_FALLBACK
  if (fallback && freeOf(fallback) >= MIN_DISK) {
    say(`(temp: ${mb(room)} MB free in ${main}, under 3 GB: using ${fallback})`)
    return fallback
  }
  say(`(warning: ${mb(room)} MB free in ${main}, the tests' temp folder${fallback ? `; ${fallback} too` : '; HG_TEST_TMP_FALLBACK names another'})`)
  return main
}

function freeSpace (dir) {
  fs.mkdirSync(dir, { recursive: true })
  const { bavail, bsize } = fs.statfsSync(dir)
  return bavail * bsize
}

// test/next/forum/forum.js is the reference app the forum tests share, not a test.
const NOT_TESTS = new Set(['test/next/forum/forum.js'])

function filesOf (group) {
  const g = GROUPS[group]
  const entries = Array.isArray(g) ? g : [g]
  return entries.flatMap((e) => {
    if (e.endsWith('.js')) return [e]
    if (!fs.existsSync(path.join(ROOT, e))) return []
    return fs.readdirSync(path.join(ROOT, e)).filter(f => f.endsWith('.js') && !f.startsWith('_')).sort().map(f => `${e}/${f}`)
  }).filter(f => !NOT_TESTS.has(f))
}

function parseArgs (argv) {
  // All cores but two by default (HG_TEST_JOBS or --jobs to change): a run
  // that pinned every core at 100% for minutes preceded a hard reboot of the
  // dev machine (during a 10-process benchmark).
  const opts = { jobs: Number(process.env.HG_TEST_JOBS) || Math.max(1, os.cpus().length - 2), slowest: 10, bare: false, level: 'full', targets: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--jobs') opts.jobs = Number(argv[++i])
    else if (argv[i] === '--bare') opts.bare = true
    else if (argv[i] === '--slowest') opts.slowest = Number(argv[++i])
    else if (argv[i] === '--quick') opts.level = 'quick'
    else if (argv[i] === '--merge') opts.level = 'merge'
    else opts.targets.push(argv[i])
  }
  return opts
}

// ---- picking the affected tests ----

function git (args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

const lines = (s) => s.split('\n').map(l => l.trim()).filter(Boolean)

// Files changed since the base branch (main or master), committed or not, in dir.
function changedSinceBase (cwd = ROOT) {
  const base = ['main', 'master'].find((b) => { try { git(['rev-parse', '--verify', '--quiet', b], cwd); return true } catch { return false } })
  if (!base) throw new Error(`no main or master branch in ${cwd}`)
  const since = git(['merge-base', 'HEAD', base], cwd)
  return { base, since, files: [...new Set([...lines(git(['diff', '--name-only', since], cwd)), ...lines(git(['ls-files', '--others', '--exclude-standard'], cwd))])] }
}

const under = (file, prefixes) => prefixes.some((p) => p.endsWith('/') ? file.startsWith(p) : file === p)

/**
 * Which of `candidates` to run for `changed`, and why. Pure, for the tests.
 * @param {{ candidates: string[], changed: string[], map: null | TestMap, stale: string | null,
 *   edits?: Record<string, [number, number][]>, siblingsChanged?: string[], shared?: typeof SHARED }} input
 *   stale: why the map can't be trusted (null if it can).
 *   edits: per changed source file, what changed as [start, end) offsets in the map's copy of it
 *     (start === end: an insertion); a changed file without edits counts as changed everywhere.
 *   siblingsChanged: linked packages that changed (map entries 'name:path').
 * @returns {{ all: true, why: string } | { all: false, picked: Map<string, string> }} picked: test -> reason.
 */
function pick ({ candidates, changed, map, stale, edits = {}, siblingsChanged = [], shared = SHARED }) {
  if (!map) return { all: true, why: 'there is no test map yet (a full Node run makes it)' }
  if (stale) return { all: true, why: stale }
  const isTest = new Set(candidates)
  const known = new Set(map.known)
  const picked = new Map()
  const sources = []
  for (const f of changed) {
    if (isTest.has(f)) { picked.set(f, 'the test itself changed'); continue }
    if (shared.ignored.some((re) => re.test(f))) continue
    if (under(f, shared.config)) return { all: true, why: `${f} changed` }
    if (under(f, shared.helpers)) return { all: true, why: `a test helper changed: ${f}` }
    if (under(f, shared.sources)) {
      if (!known.has(f)) return { all: true, why: `${f} is new, not in the test map` }
      if (!/\.(c|m)?js$/.test(f)) return { all: true, why: `${f} is not JS: the map can't say who reads it` }
    }
    sources.push(f)
  }
  if (siblingsChanged.length || sources.some((f) => under(f, shared.sources))) {
    for (const test of shared.readsSources) if (isTest.has(test) && !picked.has(test)) picked.set(test, 'reads every source file')
  }
  // Per changed file: the innermost functions holding an edit, or null when
  // an edit is outside every function (top level: every test that loaded it).
  const need = new Map()
  for (const f of sources) {
    const fns = map.fns[f] || []
    if (!edits[f]) { need.set(f, null); continue }
    let set = new Set()
    for (const [a, b] of edits[f]) {
      let best = -1
      fns.forEach(([s, e], i) => {
        const inside = a === b ? s < a && a < e : s <= a && b <= e
        if (inside && (best < 0 || e - s < fns[best][1] - fns[best][0])) best = i
      })
      if (best < 0) { set = null; break }
      set.add(best)
    }
    need.set(f, set)
  }
  for (const [test, loaded] of Object.entries(map.tests)) {
    if (!isTest.has(test) || picked.has(test)) continue
    for (const [src, hits] of Object.entries(loaded)) {
      if (siblingsChanged.some((p) => src.startsWith(p + ':'))) { picked.set(test, `ran ${src} (its package changed)`); break }
      if (!need.has(src)) continue
      const fns = need.get(src)
      if (fns === null) { picked.set(test, `loaded ${src}, changed outside any function`); break }
      if (hits.some((i) => fns.has(i))) { picked.set(test, `ran a changed function of ${src}`); break }
    }
  }
  for (const test of candidates) {
    if (!picked.has(test) && !(test in map.tests)) picked.set(test, 'not in the test map yet')
  }
  return { all: false, picked }
}

/**
 * @typedef {{ commit: string, made: string, siblings: Record<string, string>, known: string[],
 *   sources: Record<string, string>, fns: Record<string, [number, number][]>, tests: Record<string, Record<string, number[]>> }} TestMap
 *   sources: each loaded file's text as the run saw it; fns: every function seen in it (not the
 *   module's top level), as [start, end) offsets; tests: per test, each file it loaded -> the
 *   indexes (into fns) of the functions it ran.
 */

// Line ranges git sees between two texts, as { a, b, c, d } (old start, count, new start, count).
function hunks (before, after) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-pick-'))
  const lf = (t) => t.replace(/\r\n/g, '\n')
  fs.writeFileSync(path.join(tmp, 'a'), lf(before))
  fs.writeFileSync(path.join(tmp, 'b'), lf(after))
  let out
  try {
    out = git(['diff', '--no-index', '--no-color', '--no-ext-diff', '-U0', 'a', 'b'], tmp)
  } catch (err) {
    out = String(err.stdout || '') // exit 1: they differ
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  return [...out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => ({ a: +m[1], b: m[2] === undefined ? 1 : +m[2], c: +m[3], d: m[4] === undefined ? 1 : +m[4] }))
}

// [start, end) offsets in `text` of `count` lines from line `line` (1-based); count 0: the point after it.
function span (text, line, count) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  if (starts[starts.length - 1] !== text.length) starts.push(text.length)
  const at = (n) => starts[Math.min(Math.max(n - 1, 0), starts.length - 1)]
  return count === 0 ? [at(line + 1), at(line + 1)] : [at(line), at(line + count)]
}

// What changed in `file` since `since` (the base), in the map's copy of it:
// changes made after the map (old side of map -> now) and those already in
// it (new side of base -> map).
// texts: { now, base } instead of reading them (for the tests).
function editsOf (file, map, since, texts = null) {
  const mine = map.sources[file]
  let { now = '', base = '' } = texts || {}
  if (!texts) {
    try { now = fs.readFileSync(path.join(ROOT, file), 'utf-8') } catch { /* deleted */ }
    // untrimmed: a lost final newline would read as a change on the last line (top level: every loader)
    try { base = execFileSync('git', ['show', `${since}:${file}`], { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { /* new since base */ }
  }
  return [
    ...hunks(mine, now).map((h) => span(mine, h.a, h.b)),
    ...hunks(base, mine).map((h) => span(mine, h.c, h.d))
  ]
}

// Why the saved map can't be trusted for this checkout, or null.
function staleness (map) {
  try {
    const watched = [...SHARED.helpers, ...SHARED.config].map((p) => p.replace(/\/$/, ''))
    const after = git(['rev-list', '-1', `${map.commit}..HEAD`, '--', ...watched])
    if (after) return `test helpers or config changed after the map was made (commit ${after.slice(0, 8)})`
  } catch {
    return `the map's commit ${String(map.commit).slice(0, 8)} is not in this repository`
  }
  return null
}

const siblingDir = (name) => fs.realpathSync(path.join(ROOT, 'node_modules', name))

// Linked packages whose checkout moved or has changes since the map.
function siblingsChanged (map) {
  return SHARED.siblings.filter((name) => {
    try {
      const dir = siblingDir(name)
      return git(['rev-parse', 'HEAD'], dir) !== (map.siblings || {})[name] || changedSinceBase(dir).files.length > 0
    } catch { return true }
  })
}

function readMap () {
  try {
    const map = JSON.parse(fs.readFileSync(MAP, 'utf-8'))
    return map.tests && map.sources ? map : null // null: made by an older runner
  } catch { return null }
}

// What one test's coverage dumps show: per loaded file, its length, its
// functions (not the module's top level) as [start, end) offsets, and which of them ran.
function coverageOf (covDir) {
  const out = {}
  const roots = [{ dir: ROOT, tag: '' }, ...SHARED.siblings.map((name) => ({ dir: siblingDir(name), tag: name + ':' }))]
    .map((r) => ({ ...r, url: pathToFileURL(r.dir).href + '/' }))
  for (const name of fs.readdirSync(covDir)) {
    let dump
    try { dump = JSON.parse(fs.readFileSync(path.join(covDir, name), 'utf-8')) } catch { continue }
    for (const s of dump.result || []) {
      const root = roots.find((r) => s.url.startsWith(r.url))
      if (!root || s.url.includes('/node_modules/', root.url.length - 1)) continue
      const file = root.tag + decodeURIComponent(s.url.slice(root.url.length))
      const seen = out[file] || (out[file] = { length: s.functions[0].ranges[0].endOffset, fns: [], ran: [] })
      for (const f of s.functions.slice(1)) {
        const r = [f.ranges[0].startOffset, f.ranges[0].endOffset]
        seen.fns.push(r)
        if (f.ranges[0].count > 0) seen.ran.push(r)
      }
    }
  }
  return out
}

// The map, from every test's coverage. Linked packages keep their file names only.
function buildMap (covs, commit) {
  const fns = {}
  const index = {}
  for (const cov of Object.values(covs)) {
    for (const [file, { fns: list }] of Object.entries(cov)) {
      const keys = index[file] || (index[file] = new Map())
      for (const [a, b] of list) if (!keys.has(`${a}-${b}`)) keys.set(`${a}-${b}`, [a, b])
    }
  }
  for (const [file, keys] of Object.entries(index)) {
    fns[file] = [...keys.values()].sort((x, y) => x[0] - y[0] || y[1] - x[1])
    index[file] = new Map(fns[file].map(([a, b], i) => [`${a}-${b}`, i]))
  }
  const tests = {}
  for (const [test, cov] of Object.entries(covs)) {
    tests[test] = {}
    for (const [file, { ran }] of Object.entries(cov)) tests[test][file] = [...new Set(ran.map(([a, b]) => index[file].get(`${a}-${b}`)))].sort((x, y) => x - y)
  }
  const sources = {}
  for (const file of Object.keys(fns)) {
    if (file.includes(':')) continue
    let text = null
    try { text = fs.readFileSync(path.join(ROOT, file), 'utf-8') } catch { /* gone since */ }
    // edited during the run: the offsets don't fit it, so its edits stay unknown (every loader runs)
    if (text !== null && Object.values(covs).every((cov) => !cov[file] || cov[file].length === text.length)) sources[file] = text
  }
  const siblings = {}
  for (const s of SHARED.siblings) { try { siblings[s] = git(['rev-parse', 'HEAD'], siblingDir(s)) } catch { /* not a git checkout */ } }
  return { commit, made: new Date().toISOString(), siblings, known: lines(git(['ls-files'])), sources, fns, tests }
}

// ---- running ----

function run (file, bare, covDir) {
  return new Promise((resolve) => {
    const start = Date.now()
    const args = bare ? [BARE, file] : [file]
    const tmp = fs.mkdtempSync(path.join(TMP, 'run-'))
    // the test's temp folder (os.tmpdir() in it), and HG_TEST_TMP for the tests that read it
    const env = { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp, HG_TEST_TMP: tmp, ...(covDir ? { NODE_V8_COVERAGE: covDir } : {}) }
    const p = spawn(process.execPath, args, { cwd: ROOT, env })
    try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch { /* keep the machine responsive: best effort */ }
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { out += d })
    p.on('exit', async (code) => {
      await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {}) // a file left locked: the folder stays
      const m = /# tests = (\d+)\/(\d+) pass/.exec(out)
      // A file that crashed or timed out prints no summary: its tests still
      // count (else the total shrinks and failures hide), passed = top-level oks.
      // shortcut: counts test( calls at line starts, misses tests made in a loop.
      const declared = (fs.readFileSync(path.join(ROOT, file), 'utf-8').match(/^test(\.\w+)?\(/gm) || []).length
      const passed = m ? Number(m[1]) : (out.match(/^ok \d+/gm) || []).length
      const total = m ? Number(m[2]) : Math.max(declared, passed + 1)
      resolve({ file, ms: Date.now() - start, code, passed, total, ok: code === 0 && !!m && passed === total, flaky: false, out })
    })
  })
}

// Runs files on `jobs` workers; failures run once more, alone, at the end.
async function runAll (files, { jobs, bare, times, record }) {
  const tmp = TMP
  const key = (f) => (bare ? `bare:${f}` : f)
  // Unknown files first (they may be long), then longest first.
  const order = (f) => (key(f) in times ? times[key(f)] : Infinity)
  const queue = [...files].sort((a, b) => order(b) - order(a))
  const results = new Map()
  const ran = {}
  const MIN_FREE = 1.5e9 // bytes; don't start a file while memory is this low
  let warned = false
  const once = async (file) => {
    const covDir = record ? fs.mkdtempSync(path.join(tmp, 'hg-cov-')) : null
    const r = await run(file, bare, covDir)
    if (covDir) {
      ran[file] = coverageOf(covDir)
      fs.rmSync(covDir, { recursive: true, force: true })
    }
    return r
  }
  const worker = async () => {
    while (queue.length) {
      while (os.freemem() < MIN_FREE) {
        if (!warned) { process.stdout.write(`(waiting: free memory ${Math.round(os.freemem() / 1e6)} MB)\n`); warned = true }
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      const file = queue.shift()
      if (!file) break // another worker took the last one while this one waited for memory
      const r = await once(file)
      results.set(file, r)
      times[key(file)] = r.ms
      process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'} ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${r.file}${r.ok ? '' : `  (exit ${r.code}, ${r.passed}/${r.total}; will retry alone)`}\n`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker))
  for (const first of [...results.values()].filter(r => !r.ok)) {
    const r = await once(first.file)
    if (r.ok) {
      r.flaky = true
      r.ms = first.ms
      r.out = first.out // the failure is what needs looking at
    }
    results.set(first.file, r)
    process.stdout.write(`${r.ok ? 'FLAKY (passed alone)' : 'FAIL again'} ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${r.file}${r.ok ? '' : `  (exit ${r.code}, ${r.passed}/${r.total})`}\n`)
  }
  return { results: [...results.values()], ran }
}

function report (results, { label, files, wall, jobs, slowest }) {
  const failed = results.filter(r => !r.ok)
  const flaky = results.filter(r => r.flaky)
  for (const r of [...failed, ...flaky]) {
    process.stdout.write(`\n──── ${r.file}${r.flaky ? ' (FLAKY: first run below)' : ''} ────\n`)
    process.stdout.write(r.out.split('\n').filter(l => /not ok|Error|error|# tests|# asserts/.test(l)).slice(0, 40).join('\n') + '\n')
  }
  const tests = results.reduce((n, r) => n + r.total, 0)
  const passed = results.reduce((n, r) => n + r.passed, 0)
  const cpu = results.reduce((n, r) => n + r.ms, 0)
  if (slowest) {
    process.stdout.write('\nslowest files:\n')
    for (const r of [...results].sort((a, b) => b.ms - a.ms).slice(0, slowest)) {
      process.stdout.write(`  ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${r.file}\n`)
    }
  }
  process.stdout.write(`\n${label}${passed}/${tests} tests passed in ${files} files${failed.length ? ` (${failed.length} FAILED)` : ''}${flaky.length ? ` (${flaky.length} FLAKY)` : ''}; wall ${(wall / 1000).toFixed(1)}s, ` +
    `sum of file times ${(cpu / 1000).toFixed(1)}s, ${jobs} jobs\n`)
  return failed.length
}

function choose (opts) {
  const candidates = [...new Set((opts.targets.length ? opts.targets : [MAPPED_GROUP]).flatMap(t => GROUPS[t] ? filesOf(t) : [t]))]
  const map = readMap()
  let picked
  try {
    const { base, since, files: changed } = changedSinceBase()
    const edits = {}
    if (map) for (const f of changed) if (map.sources[f] !== undefined) edits[f] = editsOf(f, map, since)
    const result = pick({ candidates, changed, map, stale: map && staleness(map), edits, siblingsChanged: map ? siblingsChanged(map) : [] })
    process.stdout.write(`changed since ${base}: ${changed.length ? changed.join(', ') : 'nothing'}\n`)
    if (result.all) {
      process.stdout.write(`running everything because ${result.why}\n`)
      picked = candidates
    } else {
      for (const [test, why] of result.picked) process.stdout.write(`  picked ${test}: ${why}\n`)
      picked = [...result.picked.keys()]
    }
  } catch (err) {
    process.stdout.write(`running everything because git could not say what changed (${err.message})\n`)
    picked = candidates
  }
  if (opts.level === 'merge') {
    const extra = MERGE_FLOWS.filter((f) => !picked.includes(f))
    if (extra.length) process.stdout.write(`  plus the merge flows: ${extra.join(', ')}\n`)
    picked = [...picked, ...extra]
  }
  return picked.filter((f) => fs.existsSync(path.join(ROOT, f))) // a deleted test file shows as changed
}

async function main () {
  const opts = parseArgs(process.argv.slice(2))
  TMP = tempRoot()

  let times = {}
  try { times = JSON.parse(fs.readFileSync(TIMES, 'utf-8')) } catch { /* first run */ }
  const passes = []
  if (opts.level === 'full') {
    const targets = opts.targets.length ? opts.targets : DEFAULT_GROUPS
    const files = targets.flatMap(t => GROUPS[t] ? filesOf(t) : [t])
    passes.push({ files, bare: opts.bare, record: !opts.bare && targets.includes(MAPPED_GROUP) })
  } else {
    const files = choose(opts)
    if (!files.length) {
      process.stdout.write('no test is affected\n')
      return 0
    }
    passes.push({ files, bare: opts.level === 'quick' ? opts.bare : false })
    if (opts.level === 'merge') passes.push({ files, bare: true })
  }

  let failures = 0
  for (const p of passes) {
    if (passes.length > 1) process.stdout.write(`\n== on ${p.bare ? 'Bare' : 'Node'} ==\n`)
    const started = Date.now()
    const commit = p.record ? git(['rev-parse', 'HEAD']) : null
    const { results, ran } = await runAll(p.files, { jobs: opts.jobs, bare: p.bare, times, record: p.record })
    try { fs.writeFileSync(TIMES, JSON.stringify(times, null, 2)) } catch { /* only an ordering hint */ }
    if (p.record) {
      fs.writeFileSync(MAP, JSON.stringify(buildMap(ran, commit)))
      process.stdout.write(`(test map: ${Object.keys(ran).length} files, from commit ${commit.slice(0, 8)})\n`)
    }
    failures += report(results, { label: passes.length > 1 ? `${p.bare ? 'Bare' : 'Node'}: ` : '', files: p.files.length, wall: Date.now() - started, jobs: opts.jobs, slowest: opts.level === 'full' ? opts.slowest : 0 })
  }
  return failures ? 1 : 0
}

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(1) })
}

module.exports = { pick, coverageOf, buildMap, editsOf, tempRoot, SHARED }

#!/usr/bin/env node
// Runs test files in parallel, one process per file, and reports how long
// each took.
//
//   node scripts/test-runner.js [--jobs N] [--slowest K] [--bare] [group|file ...]
//
// Groups: core, networking, replication, forum, integration, v2 (default: all
// of these), and next (the new core, spec 011: test/next/unit, net, forum).
// --bare runs the files on Bare (the repo's own `bare`, through brittle's
// brittle-bare.js) instead of Node.
// Files starting with _ (shared helpers) are not run.
// --jobs defaults to the number of CPU cores minus two (HG_TEST_JOBS overrides);
// test processes run at below-normal priority, and a file waits to start
// while free memory is under 1.5 GB. Files start longest first
// (by their last run, kept in .test-times.json). Each file gets its own
// process, so a file that hangs or force-exits can't take others down, and
// every file must report its own "# tests = n/n" line to count as passed.

const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.join(__dirname, '..')
// Each file's last duration, to start the longest first (otherwise a long
// file picked up last runs alone at the end while the other cores idle).
const TIMES = path.join(ROOT, '.test-times.json')
const BRITTLE = path.join(ROOT, 'node_modules', 'brittle', 'brittle-node.js')
const BRITTLE_BARE = path.join(ROOT, 'node_modules', 'brittle', 'brittle-bare.js')
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
  // dev machine (2026-10-06, during a 10-process benchmark).
  const opts = { jobs: Number(process.env.HG_TEST_JOBS) || Math.max(1, os.cpus().length - 2), slowest: 10, bare: false, targets: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--jobs') opts.jobs = Number(argv[++i])
    else if (argv[i] === '--bare') opts.bare = true
    else if (argv[i] === '--slowest') opts.slowest = Number(argv[++i])
    else opts.targets.push(argv[i])
  }
  return opts
}

function run (file, bare) {
  return new Promise((resolve) => {
    const start = Date.now()
    const args = bare ? [BARE, BRITTLE_BARE, file] : [BRITTLE, file]
    const p = spawn(process.execPath, args, { cwd: ROOT })
    try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {} // keep the machine responsive
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { out += d })
    p.on('exit', (code) => {
      const m = /# tests = (\d+)\/(\d+) pass/.exec(out)
      const passed = m ? Number(m[1]) : 0
      const total = m ? Number(m[2]) : 0
      resolve({ file, ms: Date.now() - start, code, passed, total, ok: code === 0 && !!m && passed === total, out })
    })
  })
}

async function main () {
  const opts = parseArgs(process.argv.slice(2))
  const targets = opts.targets.length ? opts.targets : DEFAULT_GROUPS
  const files = targets.flatMap(t => GROUPS[t] ? filesOf(t) : [t])

  let times = {}
  try { times = JSON.parse(fs.readFileSync(TIMES, 'utf-8')) } catch {}
  // Unknown files first (they may be long), then longest first.
  const key = (f) => (opts.bare ? `bare:${f}` : f)
  const order = (f) => (key(f) in times ? times[key(f)] : Infinity)
  const queue = [...files].sort((a, b) => order(b) - order(a))
  const started = Date.now()
  const results = []
  const MIN_FREE = 1.5e9 // bytes; don't start a file while memory is this low
  let warned = false
  const worker = async () => {
    while (queue.length) {
      while (os.freemem() < MIN_FREE) {
        if (!warned) { process.stdout.write(`(waiting: free memory ${Math.round(os.freemem() / 1e6)} MB)\n`); warned = true }
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      const file = queue.shift()
      const r = await run(file, opts.bare)
      results.push(r)
      process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'} ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${r.file}${r.ok ? '' : `  (exit ${r.code}, ${r.passed}/${r.total})`}\n`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.jobs, files.length) }, worker))
  const wall = Date.now() - started
  for (const r of results) times[opts.bare ? `bare:${r.file}` : r.file] = r.ms
  try { fs.writeFileSync(TIMES, JSON.stringify(times, null, 2)) } catch {}

  const failed = results.filter(r => !r.ok)
  for (const r of failed) {
    process.stdout.write(`\n──── ${r.file} ────\n`)
    process.stdout.write(r.out.split('\n').filter(l => /not ok|Error|error|# tests|# asserts/.test(l)).slice(0, 40).join('\n') + '\n')
  }

  const tests = results.reduce((n, r) => n + r.total, 0)
  const passed = results.reduce((n, r) => n + r.passed, 0)
  const cpu = results.reduce((n, r) => n + r.ms, 0)
  process.stdout.write(`\nslowest files:\n`)
  for (const r of [...results].sort((a, b) => b.ms - a.ms).slice(0, opts.slowest)) {
    process.stdout.write(`  ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${r.file}\n`)
  }
  process.stdout.write(`\n${passed}/${tests} tests passed in ${files.length} files; wall ${(wall / 1000).toFixed(1)}s, ` +
    `sum of file times ${(cpu / 1000).toFixed(1)}s, ${opts.jobs} jobs\n`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error(err); process.exit(1) })

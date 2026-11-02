#!/usr/bin/env node
// `npm run perf`: runs every perf/scenarios/*.mjs, one process at a time, on Node then on Bare,
// and appends one line per scenario and size to perf/history.jsonl (committed: performance
// followed commit by commit). The same file in hypergraph, SwarmFS and swarmwire.
//
//   npm run perf                        # Node and Bare, every scenario, saved
//   npm run perf -- --node              # one runtime (--bare for the other)
//   npm run perf -- forum chat          # only these scenario files
//   npm run perf -- --no-save           # print only
//   npm run perf -- --sizes 1000        # passed to the scenarios (their own sizes otherwise)
//
// Scenarios run at below-normal priority, one at a time (the dev machine rebooted once under a
// long all-cores bench), on a local DHT. Their temp data goes to PERF_TMP, else `.tmp/perf`
// next to the repo's main checkout when that `.tmp` exists, else the OS temp folder.
// Then `npm run perf:compare`.

import { spawn, execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import fs from 'fs'
import os from 'os'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const HISTORY = path.join(here, 'history.jsonl')
const TIMEOUT = 6 * 60 * 1000 // one scenario file

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--') && a !== '--sizes'))
const pass = argv.includes('--sizes') ? ['--sizes', argv[argv.indexOf('--sizes') + 1]] : []
const only = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--sizes')
const runtimes = flags.has('--node') ? ['node'] : flags.has('--bare') ? ['bare'] : ['node', 'bare']
const save = !flags.has('--no-save') && !pass.length // other sizes than the scenarios' own: not comparable

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim()
const sha = git('rev-parse', 'HEAD')
const dirty = git('status', '--porcelain').split('\n').filter((l) => l && !l.endsWith('perf/history.jsonl')).length > 0
const machine = { cores: os.cpus().length, cpu: os.cpus()[0]?.model.trim(), ramGB: Math.round(os.totalmem() / 1024 ** 3), os: `${os.platform()} ${os.release()}` }

function tmpRoot () {
  if (process.env.PERF_TMP) return process.env.PERF_TMP
  const main = path.dirname(path.resolve(root, git('rev-parse', '--git-common-dir')))
  const tmp = path.join(main, '..', '.tmp')
  return fs.existsSync(tmp) ? path.join(tmp, 'perf') : path.join(os.tmpdir(), 'perf')
}
const TMP = tmpRoot()
fs.mkdirSync(TMP, { recursive: true })

// The `bare` devDependency's launcher, in the nearest node_modules up from the repo (a
// worktree may use its main checkout's).
function bareBin () {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const bin = path.join(dir, 'node_modules', 'bare', 'bin', 'bare')
    if (fs.existsSync(bin)) return bin
    if (path.dirname(dir) === dir) throw new Error('no bare in node_modules: npm install')
  }
}

const files = fs.readdirSync(path.join(here, 'scenarios')).filter((f) => f.endsWith('.mjs') && !f.startsWith('_'))
  .filter((f) => !only.length || only.includes(f.replace(/\.mjs$/, ''))).sort()

// Quartile-based: half the interquartile range over the median (0.1 = ±10%).
function summary (samples) {
  const s = [...samples].sort((a, b) => a - b)
  const q = (p) => { const i = (s.length - 1) * p; const lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo) }
  const median = q(0.5)
  return { median: round(median), spread: median ? round((q(0.75) - q(0.25)) / 2 / median, 3) : 0, n: s.length, min: round(s[0]), max: round(s[s.length - 1]) }
}
const round = (x, d = null) => { const p = d ?? (Math.abs(x) >= 100 ? 1 : Math.abs(x) >= 1 ? 2 : 3); return Math.round(x * 10 ** p) / 10 ** p }

function runFile (runtime, file) {
  return new Promise((resolve) => {
    const script = path.join(here, 'scenarios', file)
    const args = runtime === 'bare' ? [bareBin(), '--expose-gc', script, ...pass] : ['--expose-gc', script, ...pass]
    const env = { ...process.env, TMP, TEMP: TMP, TMPDIR: TMP }
    const p = spawn(process.execPath, args, { cwd: root, env })
    try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch { /* not allowed here: normal priority */ }
    const timer = setTimeout(() => { out += '\n(timed out)'; p.kill() }, TIMEOUT)
    let out = ''
    let buf = ''
    let version = null
    const results = []
    const line = (l) => {
      if (l.startsWith('PERF-RUNTIME ')) version = JSON.parse(l.slice(13)).version
      else if (l.startsWith('PERF ')) {
        const r = JSON.parse(l.slice(5))
        const s = summary(r.samples)
        results.push({ scenario: r.scenario, size: r.size, unit: r.unit, better: r.better, ...(r.flat ? { flat: true } : {}), ...s })
        const sp = s.n > 1 ? ` ±${Math.round(s.spread * 100)}%` : ''
        console.log(`  ${r.scenario.padEnd(22)} ${String(r.size).padStart(7)}  ${String(s.median).padStart(9)} ${r.unit}${sp}  (n=${s.n})`)
      } else out += l + '\n'
    }
    const onData = (d) => {
      buf += d
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const l of lines) line(l.replace(/\r$/, ''))
    }
    p.stdout.on('data', onData)
    p.stderr.on('data', (d) => { out += d })
    p.on('exit', (code) => {
      clearTimeout(timer)
      if (buf) line(buf)
      resolve({ ok: code === 0, code, version, results, out })
    })
  })
}

const run = new Date().toISOString()
let failed = 0
console.log(`perf ${sha.slice(0, 10)}${dirty ? ' (uncommitted changes)' : ''}, ${machine.cores} cores, ${machine.ramGB} GB; temp data in ${TMP}`)
for (const runtime of runtimes) {
  const lines = []
  for (const file of files) {
    const start = Date.now()
    console.log(`${runtime} ${file}`)
    const r = await runFile(runtime, file)
    console.log(`  (${((Date.now() - start) / 1000).toFixed(0)} s)`)
    if (!r.ok) {
      failed++
      console.log(`  FAILED (exit ${r.code}), not saved:\n` + r.out.split('\n').slice(-15).map((l) => '    ' + l).join('\n'))
      continue
    }
    for (const x of r.results) lines.push({ date: run, run, sha, dirty, runtime, version: r.version, machine, ...x })
  }
  if (save && lines.length) fs.appendFileSync(HISTORY, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}
if (save) console.log(`saved to ${path.relative(root, HISTORY)}; compare: npm run perf:compare`)
if (failed) process.exitCode = 1

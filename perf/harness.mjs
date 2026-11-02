// The scenario side of `npm run perf` (perf/run.mjs starts each scenario file in its own
// process, on Node or Bare). The same file in hypergraph, SwarmFS and swarmwire.
//
//   import { context, time, record } from '../harness.mjs'
//   const t = context()                    // a stand-in for brittle's t: t.teardown(fn, { order })
//   ... set up with the repo's own test helpers, given t ...
//   record('forum.post', 1000, 'ms', await time(() => post(...), 10, { batch: 10 }))
//   await t.close()                        // runs the teardowns, lowest order first
//
// Each record() prints one `PERF {json}` line; run.mjs turns the samples into a median and
// a spread and appends them to perf/history.jsonl.

import process from 'process'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'

/* global Bare */
const runtime = typeof Bare !== 'undefined' ? { runtime: 'bare', version: Bare.version } : { runtime: 'node', version: process.version }
console.log('PERF-RUNTIME ' + JSON.stringify(runtime))

export const isBare = runtime.runtime === 'bare'

// Milliseconds, as a float.
export const now = () => Number(process.hrtime.bigint()) / 1e6

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Polls `fn` until it returns something truthy, up to `ms`; that value, or null.
export async function eventually (fn, ms = 30000, every = 10) {
  const until = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() >= until) return null
    await sleep(every)
  }
}

// Whichever comes first: `promise`, or `fallback` after `ms` (the timer cleared either way).
export async function within (promise, ms, fallback = null) {
  let timer = null
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms) })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

// `n` samples of `fn(i)`'s duration in ms. `batch`: each sample times that many calls and
// gives the time per call (sub-ms operations: one call is mostly timer and scheduling noise).
// `warmup`: calls made first, untimed (the JIT's first runs).
export async function time (fn, n = 5, { batch = 1, warmup = 0 } = {}) {
  const out = []
  let i = 0
  for (; i < warmup; i++) await fn(i)
  for (let k = 0; k < n; k++) {
    const start = now()
    for (let b = 0; b < batch; b++) await fn(i++)
    out.push((now() - start) / batch)
  }
  return out
}

// One measured value per scenario and size. `unit`: 'ms' (lower is better) unless said,
// e.g. 'ops/s' with { better: 'higher' }. `flat`: its cost must not grow with the size
// (perf:compare reports the curve).
export function record (scenario, size, unit, samples, { better = 'lower', flat = false } = {}) {
  if (!Array.isArray(samples)) samples = [samples]
  console.log('PERF ' + JSON.stringify({ scenario, size, unit, better, ...(flat ? { flat } : {}), samples: samples.map((s) => Math.round(s * 1000) / 1000) }))
}

// This process's memory after a full GC (run.mjs passes --expose-gc): { heap, rss } in bytes.
export function mem () {
  if (globalThis.gc) { globalThis.gc(); globalThis.gc() }
  const m = process.memoryUsage()
  return { heap: m.heapUsed + m.external, rss: m.rss }
}

// Another process of this runtime running `script` (a peer on another machine, in effect:
// in one process every peer shares one thread). Its stdout lines go to line(prefix). The
// parent steers it with files in `dir`: signal('go'), and stop() writes 'stop' and waits for
// it to exit (the child closes what it opened; killed after 15 s).
export function child (t, script, args, dir) {
  fs.mkdirSync(dir, { recursive: true })
  const p = spawn(process.execPath, [script, dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  const lines = []
  const waiting = []
  let buf = ''
  let err = ''
  const onLine = (l) => {
    lines.push(l)
    for (const w of waiting.splice(0)) if (!w.check()) waiting.push(w)
  }
  p.stdout.on('data', (d) => {
    buf += d
    const parts = buf.split('\n')
    buf = parts.pop()
    for (const l of parts) onLine(l.replace(/\r$/, ''))
  })
  p.stderr.on('data', (d) => { err += d })
  let exited = false
  const exit = new Promise((resolve) => p.on('exit', () => { exited = true; resolve() }))
  exit.then(() => { for (const w of waiting.splice(0)) w.fail(new Error('child exited: ' + err.slice(-500))) })
  const c = {
    // the rest of the first line starting with `prefix`
    line (prefix, ms = 60000) {
      return new Promise((resolve, reject) => {
        let timer = null
        const w = {
          check: () => {
            const l = lines.find((x) => x.startsWith(prefix))
            if (l === undefined) return false
            clearTimeout(timer)
            resolve(l.slice(prefix.length))
            return true
          },
          fail: (e) => { clearTimeout(timer); reject(e) }
        }
        if (w.check()) return
        if (exited) return reject(new Error('child exited: ' + err.slice(-500)))
        timer = setTimeout(() => { waiting.splice(waiting.indexOf(w), 1); reject(new Error(`no "${prefix}" from the child within ${ms} ms`)) }, ms)
        waiting.push(w)
      })
    },
    signal (name) { fs.writeFileSync(path.join(dir, name), '') },
    async stop () {
      if (exited) return
      c.signal('stop')
      if (await within(exit, 15000, 'timeout') === 'timeout') { p.kill(); await exit }
    }
  }
  t.teardown(() => c.stop())
  return c
}

// In a child: resolves once the parent's signal(name) file exists in `dir`.
export async function signalled (dir, name) {
  while (!fs.existsSync(path.join(dir, name))) await sleep(5)
}

// Brittle's `t` as the test helpers use it (teardown only); teardowns run on close(), lowest
// `order` first, each bounded so a stuck close never hangs the run.
export function context () {
  const steps = []
  const teardown = (fn, { order = 0 } = {}) => { steps.push({ fn, order }) }
  const close = async () => {
    const list = steps.splice(0).sort((a, b) => a.order - b.order)
    for (const s of list) {
      let timer = null
      const bound = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), 15000) })
      const res = await Promise.race([Promise.resolve().then(s.fn).catch((err) => console.log('  [teardown] ' + err.message)), bound])
      clearTimeout(timer)
      if (res === 'timeout') console.log('  [teardown] a step did not finish within 15 s')
    }
  }
  return { teardown, close, comment: () => {} }
}

// Sizes from the command line (`--sizes 100,1000`) or the scenario's defaults.
export function sizes (defaults) {
  const i = process.argv.indexOf('--sizes')
  return i === -1 ? defaults : process.argv[i + 1].split(',').map(Number)
}

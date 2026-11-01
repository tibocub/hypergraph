// The scenario side of `npm run perf` (perf/run.mjs starts each scenario file in its own
// process, on Node or Bare). The same file in hypergraph, SwarmFS and swarmwire.
//
//   import { context, time, record } from '../harness.mjs'
//   const t = context()                    // a stand-in for brittle's t: t.teardown(fn, { order })
//   ... set up with the repo's own test helpers, given t ...
//   record('forum.post', 1000, 'ms', await time(() => post(...), 20))
//   await t.close()                        // runs the teardowns, lowest order first
//
// Each record() prints one `PERF {json}` line; run.mjs turns the samples into a median and
// a spread and appends them to perf/history.jsonl.

import process from 'process'

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

// `n` samples of `fn(i)`'s duration in ms.
export async function time (fn, n = 5) {
  const out = []
  for (let i = 0; i < n; i++) {
    const start = now()
    await fn(i)
    out.push(now() - start)
  }
  return out
}

// One measured value per scenario and size. `unit`: 'ms' (lower is better) unless said,
// e.g. 'ops/s' with { better: 'higher' }.
export function record (scenario, size, unit, samples, { better = 'lower' } = {}) {
  if (!Array.isArray(samples)) samples = [samples]
  console.log('PERF ' + JSON.stringify({ scenario, size, unit, better, samples: samples.map((s) => Math.round(s * 1000) / 1000) }))
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

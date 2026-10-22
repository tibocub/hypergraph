// lib/ runs on Node and Bare (spec 011, research R2): no Buffer, no process
// global, no node: specifiers, and Node built-ins only through the package's
// imports map (which sends them to bare-* under Bare).

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const pkg = require('../../../package.json')

const LIB = path.join(__dirname, '..', '..', '..', 'lib')

const NODE_BUILTINS = [
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https',
  'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty',
  'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib'
]

function filesIn (dir) {
  const out = []
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) {
      // a nested project (e.g. a git-ignored clone inside lib/) isn't ours
      if (!fs.existsSync(path.join(full, 'package.json'))) out.push(...filesIn(full))
    }
    else if (name.endsWith('.js')) out.push(full)
  }
  return out
}

// Code without comments and string contents' words, roughly: enough to not
// flag "Buffer" in a comment.
function code (src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n')
}

// Applies the rules to one source text; returns the problems found.
function check (src) {
  const problems = []
  const c = code(src)
  if (/\bBuffer\b/.test(c)) problems.push('uses Buffer (use b4a)')
  const importsProcess = /\bprocess\s*=\s*require\(\s*['"]process['"]\s*\)/.test(c)
  if (!importsProcess && /(^|[^.\w'"])process\s*[.[]/m.test(c)) problems.push('uses the process global (require(\'process\'))')
  for (const [, spec] of c.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (spec.startsWith('node:')) problems.push(`requires ${spec}`)
    else if (NODE_BUILTINS.includes(spec) && !(pkg.imports && pkg.imports[spec])) problems.push(`requires Node built-in ${spec} (not in the imports map)`)
  }
  return problems
}

test('the checker catches each rule', (t) => {
  t.ok(check('const b = Buffer.from("x")').length)
  t.ok(check('if (process.env.X) {}').length)
  t.ok(check('require("node:fs")').length)
  t.ok(check('require("crypto")').length)
  t.is(check('const process = require("process")\nprocess.env.X').length, 0)
  t.is(check('// a Buffer in a comment\nconst b4a = require("b4a")').length, 0)
  t.is(check('const fs = require("fs")').length, 0)
})

test('every file in lib/ follows the Bare rules', (t) => {
  const files = filesIn(LIB)
  t.ok(files.length > 0, `${files.length} files checked`)
  for (const file of files) {
    const problems = check(fs.readFileSync(file, 'utf-8'))
    t.alike(problems, [], path.relative(LIB, file))
  }
})

// Every package lib/ requires is in package.json's dependencies: a plain
// `npm install hypergraph` gets them (blind-peer was a devDependency in 023).

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const pkg = require('../../../package.json')

const LIB = path.join(__dirname, '../../../lib')
const BUILTIN = new Set(['fs', 'path', 'os', 'events', 'process', 'hypergraph']) // mapped in "imports", or this package

// A folder with its own package.json is another package (a local checkout, its node_modules), not lib/'s code.
function files (dir) {
  if (dir !== LIB && fs.existsSync(path.join(dir, 'package.json'))) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : [])
}

test('lib/ requires only declared dependencies', (t) => {
  const missing = new Set()
  for (const file of files(LIB)) {
    for (const [, name] of fs.readFileSync(file, 'latin1').matchAll(/require\('([^.'][^']*)'\)/g)) {
      const base = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]
      if (!BUILTIN.has(base) && !pkg.dependencies[base]) missing.add(base + ' (' + path.relative(LIB, file) + ')')
    }
  }
  t.alike([...missing], [], 'all in dependencies')
})

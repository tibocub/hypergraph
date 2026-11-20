// The published .d.ts (npm run types) work in a strict TypeScript project that installed no @types of its
// own ("types": []), reached through package exports as a user would: no error on right use, an error on a
// typo (so the types really load, not any).

const test = require('brittle')

if (typeof Bare !== 'undefined') {
  test('types consumer: skipped on Bare (a Node script)', (t) => t.pass('skipped on Bare'))
} else {
  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const { spawnSync } = require('child_process')

  const root = path.join(__dirname, '../../..')

  const GOOD = `import next = require('hypergraph/next')
import testing = require('hypergraph/testing')

export async function main (t: Parameters<typeof testing.open>[0]): Promise<void> {
  const hg = await next.Hypergraph.open('dir')
  const space = await hg.createSpace({ name: 'forum' })
  const other = await testing.open(t)
  await other.close()
  await space.close()
  const err: next.HypergraphError | null = null
  void err
  // The public shapes have names of their own.
  const named: next.Space = space
  const status: next.SpaceStatus = named.status()
  const query: next.Query = named.query('post')
  const page: next.Page = await query.latest(10)
  const first: next.HgRecord | undefined = page.items[0]
  const change: next.Change | null = null
  const code: next.ErrorCode = 'NOT_FOUND'
  void status, first, change, code
}
`
  const BAD = `import next = require('hypergraph/next')

export async function typo (): Promise<void> {
  const hg = await next.Hypergraph.open('dir')
  const space = await hg.createSpace()
  space.notAThing()
}
`

  function node (args) {
    return spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' })
  }

  test('types consumer: no @types installed, strict, node16; right use passes, a typo fails', { timeout: 300000 }, async (t) => {
    const tsc = require.resolve('typescript/bin/tsc', { paths: [root] })
    const build = node([tsc, '-p', 'jsconfig.json', '--noEmit', 'false', '--declaration', '--emitDeclarationOnly', '--outDir', 'dist/types'])
    t.is(build.status, 0, 'npm run types: tsc ' + build.stdout.slice(0, 2000))
    const copy = node([path.join(root, 'scripts', 'types.js')])
    t.is(copy.status, 0, 'npm run types: scripts/types.js ' + copy.stderr)

    const dir = fs.mkdtempSync(path.join(process.env.HG_TEST_TMP || os.tmpdir(), 'hg-types-'))
    const link = path.join(dir, 'node_modules', 'hypergraph')
    fs.mkdirSync(path.dirname(link))
    fs.symlinkSync(root, link, 'junction')
    t.teardown(() => {
      // Only the link itself goes (rmdir on a junction leaves its target alone); the folder only once it's gone.
      try { process.platform === 'win32' ? fs.rmdirSync(link) : fs.unlinkSync(link) } catch {}
      if (!fs.existsSync(link)) fs.rmSync(dir, { recursive: true, force: true })
    })

    fs.writeFileSync(path.join(dir, 'good.cts'), GOOD)
    fs.writeFileSync(path.join(dir, 'bad.cts'), BAD)
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, module: 'node16', moduleResolution: 'node16', target: 'ES2022', types: [], noEmit: true },
      files: ['good.cts', 'bad.cts']
    }))

    const res = spawnSync(process.execPath, [tsc, '-p', path.join(dir, 'tsconfig.json')], { cwd: dir, encoding: 'utf8' })
    const errors = res.stdout.split('\n').filter((line) => line.includes('error TS'))
    const elsewhere = errors.filter((line) => !line.startsWith('bad.cts'))
    t.alike(elsewhere, [], 'no error in good.cts or in the published types')
    t.ok(errors.some((line) => line.startsWith('bad.cts') && line.includes('notAThing')), 'space.notAThing is an error: ' + errors.join('\n'))
  })
}

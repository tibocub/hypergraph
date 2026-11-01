// Shared by the site-storage benches (HyperBrowser milestone 0, specs/research/site-storage.md):
// where SwarmFS and the scratch deps are, the test site, a local DHT, timing and sizes.
//
// SWARMFS_DIR: the SwarmFS checkout (default ../SwarmFS next to this repo's main checkout).
// SITE_DEPS: a folder with hyperdrive, corestore, hyperswarm, hyperdht installed
//   (npm i hyperdrive corestore hyperswarm hyperdht), default E:\Code\P2P\.tmp\site-storage-deps.
// BENCH_TMP: where run data goes (default E:\Code\P2P\.tmp\site-storage-run), removed after each run.

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { pathToFileURL, fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
// a worktree lives at <repo>/.claude/worktrees/<name>: the siblings are next to the main checkout
const main = repo.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`) ? repo.split(`${path.sep}.claude${path.sep}`)[0] : repo
export const SWARMFS_DIR = process.env.SWARMFS_DIR || path.resolve(main, '..', 'SwarmFS')
export const SITE_DEPS = process.env.SITE_DEPS || 'E:\\Code\\P2P\\.tmp\\site-storage-deps'
export const BENCH_TMP = process.env.BENCH_TMP || 'E:\\Code\\P2P\\.tmp\\site-storage-run'

export const deps = createRequire(path.join(SITE_DEPS, 'package.json'))
export const swarmfs = () => import(pathToFileURL(path.join(SWARMFS_DIR, 'index.js')).href)
export const swarmfsLib = (name) => import(pathToFileURL(path.join(SWARMFS_DIR, 'lib', name)).href)
// hypergraph as SwarmFS resolves it (its node_modules link)
export const hypergraphNext = () => import(pathToFileURL(createRequire(path.join(SWARMFS_DIR, 'package.json')).resolve('hypergraph/next')).href)

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const now = () => performance.now()

export async function eventually (fn, ms = 30000, every = 20) {
  const until = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() >= until) return null
    await sleep(every)
  }
}

let counter = 0
export function tmpDir (label) {
  const dir = path.join(BENCH_TMP, `${label}-${process.pid}-${Date.now()}-${counter++}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export async function rm (dir) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return } catch { await sleep(200 * attempt) }
  }
}

// A 3-node DHT on 127.0.0.1, like the tests; destroy() when done.
export async function testnet () {
  const createTestnet = deps('hyperdht/testnet.js')
  return createTestnet(3)
}

// Bytes that don't repeat (a filled buffer would compress or dedupe).
export function bytes (n, seed = 1) {
  const b = Buffer.alloc(n)
  let x = seed
  for (let i = 0; i < n; i++) b[i] = (x = (x * 1103515245 + 12345) >>> 0) >>> 24
  return b
}

function text (n, seed) {
  const words = ['peer', 'site', 'page', 'forum', 'swarm', 'post', 'image', 'link', 'hyper', 'space', 'the', 'a', 'of', 'and']
  let x = seed
  let out = ''
  while (out.length < n) out += words[(x = (x * 1103515245 + 12345) >>> 0) % words.length] + ' '
  return out.slice(0, n)
}

// The test site: site.json, index.html + 19 pages (3-12 KB), style.css 8 KB, app.js 30 KB,
// 10 images of 200 KB. 33 files, ~2.2 MB. [{ name, data }]. `seed`: another site, other bytes
// (SwarmFS never downloads content it already holds: identical sites would be fetched once).
export function siteFiles ({ images = 10, imageSize = 200 * 1024, pages = 20, seed = 0 } = {}) {
  const files = [{ name: 'site.json', data: Buffer.from(JSON.stringify({ title: 'Test site ' + seed, entry: 'index.html', permissions: [] })) }]
  for (let i = 0; i < pages; i++) {
    const name = i === 0 ? 'index.html' : `page-${i}.html`
    const body = `<html><head><link rel="stylesheet" href="style.css"><script src="app.js"></script></head><body>${text(3000 + ((i * 4567) % 9000), i + 1 + seed * 1000)}</body></html>`
    files.push({ name, data: Buffer.from(body) })
  }
  files.push({ name: 'style.css', data: Buffer.from(text(8 * 1024, 99 + seed * 1000)) })
  files.push({ name: 'app.js', data: Buffer.from(text(30 * 1024, 98 + seed * 1000)) })
  for (let i = 0; i < images; i++) files.push({ name: `img-${i}.jpg`, data: bytes(imageSize, 1000 + i + seed * 1000) })
  return files
}

// What a browser needs before it can show the entry page.
export const ENTRY = ['site.json', 'index.html', 'style.css', 'app.js']

export function writeSite (dir, files) {
  fs.mkdirSync(dir, { recursive: true })
  for (const f of files) fs.writeFileSync(path.join(dir, f.name), f.data)
  return dir
}

export function duSync (dir) {
  let total = 0
  let count = 0
  const walk = (d) => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else { try { total += fs.statSync(full).size; count++ } catch {} }
    }
  }
  walk(dir)
  return { bytes: total, files: count }
}

export function stats (values) {
  const v = [...values].sort((a, b) => a - b)
  const median = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2
  return { median, min: v[0], max: v[v.length - 1], n: v.length }
}

export const fmt = (s) => `${Math.round(s.median)} ms (${Math.round(s.min)}–${Math.round(s.max)}, n=${s.n})`

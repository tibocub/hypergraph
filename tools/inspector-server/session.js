const Corestore = require('corestore')
const os = require('os')
const path = require('path')
const fs = require('fs')
const Hypergraph = require('../../src/hypergraph')

function makeTmpDir (prefix) {
  const dir = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

module.exports = class InspectorSession {
  #store
  #graph
  #dir
  #openedContexts
  #roleBaseKey

  constructor () {
    this.#store = null
    this.#graph = null
    this.#dir = null
    this.#openedContexts = new Set()
    this.#roleBaseKey = null
  }

  get graph () {
    return this.#graph
  }

  get corestoreDir () {
    return this.#dir
  }

  get openedContexts () {
    return Array.from(this.#openedContexts).sort()
  }

  get roleBaseKey () {
    return this.#roleBaseKey
  }

  async open (corestoreDir) {
    if (!corestoreDir || typeof corestoreDir !== 'string') throw new Error('corestoreDir is required')
    await this.close()

    if (fs.existsSync(corestoreDir)) {
      const st = fs.statSync(corestoreDir)
      if (!st.isDirectory()) throw new Error('corestoreDir exists but is not a directory')
    } else {
      fs.mkdirSync(corestoreDir, { recursive: true })
    }

    const store = new Corestore(corestoreDir)
    const graph = new Hypergraph(store)
    await graph.ready()

    this.#store = store
    this.#graph = graph
    this.#dir = corestoreDir
    this.#openedContexts = new Set()
    this.#roleBaseKey = null

    return { corestoreDir }
  }

  async newDb (opts = {}) {
    const prefix = opts.prefix || 'hypergraph-inspector'
    const dir = makeTmpDir(prefix)
    await this.open(dir)
    return { corestoreDir: dir }
  }

  async close () {
    const g = this.#graph
    const s = this.#store

    this.#graph = null
    this.#store = null
    this.#dir = null
    this.#openedContexts = new Set()
    this.#roleBaseKey = null

    if (g) await g.close()
    if (s) await s.close()
  }

  noteContextOpened (keyHex) {
    if (typeof keyHex !== 'string' || keyHex.length === 0) return
    this.#openedContexts.add(keyHex)
  }

  noteRoleBaseOpened (keyHex) {
    if (typeof keyHex !== 'string' || keyHex.length === 0) return
    this.#roleBaseKey = keyHex
  }
}

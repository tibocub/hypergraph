// A site's handle on the engine (spec 015, US5): what a web view's code
// reaches of one space and its sub-spaces, and nothing else: not the other
// spaces, the personal space, the recovery phrase, the devices or budgets.
// It keeps its space open while alive.
//
// A site acts under its own key by default, derived from the identity and not
// linkable to it (research.md R5b); until that is built, only a handle
// opened with the main identity ({ identity: 'main' }, after the person said
// yes) exists, and the default throws NOT_SUPPORTED.

const z32 = require('z32')
const b4a = require('b4a')
const { HypergraphError } = require('./errors.js')
const symbols = require('./symbols.js')

// Space methods a site may call.
const METHODS = ['put', 'get', 'edit', 'del', 'query', 'linked', 'count', 'sum', 'members', 'decisions', 'tags', 'relate',
  'unrelate', 'edges', 'tag', 'untag', 'getByTag', 'getRole', 'setRole', 'removeRole', 'defineRole', 'roles',
  'moderateAction', 'report', 'reports', 'createInvite', 'revokeInvite', 'createSubspace', 'subspaces', 'redemptions',
  'peers', 'memberConnections', 'addProtocol', 'status', 'isComplete', 'completeFrom', 'types', 'ready']
const GETTERS = ['key', 'name', 'parent', 'private', 'typesVersion', 'history', 'helpers', 'opened']
const EVENTS = ['change', 'peers', 'members', 'decisions', 'status']

class Scope {
  #hg
  #space
  #top // its top space
  #listeners = new Map() // fn -> event
  #release = null
  #closed = false

  constructor (hg, space, { identity, top = null }) {
    this.#hg = hg
    this.#space = space
    this.#top = top || space
    this.identity = identity
    for (const name of METHODS) this[name] = (...args) => this.#live()[name](...args)
    for (const name of GETTERS) Object.defineProperty(this, name, { enumerable: true, get: () => this.#space[name] })
  }

  #live () {
    if (this.#closed) throw new HypergraphError('CLOSED', 'This handle is closed')
    return this.#space
  }

  // A sub-space of this site's space (key z32), as a handle of its own.
  subspace (key) {
    this.#live()
    const space = this.#hg.space(key)
    if (!space.rootKey || !b4a.equals(space.rootKey, this.#top.keyBytes)) throw new HypergraphError('NOT_ALLOWED', 'That space is not one of this site\'s')
    return new Scope(this.#hg, space, { identity: this.identity, top: this.#top })
  }

  on (event, fn) {
    if (!EVENTS.includes(event)) throw new HypergraphError('NOT_ALLOWED', `A site may listen to ${EVENTS.join(', ')}`)
    this.#live().on(event, fn)
    this.#listeners.set(fn, event)
    return this
  }

  off (event, fn) {
    this.#space.off(event, fn)
    this.#listeners.delete(fn)
    return this
  }

  async _hold () {
    this.#release = await this.#space.hold()
  }

  // Lets the space go (it may close once idle).
  async close () {
    if (this.#closed) return
    this.#closed = true
    for (const [fn, event] of this.#listeners) this.#space.off(event, fn)
    this.#listeners.clear()
    if (this.#release) this.#release()
  }
}

// hg.scope(keyOrInvite, { identity }): the space held, joined with the
// invite, or opened by its key.
async function scope (hg, target, { identity = 'site' } = {}) {
  if (identity !== 'main') throw new HypergraphError('NOT_SUPPORTED', 'A site\'s own key (not linkable to the person) is not built yet: open it with { identity: \'main\' } once the person agreed to show their identity to this site')
  let space = null
  if (typeof target === 'string' && target.startsWith('hg:')) space = await hg.redeemInvite(target)
  else {
    let held = null
    try { held = hg.space(target) } catch {}
    space = held || await hg[symbols.openSpace](typeof target === 'string' ? z32.decode(target) : target)
  }
  if (space.rootKey) throw new HypergraphError('NOT_ALLOWED', 'A site is a top space; reach its sub-spaces with site.subspace(key)')
  const out = new Scope(hg, space, { identity: hg.identity })
  await out._hold()
  return out
}

module.exports = { scope, Scope }

const Corestore = require('corestore')
const path = require('path')
const fs = require('fs')
const { Hypergraph } = require('../../index.js')
const ForumNetwork = require('./network/hyperswarm')
const ForumStorage = require('./storage')
const ForumPolicy = require('./policy')
const ConsoleUI = require('./ui/console')

function argValue (argv, key) {
  const pref = `--${key}=`
  const a = argv.find(v => v.startsWith(pref))
  return a ? a.slice(pref.length) : null
}

async function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main () {
  const argv = process.argv.slice(2)

  const storageDir = argValue(argv, 'storage') || path.join(process.cwd(), '.data', 'forum-owner')
  const manifestPath = argValue(argv, 'manifest') || path.join(process.cwd(), 'site.json')
  const addCommentsWriter = argValue(argv, 'addCommentsWriter')
  const addModerationWriter = argValue(argv, 'addModerationWriter')
  const forceNew = argv.includes('--new')

  if (!argValue(argv, 'storage')) {
    console.log('Usage:')
    console.log('  node examples/forum/owner.js --storage=./.data/forum-owner --manifest=./site.json')
    console.log('  node examples/forum/peer.js  --storage=./.data/forum-peer  --manifest=./site.json')
    console.log('')
    console.log('NOTE: storage dirs MUST be unique per running peer (RocksDB locking).')
    console.log('')
  }

  fs.mkdirSync(storageDir, { recursive: true })

  const store = new Corestore(storageDir)
  const graph = new Hypergraph(store)
  await graph.ready()

  let manifest = null
  if (!forceNew && fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  }

  let commentsContext = null
  let moderationContext = null
  let roleBaseKey = null

  if (manifest && manifest.version === 1 && manifest.contexts && manifest.owner) {
    commentsContext = manifest.contexts.comments
    moderationContext = manifest.contexts.moderation
    roleBaseKey = manifest.roleBase || null
    console.log('Loaded manifest:', manifestPath)
  } else {
    commentsContext = await graph.createContext()
    moderationContext = await graph.createContext()

    roleBaseKey = await graph.createRoleBase()
    const ownerKey = graph.key.toString('hex')
    await graph.roleBase.init(ownerKey)
    await graph.roleBase.append({
      type: 'roles/setRolePermissions',
      role: 'member',
      permissions: ['content.flag', 'content.hide', 'content.remove', 'content.reveal'],
      author: ownerKey,
      timestamp: Date.now()
    })

    manifest = {
      version: 1,
      owner: graph.key.toString('hex'),
      roleBase: roleBaseKey,
      contexts: {
        comments: commentsContext,
        moderation: moderationContext
      }
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    console.log('Wrote manifest:', manifestPath)
    console.log(JSON.stringify(manifest, null, 2))
  }

  const commentsCtx = await graph.openContext(commentsContext)
  const moderationCtx = await graph.openContext(moderationContext)

  if (addCommentsWriter) {
    await commentsCtx.addWriter(Buffer.from(addCommentsWriter, 'hex'))
    console.log('Added comments writer:', addCommentsWriter)
  }

  if (addModerationWriter) {
    await moderationCtx.addWriter(Buffer.from(addModerationWriter, 'hex'))
    console.log('Added moderation writer:', addModerationWriter)
  }

  if (manifest.owner !== graph.key.toString('hex')) {
    console.log('WARNING: manifest.owner does not match this owner core key')
    console.log('manifest.owner:', manifest.owner)
    console.log('this owner key:', graph.key.toString('hex'))
  }

  const network = new ForumNetwork(store, { role: 'owner' })

  let scheduleRender = () => {}

  network.on('control-message', async (msg, conn) => {
    if (!msg || msg.type !== 'writer-request') return

    console.log('Received writer-request')

    try {
      const commentsWriter = typeof msg.commentsWriter === 'string' ? msg.commentsWriter : null
      const moderationWriter = typeof msg.moderationWriter === 'string' ? msg.moderationWriter : null

      if (commentsWriter) await commentsCtx.addWriter(Buffer.from(commentsWriter, 'hex'))
      if (moderationWriter) await moderationCtx.addWriter(Buffer.from(moderationWriter, 'hex'))

      network.sendControl(conn, {
        type: 'writer-granted',
        comments: Boolean(commentsWriter),
        moderation: Boolean(moderationWriter)
      })

      scheduleRender()
    } catch (err) {
      network.sendControl(conn, {
        type: 'writer-error',
        message: err && err.message ? err.message : String(err)
      })
    }
  })

  await network.join(graph.discoveryKey)

  // Create starter identity + starter post
  await graph.setIdentity({ username: 'owner', bio: 'site owner' })

  const storage = new ForumStorage(graph, {
    commentsContext,
    moderationContext
  })

  const policy = new ForumPolicy({
    trustedModeratorKeys: []
  })

  const ui = new ConsoleUI(storage, policy)

  let renderTimer = null
  let lastSig = null

  const render = async () => {
    renderTimer = null
    await graph.update()

    const posts = await storage.listPosts()
    const sig = JSON.stringify({
      posts: posts.map(p => p.id),
      commentsVersion: commentsCtx.version,
      moderationVersion: moderationCtx.version
    })

    if (sig === lastSig) return
    lastSig = sig
    await ui.printPosts()
  }

  scheduleRender = () => {
    if (renderTimer) return
    renderTimer = setTimeout(() => render().catch(console.error), 100)
  }

  await graph.update()
  const existing = await storage.listPosts()
  if (existing.length === 0) {
    const post = await storage.createPost('Hello from the owner')
    console.log('Seed post:', post.id)
  }

  if (graph.core) {
    graph.core.on('append', scheduleRender)
    graph.core.on('download', scheduleRender)
  }
  if (commentsCtx.core) {
    commentsCtx.core.on('append', scheduleRender)
    commentsCtx.core.on('download', scheduleRender)
  }
  if (moderationCtx.core) {
    moderationCtx.core.on('append', scheduleRender)
    moderationCtx.core.on('download', scheduleRender)
  }

  await render()
  for (;;) await sleep(60 * 60 * 1000)
}

main().catch(console.error)

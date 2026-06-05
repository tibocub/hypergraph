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

  const storageDir = argValue(argv, 'storage') || path.join(process.cwd(), '.data', 'forum-peer')
  const manifestPath = argValue(argv, 'manifest') || path.join(process.cwd(), 'site.json')
  const replyTo = argValue(argv, 'replyTo') || null
  const replyBody = argValue(argv, 'replyBody') || 'hi'
  const modTarget = argValue(argv, 'moderate') || null
  const modAction = argValue(argv, 'action') || 'content.flag'

  if (!argValue(argv, 'storage')) {
    console.log('Usage:')
    console.log('  node examples/forum/peer.js --storage=./.data/forum-peer --manifest=./site.json')
    console.log('')
    console.log('NOTE: storage dirs MUST be unique per running peer (RocksDB locking).')
    console.log('')
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  if (!manifest || manifest.version !== 1) throw new Error('Invalid manifest')

  fs.mkdirSync(storageDir, { recursive: true })

  const store = new Corestore(storageDir)
  const graph = new Hypergraph(store)
  await graph.ready()

  const ownerCore = await graph.openUserCore(manifest.owner)
  const commentsCtx = await graph.openContext(manifest.contexts.comments)
  const moderationCtx = await graph.openContext(manifest.contexts.moderation)

  if (manifest.roleBase) {
    await graph.openRoleBase(manifest.roleBase)
  }

  console.log('Peer comments writer key:', commentsCtx.localKey.toString('hex'))
  console.log('Peer moderation writer key:', moderationCtx.localKey.toString('hex'))
  console.log('Requesting writer access from owner...')

  let renderTimer = null
  let render = null

  const scheduleRender = () => {
    if (renderTimer) return
    renderTimer = setTimeout(() => {
      const fn = render
      renderTimer = null
      if (fn) fn().catch(console.error)
    }, 100)
  }

  const network = new ForumNetwork(store)
  network.on('control-connection', (conn) => {
    console.log('Control connection established. Sending writer request...')
    network.sendControl(conn, {
      type: 'writer-request',
      commentsWriter: commentsCtx.localKey.toString('hex'),
      moderationWriter: moderationCtx.localKey.toString('hex')
    })
  })

  network.on('control-message', (msg) => {
    if (!msg) return
    if (msg.type === 'writer-granted') {
      console.log('Owner granted writer access (waiting for replication to apply).')
    }
    if (msg.type === 'writer-error') {
      console.log('Owner writer handshake error:', msg.message)
    }

    scheduleRender()
  })

  await network.join(ownerCore.discoveryKey)

  const storage = new ForumStorage(graph, {
    commentsContext: manifest.contexts.comments,
    moderationContext: manifest.contexts.moderation
  })

  await graph.setIdentity({ username: 'peer', bio: 'peer user' })

  const policy = new ForumPolicy({
    trustedModeratorKeys: []
  })

  const ui = new ConsoleUI(storage, policy)

  let didActions = false
  let lastSig = null

  render = async () => {
    renderTimer = null
    await graph.update()

    const posts = await storage.listPosts()
    const firstPostId = posts[0] ? posts[0].id : null

    const sig = JSON.stringify({
      posts: posts.map(p => p.id),
      commentsWritable: commentsCtx.writable,
      moderationWritable: moderationCtx.writable,
      commentsVersion: commentsCtx.version,
      moderationVersion: moderationCtx.version
    })

    if (sig !== lastSig) {
      lastSig = sig
      await ui.printPosts()
      if (firstPostId) await ui.printThread(firstPostId)
    }

    if (didActions) return
    if (!firstPostId) return
    if (!commentsCtx.writable && !moderationCtx.writable) return

    if ((replyTo || firstPostId) && commentsCtx.writable) {
      const target = replyTo || firstPostId
      const c = await storage.reply(target, replyBody)
      console.log('Replied with:', c.id)
    } else if (replyTo) {
      console.log('Skipping reply: comments context not writable')
    }

    if (modTarget && moderationCtx.writable) {
      const ev = await storage.moderate(modTarget, modAction, 'example')
      console.log('Moderation event:', ev.eventId)
    } else if (modTarget) {
      console.log('Skipping moderation: moderation context not writable')
    }

    didActions = true
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

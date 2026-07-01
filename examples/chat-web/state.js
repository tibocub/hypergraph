function shortKey (hex) {
  if (!hex) return ''
  return hex.slice(0, 8)
}

async function projectRoom (storage, room) {
  const content = await storage.graph.getContent(room.id)
  const ident = await storage.getIdentity(room.author)
  const username = ident && ident.username ? ident.username : shortKey(room.author)

  let messageCount = 0
  for await (const _e of storage.graph.edges(room.id, { direction: 'in', type: 'message' })) messageCount++

  return {
    id: room.id,
    author: room.author,
    username,
    createdAt: room.createdAt || null,
    name: content ? content.body : '',
    messageCount
  }
}

async function projectRoomWithMessages (storage, roomId) {
  const room = await storage.graph.get(roomId)
  if (!room) return null

  const roomContent = await storage.graph.getContent(roomId)
  const roomIdent = await storage.getIdentity(room.author)
  const roomUsername = roomIdent && roomIdent.username ? roomIdent.username : shortKey(room.author)

  const messages = await storage.getMessages(roomId)
  const projectedMessages = []
  for (const m of messages) {
    const ident = await storage.getIdentity(m.node.author)
    const username = ident && ident.username ? ident.username : shortKey(m.node.author)

    projectedMessages.push({
      id: m.node.id,
      author: m.node.author,
      username,
      createdAt: m.node.createdAt || null,
      body: m.content ? m.content.body : ''
    })
  }

  projectedMessages.sort((a, b) => {
    const ta = a.createdAt || 0
    const tb = b.createdAt || 0
    return ta - tb
  })

  return {
    id: roomId,
    author: room.author,
    username: roomUsername,
    createdAt: room.createdAt || null,
    name: roomContent ? roomContent.body : '',
    messages: projectedMessages
  }
}

async function buildChatState (storage, contexts, opts = {}) {
  await storage.graph.update()

  const roomId = opts.room || null

  const rooms = await storage.listRooms()
  const projectedRooms = []
  for (const r of rooms) projectedRooms.push(await projectRoom(storage, r))

  projectedRooms.sort((a, b) => {
    const ta = a.createdAt || 0
    const tb = b.createdAt || 0
    return tb - ta
  })

  const mePubkey = storage.graph.key ? storage.graph.key.toString('hex') : null
  const meIdent = mePubkey ? await storage.getIdentity(mePubkey) : null

  const room = roomId ? await projectRoomWithMessages(storage, roomId) : null

  return {
    me: {
      pubkey: mePubkey,
      username: meIdent && meIdent.username ? meIdent.username : null
    },
    chat: {
      contexts: {
        messages: contexts.messages
      }
    },
    rooms: projectedRooms,
    room
  }
}

module.exports = {
  buildChatState
}

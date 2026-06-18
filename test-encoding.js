const { encodeEvent, decodeEvent } = require('./src/encodings/event')

// Test encoding/decoding of tag/add event
const tagAddEvent = {
  type: 'tag/add',
  entityId: 'post/a',
  tag: 'a',
  author: 'abc123',
  timestamp: Date.now(),
  signature: null
}

console.log('Original event:', tagAddEvent)

const encoded = encodeEvent(tagAddEvent)
console.log('Encoded buffer length:', encoded.length)
console.log('Encoded buffer:', encoded)

const decoded = decodeEvent(encoded)
console.log('Decoded event:', decoded)

console.log('Match:', JSON.stringify(tagAddEvent) === JSON.stringify(decoded))

// Test encoding/decoding of relation/create event
const relationCreateEvent = {
  type: 'relation/create',
  from: 'post/1',
  to: 'post/2',
  relationType: 'reply',
  author: 'abc123',
  timestamp: Date.now(),
  signature: null
}

console.log('\n--- Relation Create ---')
console.log('Original event:', relationCreateEvent)
const encodedRel = encodeEvent(relationCreateEvent)
console.log('Encoded buffer length:', encodedRel.length)
const decodedRel = decodeEvent(encodedRel)
console.log('Decoded event:', decodedRel)
console.log('Match:', JSON.stringify(relationCreateEvent) === JSON.stringify(decodedRel))

// Test encoding/decoding of relation/delete event
const relationDeleteEvent = {
  type: 'relation/delete',
  from: 'post/1',
  to: 'post/2',
  relationType: 'reply',
  author: 'abc123',
  createdAt: Date.now(),
  timestamp: Date.now(),
  signature: null
}

console.log('\n--- Relation Delete ---')
console.log('Original event:', relationDeleteEvent)
const encodedDel = encodeEvent(relationDeleteEvent)
console.log('Encoded buffer length:', encodedDel.length)
const decodedDel = decodeEvent(encodedDel)
console.log('Decoded event:', decodedDel)
console.log('Match:', JSON.stringify(relationDeleteEvent) === JSON.stringify(decodedDel))

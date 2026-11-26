// I2P addresses: base32 both ways, the DHT's 34-byte address encoding and ids, Ed25519 keys out of a destination,
// SAM reply lines.

const test = require('brittle')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const address = require('../../../lib/i2p/address.js')
const peer = require('../../../lib/i2p/dht-rpc/lib/peer.js')
const { parse } = require('../../../lib/i2p/sam.js')
const { destination } = require('../net/_sam.js')

test('i2p address: base32 both ways, 52 characters for 32 bytes; anything else refused', (t) => {
  const buf = b4a.alloc(32)
  sodium.randombytes_buf(buf)
  const s = address.toBase32(buf)
  t.is(s.length, 52)
  t.alike(address.fromBase32(s), buf)
  t.exception(() => address.fromBase32(s.slice(1)), /not an I2P address/)
  t.exception(() => address.fromBase32(s.slice(1) + '1'), /not an I2P address/, '1 is not base32')
})

test('i2p address: the DHT encodes an address in 34 bytes, its id is the hash of them', (t) => {
  const host = address.toBase32(b4a.alloc(32, 7))
  const state = { start: 0, end: 0, buffer: b4a.alloc(0) }
  peer.ipv4.preencode(state, { host, port: 1 })
  t.is(state.end, peer.SIZE)
  state.buffer = b4a.alloc(state.end)
  peer.ipv4.encode(state, { host, port: 513 })
  state.start = 0
  t.alike(peer.ipv4.decode(state), { id: null, host, port: 513 })
  t.alike(peer.id(host, 513), peer.id(host, 513))
  t.unlike(peer.id(host, 513), peer.id(host, 514), 'the port is in the id')
})

test('i2p address: a private destination gives its public part, address and Ed25519 key pair', (t) => {
  const { pub, priv } = destination()
  t.alike(address.publicOf(priv), pub)
  t.ok(address.isEd25519(pub))
  t.is(address.addressOf(pub), address.toBase32(address.sha256(pub)))
  const kp = address.signingKeyPair(priv)
  t.alike(kp.publicKey, address.signingKeyOf(pub))
  const sig = b4a.alloc(64)
  sodium.crypto_sign_detached(sig, b4a.from('x'), kp.secretKey)
  t.ok(sodium.crypto_sign_verify_detached(sig, b4a.from('x'), address.signingKeyOf(pub)))
  t.alike(address.fromI2PBase64(address.toI2PBase64(priv)), priv, 'I2P base64 both ways')
  const other = destination().priv
  t.exception(() => address.signingKeyPair(b4a.concat([pub, other.subarray(pub.length)])), /not an Ed25519 destination/, 'a seed that is not the key in it')
})

test('sam: reply lines', (t) => {
  t.alike(parse('SESSION STATUS RESULT=OK DESTINATION=abc~-'), { _: 'SESSION STATUS', RESULT: 'OK', DESTINATION: 'abc~-' })
  t.alike(parse('HELLO REPLY RESULT=I2P_ERROR MESSAGE="bad"'), { _: 'HELLO REPLY', RESULT: 'I2P_ERROR', MESSAGE: 'bad' })
})

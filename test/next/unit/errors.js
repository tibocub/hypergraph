const test = require('brittle')
const { HypergraphError, codes } = require('../../../lib/errors.js')

test('HypergraphError carries a stable code and is an Error', (t) => {
  const err = new HypergraphError('NOT_ALLOWED', 'only the author may edit this post')
  t.ok(err instanceof Error)
  t.is(err.code, 'NOT_ALLOWED')
  t.is(err.name, 'HypergraphError')
  t.ok(err.message.includes('only the author'))
})

test('every code of the contract exists', (t) => {
  for (const code of ['NOT_ALLOWED', 'NOT_FOUND', 'INVALID_RECORD', 'INVALID_TYPE', 'INCOMPATIBLE_TYPES', 'RULE_REJECTED',
    'INVITE_INVALID', 'INVITE_EXPIRED', 'INVITE_USED_UP', 'INVITE_REVOKED', 'DEVICE_REMOVED', 'CLOSED']) {
    t.is(codes[code], code)
  }
})

test('an unknown code is a bug, not an error to show', (t) => {
  t.exception(() => new HypergraphError('NOPE', 'x'))
})

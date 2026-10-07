# Quickstart: validating v2 private channels and invites

Prerequisites: `npm install` in `E:\Code\P2P\hypergraph`; Node.js 26.

## Tests

```bash
node scripts/test-runner.js v2
```

Expected: the new files `private.js`, `grants.js`, `invites.js`, `private-rest.js` pass with the
spec 007 v2 tests.

- `private.js`: a non-member and a keeper without the key get `encrypted: true, text: null` for every
  message; a member gets the text; no message text appears in the raw blocks.
- `grants.js`: a revoked member reads none of the messages posted after `revoke()` and still reads
  older ones; concurrent rotations converge; forged grants are ignored.
- `invites.js`: a link with a role and a private channel, redeemed with its maker offline, gives the
  role once a writer is online and the key once a key holder is online; a link with `uses: 2` gives
  access to exactly 2 of 3 newcomers; an expired or revoked link gives nothing.

## Benchmarks (one at a time, CLAUDE.md on machine load)

```bash
node bench/v2-grants.js            # own-grant bytes at 10 / 1,000 / 50,000 members; revoke with 1,000
node bench/v2-chat.js 1000000 --live 0 --private
```

Expected: own grant < 32 KB at 50,000 (SC-002); revoke with 1,000 members < 60 s, members get the new
epoch < 10 s after being online (SC-003); the private latest page within 10% of the public run plus
the grant lookup (SC-001).

## Consumers

```bash
cd E:\Code\P2P\hyperDNS && npm test
```

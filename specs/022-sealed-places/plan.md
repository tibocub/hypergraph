# Plan 022: private spaces encrypted on disk

**Spec**: [spec.md](spec.md) · Node and Bare · no new dependency.

## Research (worker, before code)

- **R1** Reuse the personal space's path: `_coreOpts` (`space.js:89`) and the decision log's `encryptionKey`
  (`space.js:385` → `decisions/log.js:53`). List every `store.get` of a space's cores and check each gets the key;
  the key-free sessions at `decisions/log.js:135`, `index.js:1017`, `index.js:1162` (lengths, clears) must still work on
  an encrypted core: test them.
- **R2** Key handover: a new message on `hypergraph/space/3` (directory.js), sent by the decider that appends the
  `invite/redeem`, to the redeeming device, sealed to its box key. The newcomer waits for it before reading the
  decision log (it can't see `redeemed:` before). If no key arrives before the redeem timeout: the same error as today.
  Precedent: device pairing hands the personal key (`pairing.js:39-64`).
- **R3** Where the newcomer's device box key comes from: the redemption is signed by the newcomer's writer/device; check
  the device public key is in it or in the hello proof, else add it to the redemption.
- **R4** Personal space: store the disk key next to the joined space's entry; other devices open from it (FR-003/004).
- **R5** `space.rotateKey()`: public wrapper of `#rotateOnce()` with the decider/moderator check.
- **R6** Holder check: a blind peer (`blind-peer` in tests, spec 013's setup) keeps and serves an encrypted space; a
  member offline the whole time gets it back from the blind peer only.

## Order

1. Tests first (spec's list), failing.
2. Disk key on create and open (R1), handover (R2, R3), personal space (R4).
3. `rotateKey()` (R5), blind peer test (R6).
4. Docs (`docs/` private spaces page, API), forum scenario, perf. SwarmFS suite against it (its `node_modules/hypergraph`
   links here). HyperBrowser suites too (Chat's private conversations).

One worker, one commit per step.

## Risks

- A key-free session reading a block of an encrypted core (R1): would return garbage, not throw. Tests must read.
- Join time grows by one round trip (R2): measured in perf.

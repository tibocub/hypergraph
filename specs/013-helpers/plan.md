# Implementation Plan: Helpers (optional blind peers)

**Branch**: `013-helpers` | **Spec**: [spec.md](spec.md)

## Summary

Client side only. The helper list is a field of the existing `settings/set` decision (owner only);
each `Space` runs one `blind-peering` client (new `lib/helpers.js`) on the instance's DHT, hands over its
decision log (`addAutobaseBackground`) and logs (`addCoreBackground`), never awaited. A new `logs/list`
decision lets members find logs whose authors they never met.

## Technical Context

Node + Bare, `hypergraph/next` (`lib/`). New dependency: `blind-peering` (moved from devDependencies;
`blind-peer` stays a dev dependency for tests). Tests: brittle, local DHT (`test/next/helpers.js`), a real
`blind-peer` server in-process.

## Design

1. **Setting** (`lib/encodings.js`, `lib/decisions/apply.js`, `lib/decisions/state.js`): `settings/set`
   gets a trailing `helpers` list (hex strings; old entries decode as null). Applied only if the author's
   role is `owner` (one line to loosen later) and not inside a sub-space; `[]` clears. `meta.helpers`;
   sub-spaces inherit it through `SubState.meta`.
2. **API** (`lib/space.js`): `setHelpers(keys)` (owner, top space, ≤ 8 keys of 32 bytes, refused
   otherwise), `helpers` getter (z32). Event: the existing `decisions`.
3. **Client** (`lib/helpers.js`): per space, when online and the list is non-empty, a `BlindPeering(dht,
   store, { keys })`; re-made when the list changes, closed with the space. `hold(core)` for every held
   log (on accept) and the decision log's Autobase. Only background calls.
4. **Listed logs** (`logs/list` decision, `[{ space, log }]`): a device that records decisions, in a space
   with helpers, lists the logs it holds that aren't listed yet, batched (1 s). Applied for any author who
   records decisions; stored `listed:<log hex>` → space hex. Each space considers its listed logs on every
   decision change (`directory.consider`: the gate checks them as any other key from a peer).
5. **Network** (`lib/network.js`): `connect()` tells spaces to start helpers (the DHT exists only then).

## Constitution Check

- I (partition): helpers are optional and never awaited; listed logs pass the same gate as peer-named ones.
- II (test-first): tests below written first, fail before the change.
- III (thin composition): `blind-peering` unchanged; no replication of our own.
- IV (one API): apps call `setHelpers` once; connecting and handing over is automatic.
- V (breaking): additive; wire format grows (a trailing field, a new decision type): older peers ignore
  the field and skip the new decision. CHANGELOG entry.
- Doc-sync: `docs/next/api.md`, `docs/next/concepts.md` updated.

## Tests

`test/next/net/helpers.js`: (1) away member reads owner's and a never-met member's posts through the helper
alone; (2) dead/bogus helper: no waiting; (3) admin refused, hand-written decision ignored; (4) private:
helper holds no plaintext, away member reads. `test/next/forum/helpers.js`: the forum flow (owner adds the
VPS helper, members see "kept by", a friend away reads). `test/next/unit`: encoding round-trip of old and
new `settings/set`.

## Complexity Tracking

`logs/list` is new state in the decision log (not in the request): without it a helper only serves authors
a member already knew, so a returning member misses every newcomer's posts. Shortcut: one key per log,
fine for small forums; a big open space would need a per-period index instead.

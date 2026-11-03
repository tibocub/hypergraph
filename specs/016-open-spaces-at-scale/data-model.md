# Data model: Open spaces at scale

## Decision view (apply-time)

| key | before | after |
|---|---|---|
| `meta` (top space) / `sub:<s>:meta` | `{ name, owner, policy, private, version, parent, stamp, writeLimit, rules, history, helpers, ... }` | + `public: true` once made public (absent = not public). Never set back. |
| `member:<id>` | every member | only members recorded by a decision: the owner, people let in by an invite link, roles set by decision. Public joiners have none. |
| `redeemed:`, `uses:` | per redemption | unchanged, for invite links only |
| `banned:`, `cut:` | per person | unchanged; apply to public joiners too |
| `listed:<log>` | per log, in spaces with helpers | unchanged (R8); grows with posters only, since logs exist from the first record |

### Decision `settings/set`

Trailing field added: `public` (bool | absent).

- Counted when: its writer may decide in that scope, and `public === true`.
- Not counted when: `public === false` and the scope is public; the writer may not decide.
- Effect: `meta.public = true` for the scope; `touched().all` (every log rechecked).

## State (derived, `lib/decisions/state.js`)

- `public`: the scope's `meta.public === true`.
- `roleOf(id)`: `member:<id>.role` → else `public && !banned(id)` → `'member'` → else null.
- `mustAdmit(id, log)`: false when `roleOf(id)` is the fallback.

## Log header

Unchanged (`{ version, space, decisions, proof, admitted }`, `enc.VERSION` unchanged). In a public space
the `proof` is the join.

## Links

| kind | body (z32 after `hg:`) | made by | revocable |
|---|---|---|---|
| invite link | an encoded, signed invite (+ root) | a member allowed to invite | yes |
| public link | space key (32 B) [+ root key (32 B)] | nobody (derived) | no |

## Directory (local)

A held log: `{ key, identity, device, limit, indexed, ... , core | null }`. `core` is null while closed
(R6); opened for own, behind, read, budget; closed after 30 s idle.

## Space channel (`hypergraph/space/2`)

| message | fields | replaces |
|---|---|---|
| summary | `{ count, digest, records }` | same |
| ranges | `{ prefix (bytes), bits, parts: 16 × { count, digest } }` | `want` |
| keys | `{ prefix, bits, keys: [32 B] }` | `logs` (whole list) |

Other messages (notice, get, redeem, ask, hello, activity) keep their encodings.

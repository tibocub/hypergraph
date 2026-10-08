# Data model: Spaces

What is stored where. Encodings are `compact-encoding` structs in `lib/encodings.js`; sizes are from the
design brief's measurements.

## On the network (replicated, signed)

### Device log (a Hypercore per device per space)

| block | content |
|---|---|
| 0 | **Log header**: `{ version, space (32 B), decisions (32 B, decision log key), proof (keet-identity-key device proof, 139–235 B) }` |
| 1.. | **Record**: `{ kind: put \| edit \| delete, type (string), stamp (uint ms), target? (record id), links: [record id \| space key], fields (tagged bytes) , sealed? }` |

- Record id: `log key (32 B) + seq (varint)`; z32 string in the API.
- `fields`: per present field `number (uint) + length (uint) + value` (experiment 6); unknown numbers
  skipped. Records ≤ 64 KB.
- Private spaces: `fields` and `links` sealed (`{ epoch, nonce (24 B), box }`, XChaCha20-Poly1305, AD =
  space + log + seq + epoch, spec 008).
- Built-in types: `hg/relation { from, to, type, value?, data? (≤ 4 KB) }`, `hg/tag { target, tag }`,
  `hg/grant { recipient (16 B prefix), epoch, commit (8 B), sealed, granter, sig }`,
  `hg/device-remove { device, cut, attestation }`.

**Validation (the gate, R11)**: header proof valid and identity a member (or allowed by write rules) and
device not removed; seq < cut; decodes; type rules (links' targets, editors); app rules; write limit.

### Decision log (an Autobase per space)

Ordered entries; applied deterministically; each valid only if its author held the permission at that
point.

| decision | fields |
|---|---|
| `space/init` | `name, parent?, private, policy, version` |
| `member/add` | `identity` |
| `member/remove` | `identity, cut ([{log, length}])` — research.md A4 |
| `role/define` | `name, permissions[]` (custom roles; never takes 'post' away: research.md A5) |
| `role/set` | `identity, role, cut ([{log, length}])` — the cut counts only if the role takes 'post' away |
| `moderate` | `action (flag\|hide\|remove\|reveal\|ban), target (record id \| identity), reason, cut ([{log, length}]: bans)` |
| `invite/create`, `invite/revoke`, `invite/redeem` | spec 008's invite and redemption |
| `key/rotate` | `epoch, commit` (private) |
| `subspace/create` | `key, name, private, writeRoles[]` |
| `settings/set` | `policy?, writeLimit? { records, periodMs }` |

**State** (rebuilt by applying the log): members, roles and permissions, custom roles, moderation flags
per record, bans and removals with cuts (`cut:<identity>`: first cut per log wins), invites and redemptions, epochs, sub-spaces, settings. A sub-space's
effective state = parent's members, roles, bans, then its own decisions; parent bans always win.

Built-in roles and permissions (as v1): `owner` (all), `admin` (decide, moderate, invite, roles below
admin), `moderator` (moderate), `member` (post), `guest` (post in its sub-space). Permission `decide` or
`moderate` makes a member's device a decision-log writer (its key comes with its invite redemption).

View keys (research.md A4–A5): `meta`, `member:<id>` `{ role, by, stamp, writer }`, `writer:<key>`,
`role:<name>` `{ permissions }`, `cut:<id>` `{ logs: { <log>: length } }`, `banned:<id>`,
`mod:<record id>` `{ flagged, hidden, removed }`, `redeemed:<invite>:<id>`, `uses:<invite>`.
A redemption is `{ invite, identity, writer, proof }`.

### Space channel messages (Protomux `hypergraph/space`, id = space key)

`summary { count, digest (32 B XOR) }`, `want {}`, `logs [log key]`, `notice { log }`, `get { log }`
(experiment 1), `redeem { redemption }` (a newcomer's signed invite redemption, research.md A3); story 9
adds `period, start` to log entries.

## On the device only (never replicated)

### HyperDB index (`<dir>/index`)

| collection | key | holds |
|---|---|---|
| `records` | `space, id` | type, author, device log, seq, stamp, current fields, links, flags (hidden, removed, deleted, edited) |
| `logs` | `space, log` | identity, device, indexed length, cut, refused? |
| `changes` | `space, target, id` | an edit or delete by its target: kind, type, author, device, stamp, fields, links (research.md A2); also found by its own id (`changes-by-id`, for cuts) |
| `spaces` | `key` | the spaces this instance holds: Corestore namespace, name, parent |
| `meta` | `name` | declared types (compat check), identity (proof, recovery phrase), budgets, schema version |

Indexes: `by-type (space, type, stamp)`, `by-author (space, author, stamp)`, `by-link (space, target,
type, stamp)`, `by-ix (space, app key…)` (map over declared `index`), `one-per-member (space, type,
target, author)`, `grants-for (space, recipient prefix, epoch)` (story 8). `records` rows also carry the current version's
`vstamp`/`vdevice` and, for one-per-member types, `opm` + `target`.

### Corestore (`<dir>/cores`)

Device logs (own and others'), decision logs, the personal space's logs. Budget accounting = stored
bytes (block + ~130 B) per space.

## State transitions

- **Record**: written → (gate) indexed → edited (newer allowed edit replaces fields; id unchanged) →
  deleted (hidden, bytes cleared) ; or hidden ↔ revealed ; or removed (moderation, permanent) ; or cut
  (ban / device removal: rows deleted, never re-indexed).
- **Log**: announced → header checked → accepted (indexed as it grows) | refused (blocks cleared).
- **Device**: attested → active → removed (cut per space; identity-attested removal overrides).
- **Space on a device**: joined → syncing → held (policy met) | below policy → left (data dropped).

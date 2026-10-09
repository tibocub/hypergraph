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
- Built-in types: `hg/relation { from (link), to (link), rel, value? (float), data? (text ≤ 4 KB), off }`,
  `hg/tag { on (link), tag, off }` (story 5, research.md A9: puts only, `off` undoes; latest wins per
  (from, to, rel) and (on, tag) among who may edit `from` / `on`),
  `hg/grant { recipient (16 B prefix), epoch, commit (8 B), sealed, granter, sig }` (later stories);
  story 3 (research.md A7): `hg/device-remove { removed (device key), cut ([{ log, length }]), proof
  (the identity key's signature over space, device and cut) }`, only in an **identity log** (a log
  whose header is signed by the identity key itself, one per device that removed a device, never cut by
  a removal); in the personal space only: `hg/device { key, name }`, `hg/space { space, name }`,
  `hg/setting { name, value (JSON) }` (index `name`), `hg/heads { heads ([{ space, log, length }]) }`.
  Apps can't write `hg/` types; app rules don't apply to them.

**Validation (the gate, R11)**: header proof valid and identity a member (or allowed by write rules) and
device not removed; seq < cut (the decisions' cut, and for a removed device the lowest of its removals'
cuts: a log a removal doesn't name counts for nothing); decodes; type rules (links' targets, editors;
built-in types only where they belong); app rules; write limit.

### The personal space (research.md A7)

A space whose only member is the identity: an Autobase whose first writer's key pair, and an encryption
key, are derived from the recovery phrase (so its key is too), with Hypercore block encryption on every
log and Autobase's `encryptionKey`. Created with the identity; not listed in `spaces()`; no roles,
moderation or invites. Space channels (all spaces) use the space's discovery key as Protomux id.

### Decision log (an Autobase per space)

Ordered entries; applied deterministically; each valid only if its author held the permission at that
point.

| decision | fields |
|---|---|
| `space/init` | `name, parent?, private, policy, version` |
| `member/add` | `identity` |
| `member/remove` | `identity, cut ([{log, length}])` — research.md A4 |
| `role/define` | `name, permissions[]` (custom roles; never takes 'post' or an app permission away: research.md A5, A9) |
| `role/set` | `identity, role, cut ([{log, length}])` — the cut counts if the role takes 'post' away (all records), and for each app permission it takes away (`editcut:`: edits, relations and tags relying on it; research.md A9) |
| `moderate` | `action (flag\|hide\|remove\|reveal\|ban\|unban), target (record id \| identity), reason, cut ([{log, length}]: bans)` — `unban` lifts `banned:`, the cut stays (research.md A8) |
| `invite/redeem` | spec 008's redemption (`invite/create` is unused: an invite carries its maker's signature) |
| `invite/revoke` | `invite` (the encoded invite: its maker, or who may decide, revokes it) |
| `writer/add` | `key, proof` — a device's claim of its decision-log writer key, signed on its identity's behalf; counts for a member who may decide or moderate, from a device not removed (research.md A8) |
| `device/remove` | `device, cut, proof` — the identity key's signed removal (the same bytes as the `hg/device-remove` record): the device's writer keys go, for good |
| `key/rotate` | `epoch, commit` (private) |
| `subspace/create` | `key, name, private, writeRoles[]` |
| `settings/set` | `policy?, writeLimit? { records, periodMs }, rules?` — story 6: `policy` ('auto' \| 'everything') by who may decide; `writeLimit` unused until story 9; core follow-ups: `rules` (ids of the app rules the space runs, sorted into `meta.rules`; a trailing field, absent from older entries) by who may decide |

**State** (rebuilt by applying the log): members, roles and permissions, custom roles, moderation flags
per record, bans and removals with cuts (`cut:<identity>`: first cut per log wins), invites, redemptions
and revocations, writers and settlers, removed devices, epochs, sub-spaces, settings. A sub-space's
effective state = parent's members, roles, bans, then its own decisions; parent bans always win.

Built-in roles and permissions (as v1): `owner` (all, the app's permissions included), `admin` (decide, moderate, invite, roles below
admin), `moderator` (moderate), `member` (post), `guest` (post in its sub-space). Permission `decide` or
`moderate` makes a member's devices decision-log writers (the first key comes with its invite
redemption, the others by `writer/add`); losing both drops them. **Settlers** (Autobase indexers): one
writer key per member with `decide`, the first; a removed one hands over to another of the same
person; Autobase keeps its last settler, which then counts for nothing here (research.md A8).

View keys (research.md A4–A5, A8): `meta`, `member:<id>` `{ role, by, stamp, writer, writerDevice }`,
`writer:<key>` `{ identity, device, indexer }`, `writers:<id>` `{ keys }`, `gone:<id>:<device>`,
`role:<name>` `{ permissions }`, `cut:<id>` `{ logs: { <log>: length } }`, `editcut:<id>` `{ perms: { <permission>:
{ <log>: length } } }` (research.md A9), `banned:<id>`,
`mod:<record id>` `{ flagged, hidden, removed }`, `redeemed:<invite>:<id>`, `uses:<invite>`,
`revoked:<invite>`. A redemption is `{ invite, identity, writer, proof }`.

### Space channel messages (Protomux `hypergraph/space`, id = the space's discovery key, research.md A7)

`summary { count, digest (32 B XOR) }`, `want {}`, `logs [log key]`, `notice { log }`, `get { log }`
(experiment 1), `redeem { redemption }` (a newcomer's signed invite redemption, research.md A3), `ask
{ decision }` (a `writer/add` or `device/remove` for any writer to record, research.md A8); story 9
adds `period, start` to log entries.

## On the device only (never replicated)

### HyperDB index (`<dir>/index`)

| collection | key | holds |
|---|---|---|
| `records` | `space, id` | type, author, device log, seq, stamp, current fields, links, flags (hidden, removed, superseded, edited, flagged; story 6: `DROPPED` — content dropped here, fields empty, the row stays; `READ` — fetched back by a read) |
| `logs` | `space, log` | identity, device, indexed length, cut, refused? |
| `changes` | `space, target, id` | an edit or delete by its target: kind, type, author, device, stamp, fields, links (research.md A2); also found by its own id (`changes-by-id`, for cuts) |
| `spaces` | `key` | the spaces this instance holds: Corestore namespace, name, parent (not the personal space) |
| `meta` | `name` | declared types (`types`: per type its fields and kinds, links, onePerMember, editable, indexes; compat check and, story 7, which types to index again), identity (proof), `personal` (key, encryption key), `alone` (a new identity, no device added yet), `budget` (the app's, if set), `budget:<space>` (a space's own), `dropped:<space>:<log>` (`{ bytes, blocks, ix }`: content dropped from a log, and, core follow-ups, the bytes its rows' app index entries and tag keys cost: the compact `log` schema can't grow; research.md A10) |

Indexes: `by-type (space, type, stamp)`, `by-author (space, author, stamp)`, `by-link (space, target,
type, stamp)`, `by-ix (space, app key…)` (map over declared `index`, and the record's tags as keys ` #<tag>`: research.md A9), `one-per-member (space, type,
target, author)`, `grants-for (space, recipient prefix, epoch)` (story 8). `records` rows also carry the current version's
`vstamp`/`vdevice` and, for one-per-member types, `opm` + `target`.

### Corestore (`<dir>/cores`)

Device logs (own and others'), decision logs, the personal space's logs. Budget accounting (story 6,
`lib/storage.js`) = stored bytes, estimated: per record held, its content + ~150 B in its log and its
content + ~550 B in the index, plus ~160 B + twice its key per app index entry or tag key; a dropped record keeps only its ~550 B row and its index entries.

### Beside the index (story 6, research.md A10)

- `<dir>/instance.json`: what the index can't be rebuilt from — identity proof, personal space keys,
  `alone`, types, budgets, the spaces held (key, Corestore namespace, name, budget). Rewritten whole,
  atomically, when one changes.
- `<dir>/logs`: append-only, 64 B per entry (space key, log key), one per log accepted in a space: the
  logs to index again when the index is lost.
- `<dir>/index.broken-<time>`: an unreadable index, set aside (never deleted).

## State transitions

- **Record**: written → (gate) indexed → edited (newer allowed edit replaces fields; id unchanged) →
  deleted (hidden, bytes cleared) ; or hidden ↔ revealed ; or removed (moderation, permanent) ; or cut
  (ban / device removal: rows deleted, never re-indexed).
- **Log**: announced → header checked → accepted (indexed as it grows) | refused (blocks cleared).
- **Device**: joined by code (or restored from the phrase) → active → removed (a removal signed by the
  identity key in every space; removals only lower limits, so they never conflict).
- **Space on a device**: joined → syncing → held entirely (`held: 'all'`) | held in part (content dropped
  oldest first to fit its share; `belowPolicy` if the space asks to keep everything) → left (data dropped).
- **A record's content on a device** (story 6): held → dropped (row kept, block cleared, never fetched
  again) → fetched back by a read (`READ`, dropped last) or, in a keep-everything space, once it fits.

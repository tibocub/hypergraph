# Event Encoding

**File**: `src/encodings/event.js`

Events are encoded/decoded using a binary format (compact-encoding) for efficiency, not JSON —
this is the layer that actually travels over the wire inside a Hypercore.

## Event Structure

Fields vary by type, but every event carries at least:

```js
{
  type: 'entity/create' | 'content/append' | 'relation/create' | 'tag/add' | ...,
  author: string,
  timestamp: number,
  ...type-specific fields
}
```

Note: entity ids are NOT stored directly on `entity/create` events — they're derived as
`<entityType>/<authorCoreKeyHex>/<seq>` when the view applies the event (see
`GraphView#applyEntityCreate`).

## Encoding

```js
encodeEvent(event) → Buffer
```

## Decoding

```js
decodeEvent(Buffer) → event
```

User cores store `encodeEvent()` output directly. Context events reach Autobase already
encoded (ContextBase sets no Autobase `valueEncoding`) and are decoded in apply; the bytes in the
oplog are the same either way. Keys inside events (authors, entity ids) are hex text, which
makes events roughly twice the size a binary layout would need — changing that is a wire-format
change (see `specs/research/scaling-study.md`).

## Backward Compatibility for Optional Fields

Several event types have grown optional trailing fields over time (e.g. `relation/create`'s
`value`, `content/append`'s encryption metadata, `roles/addWriter`'s `author`/`timestamp`/
`signature`). These are guarded on decode with `state.start < state.end` checks, so that
events encoded before a given field existed can still be decoded without crashing — the field
is simply left `undefined` for those older events. This has caught a real, reproduced bug
before (round 33: a real deployment crashed with "Out of bounds" the moment an
already-persisted `relation/create` event without a `value` field was replayed against the
newer decoder) — any new optional field added to an existing event type needs this same
guard, not just the encode/preencode sides.

## Supported Event Types

**Entity / content** (UserCore):
- `entity/create` - Create entity
- `entity/tombstone` - Delete entity (tombstone)
- `content/append` - Append content — optionally encrypted (`encrypted`/`scope`/`epoch`/
  `nonce` fields; see [Read Permission](../read-permission.md))
- `identity/update` - Identity profile update (username, bio)

**Context (ContextBase)**:
- `context/init` - The context's own record: topology `version` and app `rules` id. Written
  first by `createContext()`; honoured only from the creator, only once (spec 003). Older peers
  decode it as `{ type: undefined }` and ignore it, which is why mixed versions in one context
  are unsupported
- `relation/create` - Create relation (optional `value` field for weighted relations; optional
  `data` string, at most 4,096 bytes of UTF-8, appended after `value` and signed only when present,
  so relations without data keep their old bytes and signatures — spec 004)
- `relation/delete` - Delete relation
- `tag/add` - Add tag
- `tag/remove` - Remove tag
- `moderation/action` - Record a moderation fact (flag/hide/remove/reveal), signed and
  permission-checked against the attached RoleBase
- `roles/addWriter` / `roles/removeWriter` - Context-level writer changes, signed and
  permission-checked in closed mode
- `message` - Generic messages

**RoleBase**:
- `roles/init` - Initialize the role registry with an owner
- `roles/setRole` - Assign a role to a member
- `roles/removeMember` - Remove a member
- `roles/setRolePermissions` - Define what a role can do
- `roles/addWriter` - Add a writer to the RoleBase itself (distinct from the context-level
  event of the same name above — this one grows the RoleBase's own Autobase writer set)

**ScopeBase** (see [Read Permission](../read-permission.md)):
- `scope/create` - Create a new read-scope
- `scope/keyGrant` - Seal a scope's key (at a given epoch) to a specific recipient's
  `encryptionKeyPair.publicKey`
- `scope/revoke` - Mark a pubkey as no longer a current member (informational only — does not
  undo a grant already received)

## Why there is no `content/ref` event type

External content references — where an entity points at content held outside the graph — add
**no event type and no encoding change at all**. If you came here expecting one, this is why there
isn't one.

A reference is an ordinary `content/append` event. Its `contentType` carries the marker `'link'`
and its `body` carries a JSON address payload. Both fields are already `c.string` in the
`content/append` branch above, so a reserved value costs nothing to encode or decode.

That choice was deliberate, and the alternatives were rejected for concrete reasons:

- **A new `content/ref` event type** would have meant a wire-format change (Principle II's
  non-negotiable test-first tier), a new branch in the Autobase apply path (a correctness risk
  under Principle I), and an instant break for the symlinked consumer repos — all to express
  something the existing primitive already expresses.
- **A marker inside the body, with `contentType` holding the referenced content's real media
  type**, would leave an existing consumer seeing `video/mp4` and treating a JSON body as video
  bytes. Silently wrong, which is strictly worse than visibly unsupported. With the marker on
  `contentType`, an unaware consumer sees a type it does not recognize and safely declines.

The referenced content's real media type is not lost — it lives in the payload's `type` field,
which a consumer needs anyway to decide whether to fetch.

The practical upshot for anyone editing this file: **references are invisible to the encoding
layer**, and should stay that way. If a change here starts needing to know about them, the design
has drifted. See `src/content-ref.js` and `specs/001-external-content-refs/`.

## See Also

- [Index Structure](index-structure.md) - How events are indexed in GraphView
- [Read Permission](../read-permission.md) - Scope events and content encryption in full

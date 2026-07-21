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
- `relation/create` - Create relation (optional `value` field for weighted relations)
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

## See Also

- [Index Structure](index-structure.md) - How events are indexed in GraphView
- [Read Permission](../read-permission.md) - Scope events and content encryption in full

# Event Encoding

**File**: `src/encodings/event.js`

Events are encoded/decoded using a binary format for efficiency.

## Event Structure

```js
{
  type: 'entity/create' | 'content/append' | 'relation/create' | 'tag/add' | ...,
  id: string,
  author: string,
  timestamp: number,
  ...type-specific fields
}
```

## Encoding

```js
encodeEvent(event) → Buffer
```

## Decoding

```js
decodeEvent(Buffer) → event
```

## Supported Event Types

- `entity/create` - Create entity
- `entity/tombstone` - Delete entity (tombstone)
- `content/append` - Append content
- `relation/create` - Create relation
- `relation/delete` - Delete relation
- `tag/add` - Add tag
- `tag/remove` - Remove tag
- `identity/profile` - Identity profile update
- `roles/setRolePermissions` - Set role permissions
- `roles/addMember` - Add member to role
- `roles/removeMember` - Remove member from role

## See Also

- [Index Structure](index-structure.md) - How events are indexed in GraphView

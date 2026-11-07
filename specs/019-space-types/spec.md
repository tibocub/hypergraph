# Feature Specification: A space's own types, added by its deciders

**Feature Branch**: `019-space-types`

**Created**: 2026-11-07

**Status**: Done (see tasks.md).

**Input**: HyperBrowser request B1 (`E:\Code\P2P\HyperBrowser\specs\requests-to-hypergraph.md`, branch
`001-engine`); SwarmFS request F1 builds on it.

Who the "user" is: a developer of an engine holding many apps' spaces (HyperBrowser: one SwarmFS instance serving
many sites), and the site developer whose `site.json` declares the site's record types.

## The problem

Since spec 015 a space records its own types. They come from `createSpace({ types })` or, later, from the opening
app's declaration when a decider's app opens the space. An engine serving many sites opens hypergraph once, with
its own types (SwarmFS's) and none of the sites': it can't declare every site's types at `Hypergraph.open`
(refused as a workaround). So a dynamic site (the official forum: `post`, `comment`, `vote` in the site's space)
can't get its types into an existing space, and writing them throws `INCOMPATIBLE_TYPES`.

A second problem follows: once a space has types its engine's app lacks (a site's), today's at-open recording
refuses to record that app's own later additions (`TYPES_BEHIND`: "declare those too"). An engine updated with a
new SwarmFS field would be behind on every site forever.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A decider adds types to one live space (Priority: P1)

The owner (or an admin) of a site's space, from an engine whose app declares none of the site's types, adds the
site's types to that space from the site's declaration. Records of those types can be written right after, and
every other member reads, checks and indexes them.

**Independent Test**: owner and a member online; the owner adds `post` to the space; the owner posts; the member,
whose app never declared `post`, reads the post.

**Acceptance Scenarios**:

1. **Given** a space without `post`, **When** its owner adds `post`, **Then** the space's types have `post` and the
   types it had before, and a `post` can be written at once.
2. **Given** that, **When** another member (app without `post`) reads the space, **Then** they get the post, with
   its fields.
3. **Given** a member who is not a decider, **When** they add types, **Then** it is refused (`NOT_ALLOWED`) and the
   space's types don't change.
4. **Given** a declaration changing a type the space has (a field retyped, moved or removed, `editable`, `put`,
   `onePerMember` or link targets changed), **When** a decider adds it, **Then** it is refused
   (`INCOMPATIBLE_TYPES`, naming the type and field) and nothing is recorded.
5. **Given** a declaration of a type the space has with fields added at the end, **Then** it is recorded (an
   update of the site's types).
6. **Given** a declaration the space already has, **Then** nothing is recorded (no new version).

### User Story 2 - The engine's own app keeps updating (Priority: P1)

A decider's app opening a space records its own additions (spec 015) even when the space has types that app
doesn't declare (a site's): the space keeps them.

**Acceptance Scenarios**:

1. **Given** a space with SwarmFS's types and a site's `post`, **When** the decider's updated app (a new type of
   its own, no `post`) opens it, **Then** the space has both the new type and `post`.
2. **Given** two admins' apps adding different types (spec 015's case), **Then** each records its own on top of
   the other's; nobody is "behind".

### Edge Cases

- A sub-space: it has its top space's types; adding types to it is refused (`NOT_ALLOWED`, "add them to its top
  space").
- The personal space: refused.
- Two deciders adding at the same moment: the version written second is refused at apply (spec 015); the call
  records again on top of the winner, so it resolves only once its types are in.
- A declaration naming a type `hg/...`, an unknown field kind, a link to a type neither declared nor in the space:
  `INVALID_TYPE`, as `Hypergraph.open` says it.
- A site's declaration linking to a type the space already has (e.g. SwarmFS's `file`): allowed.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A space MUST offer a call (`space.declareTypes(types)`) taking a declaration in `Hypergraph.open`'s
  `types` form, adding it to the space's types: types it doesn't name are kept, types it names replace the
  space's version of them.
- **FR-002**: The result MUST pass the same compatibility check as an app version change (types and fields at the
  end added, indexes added or changed); anything else is refused with `INCOMPATIBLE_TYPES`.
- **FR-003**: Only who may decide in the space (owner, admins, a role with `decide`) MAY call it; others get
  `NOT_ALLOWED`.
- **FR-004**: The addition MUST be recorded in the space (a new types version every member applies), not only on
  the caller's device; the call resolves once this device applied it.
- **FR-005**: No change to what's on the wire or to how decisions apply (no apply-time change): older versions of
  hypergraph that read spec 015's types already apply it.
- **FR-006**: The automatic recording at open (spec 015) MUST add the app's declaration onto the space's types the
  same way (types and fields the app lacks are kept). `TYPES_BEHIND` goes away.
- **FR-007**: A site handle (`hg.scope(key, { identity: 'main' })`) MUST offer the call too.

### Key Entities

- **A space's types**: the `types/set` versions in its decision log (spec 015), latest counting.
- **A declaration**: `{ name: { fields, links, onePerMember, editable, put, index } }`, as `Hypergraph.open` takes.

## Decision: `space.declareTypes(types)`, not `hg.scope(key, { types })`

- A call on the space says what it does and fails where it is called: `NOT_ALLOWED` for a non-decider,
  `INCOMPATIBLE_TYPES` for a breaking change. `scope(key, { types })` would have to record silently when the
  person happens to be a decider and do nothing (or throw while opening a handle) otherwise; a visitor opening a
  site with its `site.json` types would get a handle that only sometimes changed the space.
- Opening a handle is a read; recording types is a decision written to the space. Mixing them makes every open a
  possible write.
- It works with any space handle (a `Space`, a site's scope, SwarmFS's site), so SwarmFS F1's "add types to an
  existing site" is one line over it.
- It reverses spec 015's "no explicit call" (Tibo, 2026-11-02), which assumed one app per space; an engine serving
  many sites' spaces is the case it didn't foresee.

## Success Criteria *(mandatory)*

- **SC-001**: A two-peer test: a decider adds a type to a live space, a second peer accepts records of that type;
  a non-decider and a breaking change are both refused.
- **SC-002**: SwarmFS's `createSite(name, { types })` gives a site its own types, and a call adds types to an
  existing site.
- **SC-003**: The forum scenario tests and hypergraph's, SwarmFS's, HyperBBS's and hyperDNS's suites pass.

## Assumptions

- Removing a type or field stays impossible (types are shared with members on older versions).
- Not a hot path (one decision per change): no perf scenario.

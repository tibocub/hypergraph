# Implementation Plan: A space's own types, added by its deciders

**Branch**: `019-space-types` | **Date**: 2026-11-07 | **Spec**: [spec.md](spec.md)

## Summary

`space.declareTypes(types)` writes spec 015's existing `types/set` decision with the space's current types plus
the given declaration. The automatic recording at open builds its version the same way (the space's types
plus the app's), so an app lacking a space's own types still records its additions. No wire, encoding or
apply change: `types/set` already carries a full declaration, checked at apply with `checkCompatible`.

## Technical Context

- **Language**: CommonJS JavaScript, Node and Bare.
- **Testing**: brittle; `test/next/unit/space-types.js`, forum scenario `test/next/forum/engine.js`.
- **Performance**: one decision per change of types, at open or on a call; not a hot path (no perf scenario).

## Design

- `lib/types.js`: `Types.adding(stored, declarations)` (a space's stored types as declarations, the given
  ones over them; links may point at the space's types); `types.over(stored)` (stored form: a type the app
  declares with at least the space's fields is the app's, any other stays the space's). `adds`/`lacks`
  removed (only `TYPES_BEHIND` used them).
- `lib/space.js`:
  - `declareTypes(types)`: `NOT_ALLOWED` for the personal space, a sub-space and non-deciders
    (`#mayDecide('decide')`); `next = Types.adding(base, types)`, `next.checkCompatible(base)`
    (`INCOMPATIBLE_TYPES`); equal to the space's: nothing; over 32 KB: `INVALID_TYPE` (apply would drop it
    silently); else `types/set` at version + 1. Loops (5 tries) while a concurrent version won the number.
    In `OPENING` (opens a closed space) and in `lib/scope.js` `METHODS`.
  - `#recordTypes()`: only in a space sharing at least one type with the app (else a wiki app owning a forum
    would add its types to the forum: caught by the forum scenario `engine.js`); version = `app.over(recorded)`;
    skipped if equal or incompatible (the conflict is `#checkTypes`'s refusal). `_behind`, `#behindChanged`
    and the `TYPES_BEHIND` warning removed.

## Constitution check

- I (correctness under concurrency): concurrent `types/set` with the same version: apply refuses the
  second (spec 015); both the call and the at-open recording build again on the winner.
- II (test first): tests in `test/next/unit/space-types.js` (call, refusals, two peers, engine update) and
  the reversed `TYPES_BEHIND` test.
- Docs: `docs/next/api.md`, `docs/next/concepts.md`, CHANGELOG.

# /api/workflows — local workflow ("space") storage

## Responsibility
Read/replace the whole set of local workflow spaces ("spaces") — HeliosGen's
multi-workspace document container — persisted in the SQLite DB.

## Design
- `export const runtime = "nodejs"`.
- Whole-collection API (no per-id subroutes): `GET` returns everything,
  `PUT` replaces everything.
- Payload validation: body must be JSON with `spaces: GuestSpace[]`
  (invalid JSON → 400 `invalid JSON`; non-array → 400 `spaces[] required`).
- No user scoping — spaces are a single host-level collection (`lib/guest/spaces.ts`).

## Flow
- `GET` → `{ spaces: getSpaces() }`.
- `PUT` → parse/validate → `saveSpaces(body.spaces)` → `{ ok: true }`.

## Integration
- **Store**: `lib/guest/spaces.ts` (`getSpaces`, `saveSpaces`, type `GuestSpace`)
  backed by the local SQLite DB.
- **Consumers**: frontend workflow/space switcher; called as full-document save.

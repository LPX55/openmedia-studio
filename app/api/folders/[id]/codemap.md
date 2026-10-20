# /api/folders/[id] — folder update & delete

## Responsibility
Mutates a single folder: rename, reparent, reorder, recolor (`PATCH`) or remove
it (`DELETE`).

## Design
- Dynamic segment is a Promise-based param (Next App Router):
  `{ params }: { params: Promise<{ id: string }> }` → `await params`.
- `PATCH` body is a sparse patch — only provided keys are applied:
  `{ name?, parentId?, orderIndex?, color? }`. `parentId`/`color` accept
  `null` to clear; the mapping camelCase → snake_case happens inline
  (`parentId` → `parent_id`, `orderIndex` → `order_index`).
- `DELETE` takes no body.
- Both are guest-scoped (`updateFolder`/`deleteFolder` take `GUEST_USER_ID`),
  which doubles as ownership enforcement — a foreign id is a no-op.
- No validation of body shape beyond presence of keys; no 404 on missing id
  (returns `{ ok: true }` regardless).

## Flow
1. `await params` → `id`.
2. PATCH: build partial update object → `guestDb.updateFolder(id, uid, patch)`.
   DELETE: `guestDb.deleteFolder(id, uid)`.
3. Return `{ ok: true }`.

## Integration
- **Store**: `lib/guest/db.ts:updateFolder` / `deleteFolder` (SQLite `folders`;
  delete cascades folder items per the DB layer).
- **Request/Response**: `PATCH { name?, parentId?, orderIndex?, color? } → { ok }`;
  `DELETE → { ok }`.

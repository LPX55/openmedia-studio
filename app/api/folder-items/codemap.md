# /api/folder-items — folder membership add/remove

## Responsibility
Adds or removes item ids (generation/upload records) from a folder — the
join-table CRUD behind drag-and-drop organization in the gallery.

## Design
- Same body shape for both verbs: `{ folderId: string, itemIds: string[] }`,
  validated identically (400 `Missing folderId or itemIds` when either is absent
  or `itemIds` isn't an array).
- Bulk: all ids are written/deleted in one call.
- Guest-scoped: `GUEST_USER_ID` passed to the DB helpers.
- Idempotent by construction (insert-or-ignore / delete-if-exists in the DB layer).

## Flow
- `POST` → `guestDb.insertFolderItems(folderId, itemIds, GUEST_USER_ID)` → `{ ok: true }`.
- `DELETE` → `guestDb.deleteFolderItems(folderId, itemIds, GUEST_USER_ID)` → `{ ok: true }`.

## Integration
- **Store**: `lib/guest/db.ts:insertFolderItems` / `deleteFolderItems`
  → SQLite `folder_items` (references `folders.id` + generation/upload ids).
- **Related**: `/api/folders` (reads `folderItems` for the initial payload).
- **Response**: `{ ok: true }`.

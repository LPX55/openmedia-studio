# /api/folders — folder list & create

## Responsibility
Lists all folders with their item memberships, and creates a new folder.

## Design
- Guest-scoped: every call passes `GUEST_USER_ID` (`lib/guestMode.ts`).
- `GET` takes no params and returns both collections in one payload so the
  client can build the tree without a second round trip.
- `POST` body `{ name, parentId? (null), orderIndex? (0) }`; `name` required
  (400 `Missing name`). Id is generated server-side via `randomUUID()`.

## Flow
- `GET` → `{ folders: getFolders(uid), folderItems: getFolderItems(uid) }`.
- `POST` → `insertFolder({ id, user_id, name, parent_id, order_index })` → `{ folder }`.

## Integration
- **Store**: `lib/guest/db.ts` (`getFolders`, `getFolderItems`, `insertFolder`)
  → SQLite tables `folders` / `folder_items`.
- **Related**: `/api/folders/[id]` (update/delete), `/api/folder-items` (membership),
  `/api/gallery` (items being organized).
- **Response shapes**: `GET { folders, folderItems }`; `POST { folder }`.

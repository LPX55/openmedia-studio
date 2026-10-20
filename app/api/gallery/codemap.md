# /api/gallery — paginated media list & delete

## Responsibility
Serves a merged, newest-first, paginated feed of the guest's media — generations
and uploads combined — and deletes a single item from either source.

## Design
- `GET` query: `type=image|video` (default `image`), `page` (≥0, default 0),
  `source=generation|upload` (optional filter). Page size fixed `LIMIT = 20`.
- Merging: when no `source` filter, both lists are concatenated, **deduped by URL**
  (an upload that is also a generation payload collapses to one entry), then
  sorted by `created_at` desc, then sliced → offset = `page * LIMIT`.
- Normalization to a common `Item` shape: generations expose
  `prompt/model/aspect_ratio/quality/azure_resolution/referenceImageUrls`
  (video rows use `video_url`, image rows `image_url` + optional `image_urls`);
  uploads only expose `url` (`r2_url`), `mediaType` (from `mime_type` prefix),
  `source: "upload"`.
- `DELETE` body `{ id, source: "generation" | "upload" }` (400 if either missing)
  routes to the matching delete helper, both scoped to `GUEST_USER_ID`.

## Flow
1. Read filters → fetch `getGenerations(uid, type)` and/or `getUploads(uid, type)`.
2. Map → merge/dedupe → sort → slice.
3. Return `{ items, hasMore, total }` (`hasMore = total > offset + LIMIT`).

## Integration
- **Store**: `lib/guest/db.ts` — `getGenerations`, `getUploads`,
  `deleteGeneration`, `deleteUpload` (SQLite `generations` / `uploads`).
- **Related**: `/api/folders*` for organization; upload routes feed `uploads`,
  `/api/generate*` feed `generations`.
- **Response**: `GET { items[], hasMore, total }`; `DELETE { ok: true }`.

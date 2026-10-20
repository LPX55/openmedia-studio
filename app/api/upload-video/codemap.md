# /api/upload-video — raw-binary video upload

## Responsibility
Video-only raw-binary upload: rejects non-video MIME types, caps at 100 MB,
stores to the `references` folder and records the upload.

## Design
- `POST` body = raw file bytes; `Content-Type` must start with `video/`
  (default assumed `video/mp4`, anything else → 400 `Only video files are accepted`).
- `maxDuration = 60`; 100 MB limit checked on both `content-length` (413 early)
  and actual buffer length (413) — bypasses Next multipart parsing issues.
- Always stores under `references/` regardless of MIME subtype.

## Flow
1. Validate MIME + size.
2. `uploadBuffer(buffer, mimeType, "references")` → `cdnUrl`.
3. `guestDb.insertUpload({ user_id: GUEST_USER_ID, r2_url, mime_type, source: "user_upload" })`.
4. Return `{ cdnUrl }`; errors → 500 `{ error }`.

## Integration
- **Storage**: `uploadBuffer` (`lib/storage.ts`, local disk, dedupe inside).
- **DB**: `guestDb.insertUpload` (`lib/guest/db.ts`).
- **Related**: `/api/upload-asset` (mixed image+video), `/api/fetch-url` (remote URL variant).

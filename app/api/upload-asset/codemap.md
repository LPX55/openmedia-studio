# /api/upload-asset — unified raw-binary upload

## Responsibility
Single raw-binary upload endpoint for images *and* videos (avoids multipart
parsing), with size cap, content-hash dedupe, DB record, and stored URL response.

## Design
- `POST` with the file bytes as the body; `Content-Type` is the file's MIME
  (defaults `application/octet-stream`). No multipart/form-data.
- `maxDuration = 60`; `MAX_BYTES = 100 MB`, enforced twice (pre-check on
  `content-length` and post-read on buffer length → 413).
- Folder selection by MIME: `video/*` → `references`, else `uploads`.
- Dedupe is delegated to `uploadBuffer` (SHA-256 index in the SQLite DB) — the
  route just records and returns.

## Flow
1. Read MIME + enforce size.
2. `uploadBuffer(buffer, mimeType, folder)` → `cdnUrl`.
3. `guestDb.insertUpload({ user_id: GUEST_USER_ID, r2_url, mime_type, source: "user_upload" })`.
4. Return `{ cdnUrl }` (500 `{ error }` on failure).

## Integration
- **Storage**: `uploadBuffer` (`lib/storage.ts` → `lib/guest/localStorage.ts`,
  local `MEDIA_DIR`, `/generated/...` origin).
- **DB**: `guestDb.insertUpload`; hash index also feeds `/api/lookup-asset`.
- **Clients**: precede with `GET /api/lookup-asset?hash=` to skip redundant uploads.

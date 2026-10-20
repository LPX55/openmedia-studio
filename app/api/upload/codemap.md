# /api/upload — data-URL / remote-URL upload

## Responsibility
Accepts either a base64 `data:` URL or a remote `http(s)` URL, mirrors it into
local storage, records the upload, and returns the stored URL.

## Design
- `POST` body `{ dataUrl, folder? ("uploads"), mimeType? }`.
- `data:` → `uploadDataUrl(dataUrl, folder)`; `http…` → `mirrorToStorage(url, folder)`;
  anything else → 400 `dataUrl must be a data: or http: URL`.
- Records a `uploads` row with `source: "user_upload"` for the gallery even when
  `mimeType` is unknown (stored as `null`).
- Catch-all → 500 `{ error: message }`.

## Flow
1. Validate `dataUrl` present.
2. Store to disk (SHA-256 dedupe happens inside the storage layer).
3. `guestDb.insertUpload({ user_id: GUEST_USER_ID, r2_url, mime_type, source })`.
4. Return `{ cdnUrl }`.

## Integration
- **Storage**: `uploadDataUrl`, `mirrorToStorage` (`lib/storage.ts` →
  `lib/guest/localStorage.ts`, writes under `MEDIA_DIR`, served at `/generated/...`).
- **DB**: `guestDb.insertUpload` (`lib/guest/db.ts`), user `GUEST_USER_ID`.
- **Response**: `{ cdnUrl: string }`.

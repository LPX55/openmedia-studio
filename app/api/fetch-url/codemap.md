# /api/fetch-url — server-side fetch of remote media

## Responsibility
Downloads a remote image/video URL server-side and stores it locally, so CORS or
hotlink protection on the origin never blocks ingest.

## Design
- `POST` body `{ url }`; must parse as `http:`/`https:` (400 otherwise).
- `maxDuration = 60`; `MAX_BYTES = 50 MB` (413 when exceeded).
- Fetch with spoofed `User-Agent` (`Mozilla/5.0 (compatible; OpenMediaStudio/1.0)`) and
  `redirect: "follow"`; upstream non-OK → 400 with status text.
- Media type decided by upstream `Content-Type` prefix — only `image/*` and
  `video/*` accepted (400 otherwise).
- Folder by type: video → `references`, image → `uploads`.

## Flow
1. Validate URL → fetch → check content type + size.
2. `uploadBuffer(buffer, mimeType, folder)` → `cdnUrl`.
3. `guestDb.insertUpload({ ..., source: "user_upload" })` so it shows in the
   gallery "uploaded" section.
4. Return `{ cdnUrl, mediaType: "image" | "video" }`.

## Integration
- **Upstream**: arbitrary `http(s)` origin (GET).
- **Storage**: `uploadBuffer` (local `MEDIA_DIR`, SHA-256 dedupe).
- **DB**: `guestDb.insertUpload`.
- **Response**: `{ cdnUrl, mediaType }`.

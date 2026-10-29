# /api/fetch-url — server-side fetch of remote media

## Responsibility
Downloads a remote image/video URL server-side and stores it locally, so CORS or
hotlink protection on the origin never blocks ingest.

## Design
- `POST` body `{ url }`; must parse as `http:`/`https:` (400 otherwise).
- `maxDuration = 60`; `MAX_BYTES = 50 MB` (413 when exceeded).
- Fetch with a spoofed `User-Agent` (`Mozilla/5.0 (compatible; OpenMediaStudio/1.0)`)
  and `redirect: "follow"`; upstream non-OK → 400 with status text.
- Media type decided by the upstream `Content-Type` prefix — only `image/*` and
  `video/*` accepted (400 otherwise); the `; charset=…` suffix is stripped.
- Folder by type: video → `references`, image → `uploads`.
- The buffer is read fully before the size check (a streaming cap is not
  enforced — the 50 MB limit is post-download).

## Flow
1. Validate URL → fetch → check content type + size.
2. `uploadBuffer(buffer, mimeType, folder)` → `cdnUrl` (SHA-256 dedupe in
   `lib/guest/localStorage.ts`).
3. `guestDb.insertUpload({ ..., source: "user_upload" })` so it shows in the
   gallery "uploaded" section.
4. Return `{ cdnUrl, mediaType: "image" | "video" }`.

## Integration
- **Upstream**: arbitrary `http(s)` origin (GET).
- **Storage**: `uploadBuffer` (`lib/storage.ts` → local `MEDIA_DIR`).
- **DB**: `guestDb.insertUpload` (guest-scoped via `GUEST_USER_ID`).
- **Response**: `{ cdnUrl, mediaType }`, or `{ error }` (400 / 413 / 500).

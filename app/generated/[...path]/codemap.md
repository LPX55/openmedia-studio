# app/generated/[...path]/codemap.md

Covers `app/generated/[...path]/route.ts`.

## Responsibility
`GET /generated/<folder>/<file>` — Node.js runtime route handler that streams guest-mode media (images/videos) from disk. In web/dev, `public/generated/` is served by Next's static handler first so this route is a no-op; in the packaged desktop app, bytes live in a per-user app-data `MEDIA_DIR` outside `public/`, and this fallback serves them.

## Design
- Pure Node route (`export const runtime = "nodejs"`), single `GET` export; params arrive as `Promise<{ path: string[] }>` (App Router async params, awaited).
- Static `CONTENT_TYPES` map keyed by lowercase extension (`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.mp4`, `.webm`) → MIME string; fallback `application/octet-stream`.
- Path-traversal defense, two layers: (1) `normalize(segments.join("/"))` must not start with `..` and contain no `\0`; (2) joined `join(MEDIA_DIR, rel)` must still `startsWith(normalize(MEDIA_DIR))` and `existsSync` — otherwise 403 / 404 `NextResponse`.
- Streaming: `createReadStream(filePath)` → `Readable.toWeb(...)` cast to `ReadableStream` → `new NextResponse(stream, { headers })`.
- Caching: `Cache-Control: public, max-age=31536000, immutable` plus correct `Content-Type`/`Content-Length` (from `statSync().size`).

## Flow
1. Request hits `/generated/<seg…>` → `GET(_req, { params })`.
2. Await `params.path` segments → join + normalize → traversal check (403 if `..`/NUL).
3. `join(MEDIA_DIR, rel)` → containment + existence check (404 if outside/missing).
4. `statSync` for size → extension → MIME lookup → `createReadStream` → `Readable.toWeb` → `NextResponse` with immutable cache headers.
5. Stream consumed by client `<img>`/`<video>` (or Next image optimizer bypass) in gallery/canvas nodes.

## Integration
- Depends on: `next/server` (`NextRequest`/`NextResponse`), Node `fs`/`path`/`stream`, `@/lib/guest/paths` (`MEDIA_DIR` — the per-user media root, desktop-packaging-specific).
- Consumed by: any component that renders guest-generated media via `/generated/...` URLs (gallery items, workflow node outputs, video players). In web/dev mode, effectively shadowed by Next static serving of `public/generated/`.
- Sibling: `app/generated/codemap.md` (directory note only).

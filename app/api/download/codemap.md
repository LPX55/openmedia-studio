# /api/download — attachment download proxy

## Responsibility
Fetches an asset server-side and replays it with
`Content-Disposition: attachment` so browsers save it to disk instead of
navigating to it. Restricted to an allow-list to avoid becoming an open proxy.

## Design
- `GET /api/download?url=<encoded>&filename=<name>` (default filename `download`).
- `export const runtime = "edge"`.
- **Allow-list** (`ALLOWED_ORIGINS`): `cdn.kie.ai`, `api.kie.ai`,
  `replicate.delivery`, `pbxt.replicate.delivery`, plus root-relative
  `/generated/...` (local disk, same-origin).
- SSRF guard: relative `/generated/...` URLs are resolved against the request
  origin and re-checked — `/generated/../api/...` traversal is rejected (403)
  before the fetch, otherwise the proxy would fetch same-origin internal routes.
- Streams the upstream body through with upstream `Content-Type`,
  `Cache-Control: no-store`.

## Flow
1. Missing `url` → 400; not allow-listed → 403.
2. Normalize/re-check local paths.
3. `fetch(fetchUrl)`; network failure → 502, upstream non-OK → same status.
4. Return 200 with `Content-Disposition: attachment; filename="<filename>"`.

## Integration
- **Upstream**: kie.ai CDN/API, replicate.delivery, and local `/generated/*`
  (`app/generated/[...path]` route).
- **Clients**: gallery/detail "Download" buttons.
- No stores touched.

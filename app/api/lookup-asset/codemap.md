# /api/lookup-asset — hash-based upload dedupe

## Responsibility
Answers "is this asset already stored?" so clients can skip sending large payloads.

## Design
- `GET /api/lookup-asset?hash=<sha256hex>`.
- Input must match `/^[0-9a-f]{64}$/i`; anything else (missing/invalid) degrades
  to `{ cdnUrl: null }` — never an error status, so callers can treat null as "upload needed".
- Pure read; no auth, no side effects.

## Flow
1. Read `hash` query param, validate shape.
2. `lookupAssetHash(hash)` → stored URL or null.
3. Return `{ cdnUrl: string | null }`.

## Integration
- **Cache**: `lookupAssetHash` (`lib/assetCache.ts`) → hash index in the SQLite DB
  (`lib/guest/db.ts:lookupAssetHash`), populated by `uploadBuffer`.
- **Callers**: client hashes the file before `POST /api/upload-asset` /
  `/api/upload-video`; on a hit, reuse the returned URL directly.

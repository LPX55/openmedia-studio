# lib/guest/

Server-only persistence layer for guest (local-only desktop / single-user) mode.
The app has no auth and one implicit user; every API route keys its data by
`GUEST_USER_ID` (`lib/guestMode.ts`). Never imported by client components.

## Responsibility

- **`paths.ts`** — writable roots: `DATA_DIR` (SQLite DB, JSON job stores) and
  `MEDIA_DIR` (stored images/videos). Default to `data/` and `public/generated/`
  in the repo; the Tauri shell overrides them to per-user app-data dirs via
  `HELIOS_DATA_DIR` / `HELIOS_MEDIA_DIR` (install dir is read-only). Media URLs
  stay `/generated/<folder>/<file>` regardless — `app/generated/[...path]/route.ts`
  resolves them against `MEDIA_DIR`.
- **`sqlite.ts`** — the database: `node:sqlite` `DatabaseSync` singleton at
  `${DATA_DIR}/guest.db` (WAL, FK on), schema creation, and a one-time,
  mtime-marker-gated import of legacy `guest-db.json` / `guest-spaces.json`, and
  the idempotent seeding of the code-defined `param_presets` rows (the base
  layer of a compat binding's request params — compat-plan §c).
  Server-only; hosted/Vercel never loads it.
- **`db.ts`** — data-access facade over `sqlite.ts` (same API as the old JSON
  implementation, so callers didn't churn): generations, uploads, asset-cache
  hash index, settings (kie/azure API keys, with env fallback), folders and
  folder_items.
- **`spaces.ts`** — workflow-space persistence: `getSpaces()` /
  `saveSpaces()` (full replace in one transaction) into the `spaces` table
  (whole space serialized as JSON in `data`).
- **`localStorage.ts`** — misleading name: this is the **local-disk media
  store** that replaced R2. `uploadBuffer` / `uploadDataUrl` / `mirrorToStorage`
  / `ensureStorage` write bytes under `MEDIA_DIR`, dedupe by SHA-256 via the
  `asset_cache` table, and strip metadata first (`lib/mediaMetadata.ts`).

## Design

- **Facade, not framework**: `db.ts` exports plain sync functions returning
  row-shaped objects (`Generation`, `Upload`, `FolderRecord`, …) with JSON
  columns (`reference_image_urls`, `image_urls`) parsed on read. No ORM.
- **Single lazy singleton**: `db()` opens once, `PRAGMA journal_mode=WAL`,
  runs `CREATE TABLE IF NOT EXISTS` (idempotent schema = migration), then the
  JSON import. Every module calls `db()`; no connection pooling.
- **Idempotent legacy import**: `migrateFromJson` compares file `mtimeMs`
  against a marker row in `settings` (`_import_guest_db`,
  `_import_guest_spaces`); `ON CONFLICT DO NOTHING` inserts make re-running the
  importer / relaunching safe (merges instead of duplicating).
- **Idempotent preset seeding**: `param_presets` (preset_id / family /
  params_json / updated_at) holds the four code-seeded param presets. The seed
  runs on every schema init; `ON CONFLICT(preset_id) DO NOTHING` keeps
  re-opening duplicate-free, and every seed's params JSON is parsed + shape-
  validated BEFORE it is written (a typo aborts the boot loudly).
- **Content-addressed media**: `uploadBuffer` → `stripMetadata` → SHA-256 →
  `lookupAssetHash` hit returns the existing `/generated/...` URL; miss writes a
  fresh UUID filename and upserts `asset_cache`. Duplicate bytes never occupy
  disk twice. Extension derived from content-type; fetches follow up to 5
  redirects.
- **Optimistic-vs-authoritative shapes**: `spaces.saveSpaces` deletes rows not
  in the payload (whole-set replace), while `db` folder ops are per-row
  upserts/deletes — matching the client `folderStore` optimistic-update model.
- **Transactions** used only where multi-statement consistency matters
  (`saveSpaces` upsert+delete, `deleteFolder` cascade, JSON import batches).

## Flow

- **Boot**: any route touches `db()` → mkdir `DATA_DIR` → open `guest.db` →
  schema → one-time JSON import (if legacy files newer than marker) → cached
  singleton for the process lifetime.
- **Job result settle** (from `lib/kieJobPoller.ts` or the callback route):
  `db.updateGeneration(taskId, {status, image_url, image_urls, video_url,
  error_msg})` — keyed by `task_id`, written alongside `jobStore` and the
  `job:<taskId>` event; `recoverJob(taskId)` reads it back when the SSE route
  outlives a restart.
- **Upload/generate**: route → `storage.uploadBuffer|mirrorToStorage|ensureStorage`
  → dedupe check (`lookupAssetHash`) → disk write + `storeAssetHash` → route
  stores the returned local URL on the generation/upload row.
- **Workflow sync**: `PUT /api/workflows` → `saveSpaces(whole set)` in one
  transaction; `GET` → `getSpaces()` (ordered by `updated_at ASC`) → client
  `loadSpacesFromDB` merges by recency.
- **Settings**: `get/set/delete{Kie,Azure}ApiToken` fall back to
  `KIE_API_KEY` / `AZURE_API_KEY` env vars when no DB value exists — consumed by
  `lib/getKieToken.ts`, `lib/getAzureKey.ts`, and the generate routes.

## Integration

- **Consumers (API routes)**: `app/api/generate`, `generate-video`
  (insert/update generations, read keys), `job-stream`/`job-status`
  (`recoverJob`, `resumeKieJob` key read), `workflows` (`guest/spaces`),
  `folders`, `folders/[id]`, `folder-items`, `gallery`, `upload`,
  `upload-video`, `upload-asset`, `fetch-url` (uploads + asset cache),
  `settings/kie-key`, `settings/azure-key`.
- **Sibling `lib/` modules built on it**: `jobStore`/`codexLoginStore` (files
  in `paths.DATA_DIR`), `kieJobPoller` (writes generations + reads kie key),
  `storage`/`assetCache` (media + hash index), `getKieToken`/`getAzureKey`.
- **Storage shape**: one SQLite file (`guest.db`) + media tree
  (`MEDIA_DIR/{images,videos,...}`), both gitignored in dev; overridden to
  per-user app-data dirs in the packaged Tauri desktop app. Legacy
  `guest-db.json` / `guest-spaces.json` are read once and left in place.
- **External**: none directly — external calls (kie.ai, Azure) happen in
  `app/api/*` and `lib/kieJobPoller.ts`, which read keys from here.

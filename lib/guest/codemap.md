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
  `${DATA_DIR}/guest.db` (WAL, FK on), schema creation, idempotent column
  migrations, and the boot-time migrations. Tables: `generations`, `uploads`,
  `asset_cache`, `settings`, `folders`, `folder_items`, `spaces`,
  `provider_configs`, `model_bindings`, `param_presets`.
  - `generations` gains `provider_id`, `provider_meta` (C3 pinned JSON) and
    `job_log` (per-job trail) through `PRAGMA table_info`-guarded `ALTER`s —
    fresh and existing DBs take the same path.
  - `migrateFromJson` — one-time, mtime-marker-gated import of legacy
    `guest-db.json` / `guest-spaces.json`; skips plaintext legacy provider keys.
  - `migrateLegacyProviderSettings` — one-shot copy of `settings.kie_api_token`
    / `settings.azure_api_key` into `provider_configs`, guarded by
    `settings.provider_configs_migrated = 'v1'`; deletes the legacy rows and
    writes the marker in the same transaction (a key deleted later never
    resurrects).
  - `seedParamPresets` — seeds the code-defined `param_presets` rows
    (`PARAM_PRESET_SEEDS` from `lib/providers/presets.ts`); `ON CONFLICT DO
    UPDATE` so a corrected seed reaches existing installs, and each params JSON
    is parsed + shape-validated BEFORE writing (a bad seed aborts boot).
  Server-only; hosted/Vercel never loads it.
- **`db.ts`** — data-access facade over `sqlite.ts` (same API as the old JSON
  implementation, so callers didn't churn): generations, uploads, asset-cache
  hash index, folders/folder_items, provider credentials + runtime resolution,
  param presets, model bindings, and the BYOK chat credential.
- **`spaces.ts`** — workflow-space persistence: `getSpaces()` /
  `saveSpaces()` (full replace in one transaction) into the `spaces` table
  (whole space serialized as JSON in `data`).
- **`localStorage.ts`** — misleading name: this is the **local-disk media
  store** that replaced R2. `uploadBuffer` / `uploadDataUrl` / `mirrorToStorage`
  / `ensureStorage` write bytes under `MEDIA_DIR`, dedupe by SHA-256 via the
  `asset_cache` table, and strip metadata first (`lib/mediaMetadata.ts`).

## Design

- **Facade, not framework**: `db.ts` exports plain sync functions returning
  row-shaped objects (`Generation`, `Upload`, `FolderRecord`, `ProviderConfig`,
  `ParamPreset`, …) with JSON columns (`reference_image_urls`, `image_urls`,
  `provider_meta`, `binding_json`, `extra_json`) parsed on read. No ORM.
- **Single lazy singleton, fail-safe boot**: `db()` opens once, sets
  `PRAGMA journal_mode=WAL` / `foreign_keys=ON`, runs idempotent DDL + the
  `generations` ALTERs, seeds presets, then both boot migrations. `_db` is
  memoized only AFTER the migrations succeed — a throw closes the handle and
  the next call retries from a clean connection instead of poisoning the
  process with a half-migrated DB.
- **Idempotent legacy import**: `migrateFromJson` compares file `mtimeMs`
  against a marker row in `settings` (`_import_guest_db`,
  `_import_guest_spaces`); `ON CONFLICT DO NOTHING` inserts make re-running the
  importer / relaunching safe (merges instead of duplicating). The JSON import
  runs in a transaction and rolls back on a mid-import throw, so a failed
  import can never leave an open transaction that breaks the provider
  migration.
- **Code-seeded presets are authoritative (v1)**: `param_presets` (preset_id /
  family / params_json / updated_at) holds the four seeded presets — the base
  layer of a compat binding's request params (`preset ← binding.paramMap ←
  custom overrides`). v1 has no preset editor, so the seed upserts; a future
  editor must switch to "update only user-untouched rows".
- **One provider-config table**: `provider_configs` (provider_id / api_key /
  base_url / extra_json) is the only credential store; `extra_json` carries
  `deployments`, `presetId`, and the Assistant `chatPreset`/`chatModel`.
  `getProviderRuntimeConfig()` resolves DB first, then env fallbacks (per
  provider: `KIE_API_KEY ?? KIE_API_TOKEN`, `AZURE_API_KEY`, `OPENROUTER_API_KEY`,
  `POLLINATIONS_API_KEY`, `CHAT_API_KEY`, …), rejecting the historical
  `your_kie_api_key_here` placeholder, and reports `keySource`
  (`db | env | cli | none`; `codex` = `cli` iff `~/.codex/auth.json` exists).
- **One model-binding table (C6)**: `model_bindings` (model_id, provider_id,
  binding_json, is_active, is_custom) holds BOTH the active-provider preference
  and user-defined custom bindings. `setModelActiveProvider` clears sibling
  active flags and sets the new one in one transaction; `getModelBindingRows`
  hands raw rows to the server registry (which performs no queries itself).
- **Content-addressed media**: `uploadBuffer` → `stripMetadata` → SHA-256 →
  `lookupAssetHash` hit returns the existing `/generated/...` URL; miss writes a
  fresh UUID filename and upserts `asset_cache`. Duplicate bytes never occupy
  disk twice. Extension derived from content-type; fetches follow up to 5
  redirects.
- **Optimistic-vs-authoritative shapes**: `spaces.saveSpaces` deletes rows not
  in the payload (whole-set replace), while `db` folder ops are per-row
  upserts/deletes — matching the client `folderStore` optimistic-update model.
- **Transactions** used only where multi-statement consistency matters
  (`saveSpaces` upsert+delete, `deleteFolder` cascade, JSON import batches,
  provider-key migration, preset seeding, `setModelActiveProvider`).

## Flow

- **Boot**: any route touches `db()` → mkdir `DATA_DIR` → open `guest.db` →
  WAL/FK → schema DDL → `generations` column ALTERs → preset seed → JSON import
  → legacy provider-key migration → cached singleton for the process lifetime
  (on any throw: close + retry next call).
- **Job submit/settle** (from `lib/jobManager.ts`): `submitJob` calls
  `getProviderRuntimeConfig(providerId)`, `insertGeneration({ …, provider_id })`
  before the upstream call, then persists `provider_meta` on async acceptance;
  `settleJob` calls `updateGeneration(taskId, { status, image_url(s) /
  video_url, error_msg, job_log })` — keyed by `task_id`, written alongside
  `jobStore` and the `job:<taskId>` event. `recoverJob(taskId)` reads the row
  (including `provider_meta`, `provider_id`, `job_log`) back when the SSE route
  or `/api/jobs/[taskId]/log` outlives a restart.
- **Provider readiness / settings**: `GET /api/settings/providers` composes
  `getProviderRuntimeConfig` per provider (never returning raw env lists) with
  `getModelPrefs`, `getCustomModelBindings`, `getModelBindingsByModel` and
  `getParamPresets`; `PUT` writes keys/base URLs/deployments/presets/bindings
  through the `set*` helpers.
- **Model resolution**: generate controllers read
  `getModelBindingRows(modelId)` → `registry.resolveForModel(modelId,
  providerId?, rows)`; an absent active row means the C1 `kie` default.
- **Chat BYOK**: `getChatCredential()` returns `{ apiKey, baseUrl, model,
  preset }` from the `chat` provider row with `CHAT_API_KEY` / `CHAT_BASE_URL` /
  `CHAT_MODEL` env fallbacks.
- **Upload/generate**: route → `storage.uploadBuffer|mirrorToStorage|ensureStorage`
  → dedupe check (`lookupAssetHash`) → disk write + `storeAssetHash` → route
  stores the returned local URL on the generation/upload row.
- **Workflow sync**: `PUT /api/workflows` → `saveSpaces(whole set)` in one
  transaction; `GET` → `getSpaces()` (ordered by `updated_at ASC`) → client
  `loadSpacesFromDB` merges by recency.
- **Legacy key wrappers**: `get/set/delete{Kie,Azure}ApiToken` delegate to
  `provider_configs`, so the legacy `settings` rows are never re-created after
  the one-shot migration.

## Integration

- **Consumers (API routes)**: `app/api/generate`, `generate-video` (via
  `jobManager`: runtime config, `insertGeneration`, `getModelBindingRows`),
  `job-status`/`job-stream` (`recoverJob`), `jobs/[taskId]/log` (`recoverJob`
  `job_log` fallback), `workflows` (`guest/spaces`), `folders`, `folders/[id]`,
  `folder-items`, `gallery`, `upload`, `upload-video`, `upload-asset`,
  `fetch-url` (uploads + asset cache), `settings/providers` (configs, bindings,
  presets), `settings/kie-key`, `settings/azure-key`, `assistant`
  (`getChatCredential`).
- **Sibling `lib/` modules built on it**: `jobManager` (generations + runtime
  config), `jobStore`/`codexLoginStore` (files in `paths.DATA_DIR`),
  `providers/bootstrap` + `providers/registry` (bindings rows, presets),
  `storage`/`assetCache` (media + hash index), `getKieToken`/`getAzureKey`.
- **Storage shape**: one SQLite file (`guest.db`) + media tree
  (`MEDIA_DIR/{images,videos,...}`), both gitignored in dev; overridden to
  per-user app-data dirs in the packaged Tauri desktop app. Legacy
  `guest-db.json` / `guest-spaces.json` are read once and left in place.
- **External**: none directly — external calls (kie.ai, Azure, OpenRouter,
  Pollinations) happen in `app/api/*` and the provider adapters, which read
  keys from here.

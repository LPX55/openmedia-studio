# /api/generate — image generation dispatch

## Responsibility
Single entry point for image generation. Routes a request to one of three backends:
Azure Foundry (`gpt-image-2`-style deployments), the local `codex-imagegen` CLI, or
kie.ai's task API — then returns a `taskId` for async polling.

## Design
- `POST` body: `{ model?, prompt, imageUrls?, aspectRatio?, quality?, azureQuality?,
  azureResolution?, azureBaseUrl?, azureDeployment?, azureCustomWidth?,
  azureCustomHeight?, codexProvider?, debugOnly? }`.
- Model catalog from `lib/modelConfig.ts` (`IMAGE_MODELS`) supplies `apiId`,
  prompt length caps, Azure size maps / api-version, `maxImages`, dual-mode
  `textOnlyApiId`.
- `debugOnly: true` short-circuits: logs the payload, returns `{ ok: true }`.
- Branch order: Azure (`azureBaseUrl && azureDeployment`) → Codex (`codexProvider`)
  → Kie (default). All non-Kie work runs in a detached async IIFE so the route
  responds immediately with `taskId`.
- Custom HTTP helpers avoid Next's patched `fetch` (tied to the request
  AbortSignal): `httpsPost` (raw `node:https`, 1000 s timeout, no-Delay/keep-alive),
  `curlMultipartPost` (spawns `curl` for Azure multipart edits, retries on SSL exit 35),
  `fetchBuffer` (manual redirect-following; reads `/generated/...` straight off
  `MEDIA_DIR` with `..`/NUL traversal guards).
- `resolveImages()` mirrors up to 14 reference URLs to local storage via
  `ensureR2` — failures are non-fatal.
- `runCodexImagegen()` writes refs to temp files, spawns
  `codex-imagegen generate|edit --prompt --size --out`, reads the PNG back;
  `cleanCodexError()` extracts the useful `Error:` tail / JSON `error.message`.
  Codex has only 4 fixed sizes (`CODEX_SIZE_MAP`) — ratio is appended to the prompt.
- `maxDuration = 1000`.

## Flow
1. Validate prompt + model against `IMAGE_MODELS`; mirror reference images to R2/disk.
2. **Azure**: resolve size (custom `WxH` validated by `validateAzureCustomSize`,
   else per-resolution size map), fire background call — text-to-image JSON
   `/images/generations` via `httpsPost`, or image edits multipart
   `/images/edits` via curl (fetching ref buffers first). Decode `b64_json` →
   `uploadBuffer(..., "generated")` → `jobStore.set("azure-…", done/error)` +
   `guestDb.insertGeneration`. Return `{ taskId }`.
3. **Codex**: same background pattern; no key lookup (shared host `codex login`).
   Return `{ taskId: "codex-…" }`.
4. **Kie**: `POST https://api.kie.ai/api/v1/jobs/createTask` with
   `{ model, input }`; re-host local refs through `ensureKieReachableImages` first
   (Kie can't fetch `/generated/...`). On success: `jobStore.set(pending)`,
   `guestDb.insertGeneration(status: "pending")`, `pollKieJob(taskId, token, "image")`.
   Return `{ taskId, referenceImageUrls }`.

## Integration
- **Kie.ai**: `POST /api/v1/jobs/createTask`, Bearer token from
  `getKieTokenForUser()` (`lib/getKieToken.ts` → settings/env `KIE_API_TOKEN`); 401 → 401 response.
- **Azure Foundry**: `{base}/openai/deployments/{deployment}/images/{generations|edits}?api-version=…`,
  key from `getAzureKeyForUser()` / `AZURE_API_KEY`. Friendly-maps `EngineOverloaded`.
- **Codex**: local `codex-imagegen` CLI + `~/.codex/auth.json`.
- **Stores**: `jobStore` (`lib/jobStore.ts`), SQLite `generations`
  (`lib/guest/db.ts`), media via `uploadBuffer` (`lib/storage.ts`).
- **Polling**: `pollKieJob` (`lib/kieJobPoller.ts`) → `/api/job-status` / `/api/job-stream`.

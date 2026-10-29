# lib/providers/adapters/

The four built-in `GenerationProvider` implementations. Each owns one backend
family's request shaping, response parsing and (where applicable) polling; the
routes and `jobManager` stay provider-agnostic. All are server-only
(`node:child_process`, `node:https`, `node:fs`, `MEDIA_DIR`, `process.env`).

## Responsibility

- **`kie.ts`** — kie.ai queue backend. `submit()` builds the image
  `createTask` body (dual-mode `textOnlyUpstreamId`, quality mapping from
  `apiInput`) and the 9-family video payloads moved from the old
  `generate-video` route (motion-control, minimax-h3, seedance frames,
  happy-horse, kling-turbo, google-veo, gemini-omni, reference-image models,
  kling start/end + elements). `poll()` is one `jobs/recordInfo` tick;
  `uploadMedia()` delegates to `lib/kieUpload.ts`.
- **`azure.ts`** — Azure Foundry image backend (sync). Text-to-image JSON
  `…/images/generations` via raw `node:https`; image-to-image multipart
  `…/images/edits` via a spawned `curl`. Resolves the per-model deployment from
  `cfg.extra.deployments[modelId]`, maps size/quality via the catalog's
  `azureSizeMap`/`azureResolutionSizeMaps`, decodes `b64_json` → buffers.
- **`codex.ts`** — local `codex-imagegen` CLI backend (sync). One shared
  `codex login` session (`~/.codex/auth.json`), no per-user key. Writes
  reference images to temp files, spawns `generate|edit --image --prompt
  --size --out --force`, reads the PNG back, cleans stderr into a user-facing
  error.
- **`openaiCompat.ts`** — the `openai-compat` family adapter (aliases
  `openrouter`, `pollinations`): paramMap-driven dialect, sync images
  (`POST {base}{pathOverride}`, default `/v1/images/generations`), async video
  (`POST {base}/videos` → `202 {id, polling_url}` → poll → fetch result bytes),
  and `uploadMedia()` to the binding's media store (incl. cross-provider keys).

## Design

- **Uniform contract.** All four export a `GenerationProvider` literal
  (`id`, `label`, optional `aliases`/`usesParamPresets`, `mediaStaging`,
  `capabilities`, `uploadMedia?`, `checkReadiness`, `submit`, `poll?`).
  `bootstrap.ts` registers them; nothing imports an adapter directly.

  | adapter | submit | poll | uploadMedia | staging default | video |
  |---|---|---|---|---|---|
  | `kie` | async | yes | yes (`kieUpload`) | `remote-url` | yes |
  | `azure` | sync | no | no | `data-url` (edits: `multipart-buffer` via binding) | no |
  | `codex` | sync | no | no | `local-file` | no |
  | `openai-compat` | sync (images) / async (video) | yes (video) | yes (binding endpoint) | `data-url` | yes |

- **Staged media consumption.** Azure/Codex share the same helper shape:
  `stagedBytes()` = staged `buffer` → `filePath` read → `fetchBuffer(url)`.
  Kie instead reads `url ?? originalUrl` (`stagedUrl()`) and falls back to
  `rewriteLocalMediaForKie()` for local URLs that bypass the staged slots
  (kling-element image URLs).
- **Async contract.** `submit()` returns
  `{mode:"async", upstreamTaskId, providerMeta}` where `ProviderMeta`
  (`upstreamTaskId`, `family`, `statusUrl`, `upstreamModelId`) is the ONLY
  channel `poll()` receives besides credentials — `poll()` has no binding.
- **Sync contract.** `{mode:"sync", mediaUrls, rawBuffers}`; base64/CLI bytes
  ride `rawBuffers` so the settle funnel writes them straight to `MEDIA_DIR`.
- **Dialect is data (compat).** `buildBody()`/`buildVideoBody()` iterate
  `binding.paramMap`: undeclared fields are never sent, `valueMaps` with a
  `null` entry drop catalog sentinels (`"auto"`, unsupported tiers), constants
  ride last, `maxReferences`/`maxFrames`/`referenceMode`/`referenceFrame` shape
  media. The adapter contains no vendor branches.
- **Transport hardening (compat).** `classifyFetchError()` splits transport
  failures (retryable: DNS/timeout/reset) from HTTP errors (never retried);
  `fetchWithRetry()` allows one retry inside a shared 12-min submit budget,
  logs shape-only events to `jobLog` (`submit`/`retry`), never the body or key.
- **Azure transport quirks.** `httpsPost()` uses raw `node:https` to escape
  Next.js's request-bound patched `fetch` (1000 s timeout, keep-alive, no
  Nagle); `curlMultipartPost()` exists because Node TLS misbehaves against
  Azure multipart — it retries only SSL exit code 35 and always cleans temp
  files.
- **Codex prompt convention.** `<<<image N>>>` tags are flattened to prose
  (images are file args), the intended aspect ratio is appended to the prompt
  because the CLI has only four fixed canvases (`CODEX_SIZE_MAP`), refs capped
  at 5, prompt truncated to `apiInput.promptMaxLength ?? 8000`.
- **Kie payload precedence.** Family branches are evaluated in the same order
  as the old route (`useMotionControl` → `useMinimaxH3` → `firstFrameKey` →
  `useHappyHorse` → `useKlingTurbo` → `useGoogleVeo` → `useGeminiOmniVideo` →
  `referenceImagesKey` → kling elements/default); `effectiveApiId` switches to
  `imageUpstreamId` or a reference/happyhorse id per branch. Duration is
  clamped to `durationMin/Max` (seedance-2-5-edit uses `-1`); Veo uses its
  dedicated `/api/v1/veo/generate` endpoint with a flattened body.
- **Veo is the one unpolled family.** `pollKie()` parks `kie-google-veo` as
  `pending` (record-info unverified); `jobManager` settles that family with an
  explicit "polling not available" error instead of hanging.

## Flow

**Image (any provider)**: route `resolveForModel` → readiness → stage media →
`submitJob` → `adapter.submit()` → sync settle, or async `providerMeta` +
poll loop.

1. **Kie image**: `buildImageInput()` (refs → `apiInput.imageInputKey`,
   quality map, `extra`) → `POST /api/v1/jobs/createTask` →
   `data.taskId|id` → `ProviderMeta{statusUrl: recordInfo}` → poll tick →
   `state` success/fail → `extractUrls()` (`resultJson.resultUrls|resultUrl`,
   `videoUrl`, `output`) → `done`.
2. **Kie video**: `buildVideoPayload()` → optional
   `rewriteLocalMediaForKie(payloadInput)` → `createTask` (or Veo generate) →
   same async path.
3. **Azure**: `checkReadiness` (key + baseUrl + deployment) → size from
   `azureResolutionSizeMaps[resolution]`/`azureSizeMap`, custom `WxH` via
   `validateAzureCustomSize`, quality default `medium`, api-version default
   `2025-04-01-preview` → refs present ? multipart edits (curl) : JSON
   generations (`httpsPost`) → friendly-map `EngineOverloaded` → base64 →
   `{mode:"sync", rawBuffers:[image/png]}`.
4. **Codex**: `CODEX_SIZE_MAP[aspectRatio]` → prompt rewrite/truncate → refs
   (`slice(0,5)`) → temp files → spawn CLI → read `--out` PNG → sync buffer;
   non-zero exit → `cleanCodexError()` (`Error:` tail JSON `error.message`, or
   semicolon-terminated prose).
5. **Compat images**: `presetError` throw → resolve key (runtime `cfg.apiKey`,
   i.e. DB then the provider's env fallback, else `binding.keyEnv`) + base URL
   (`binding.baseUrl` then `cfg.baseUrl`) → `textOnlyUpstreamId` when no refs →
   `buildBody()` → `fetchWithRetry` → 401/403 friendly error →
   `parseResponse()` (`b64_json` → buffers, `url` → mediaUrls, MIME from the
   `outputFormat` field) → sync.
6. **Compat video**: `buildVideoBody()` (prompt, clamped duration, resolution/
   aspect ratio with `"auto"` dropped, seed, `generate_audio`, `frame_images`,
   `input_references`, constants) → `POST {base}/videos` →
   `id|task_id` + relative `polling_url` resolved against the base origin →
   async `ProviderMeta` → `pollVideo()` maps
   `pending|in_progress` → pending, `completed` → fetch
   `…/content?index=0` with bearer → buffers (fallback `unsigned_urls`/`urls`;
   content-fetch failure keeps the tick pending), `failed|cancelled|expired` →
   error.
7. **Compat upload** (only when staging resolved to `remote-url`):
   `uploadMedia()` requires `binding.mediaUpload.url` → `resolveUploadKey()`
   (cross-provider `keyProviderId` resolved via `getProviderRuntimeConfig` +
   `envFallbackKeyName`, loud failure when missing) → `readLocalBytes()`
   (`data:`, private `http(s)`, `/generated/…`) → `uploadToMediaStore()`
   (`multipart` default / `raw` / `base64`) → `extractUploadUrl()` (JSON
   `url|file_url|image_url|media_url|output_url|href|path`, nested `data/
   result/file`, bare URL, `Location`).

## Integration

- **Registered by** `lib/providers/bootstrap.ts`; **resolved by**
  `lib/providers/registry.ts` (`resolveForModel` merges bindings + presets);
  **invoked by** `lib/jobManager.ts` (`submitJob`, `startPolling`,
  `resumeJob`, `settleJob`).
- **Inputs**: `GenerateInput` (already-staged `StagedMedia`, credentials),
  `ModelProviderBinding` (dialect, upstream ids, upload endpoint),
  `ProviderRuntimeConfig` (`guest/db.getProviderRuntimeConfig`),
  `ModelProviderBinding.paramMap` merged with preset params by the registry.
- **Outputs**: `SubmitOutcome` / `PollOutcome` → `jobManager` → `jobStore`
  (+`ProviderMeta`), `generations`, `jobEvents` SSE, media mirrored by
  `lib/storage` (`mirrorToR2`/`uploadBuffer`).
- **Observability**: `lib/jobLog.appendJobLog` (`submit`/`retry` phases,
  shape-only), `describeError`, `urlHost` (compat).
- **Readiness surface**: `GET /api/settings/providers` calls the compat
  adapters' `checkReadiness()` (including representative OpenRouter /
  Pollinations bindings) so that report cannot disagree with the generation
  path; the other providers use inline key/baseUrl/deployment rules.
- **Sibling modules**: `modelConfig` (catalog/`apiInput`, `ImageModel`,
  `VideoModel`, `validateAzureCustomSize`), `kieUpload` (Kie upload),
  `guest/paths.MEDIA_DIR`, `jobStore.ProviderMeta`.
- **External**: `api.kie.ai` (`/api/v1/jobs/createTask`,
  `/api/v1/jobs/recordInfo`, `/api/v1/veo/generate`),
  `kieai.redpandaai.co/api/file-base64-upload`, Azure
  `{base}/openai/deployments/{deployment}/images/{generations|edits}`,
  local `codex-imagegen` CLI, compat backends
  (`{base}{pathOverride}`, `{base}/videos`, `…/content`, binding
  `mediaUpload.url`).
- **Constraint**: never import `adapters/*` from client code or from routes —
  routes use `lib/providers/bootstrap`, which keeps adapter swaps to one file.

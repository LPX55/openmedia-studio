# lib/providers/

Server-side provider subsystem (provider-refactor design §1): one adapter
contract, a static model→provider binding catalog, per-strategy input-media
staging, param presets for the `openai-compat` family, and the registry that
routes a logical model to an adapter + binding + runtime credentials.
Server-only except `types.ts` / `bindings.ts` (pure data, client-safe).

## Responsibility

- **`types.ts`** — the `GenerationProvider` contract: `ProviderId`,
  `MediaKind`, `MediaStagingStrategy` (`data-url` / `multipart-buffer` /
  `local-file` / `remote-url`), `MediaStagingOperation` (`image-generate` /
  `image-edit` / `video-generate`), `resolveMediaStagingStrategy()` (per-op →
  per-binding → provider default), `StagedMedia`, `ProviderRuntimeConfig`,
  `GenerateInput`, `SubmitOutcome` (sync vs async), `PollOutcome`,
  `GenerationCapabilities` (execution capabilities), `ModelUiOverride`.
  `ProviderMeta` is type-imported from `lib/jobStore.ts` (single pinned shape).
- **`bindings.ts`** — PURE DATA. `VideoPayloadFamily` (9 Kie payload branches),
  `CompatFieldSource`/`CompatParamMap`/`CompatMediaUpload` (the compat
  dialect), `ModelProviderBinding` (upstream ids, `paramMap`, `baseUrl`,
  `pathOverride`, `keyEnv`, staging overrides, `presetId`/`presetError`), and
  `BUILT_IN_BINDINGS`: Kie bindings for every catalog image/video model, Azure
  + Codex for `gpt-image-2`, the OpenRouter image (19) and video (12) lanes,
  and the Pollinations image lane (11). Also `getDefaultBinding()` (kie),
  `getAvailableProvidersForModel()`, representative
  `getOpenRouterBinding()`/`getPollinationsBinding()`, dialect constants.
- **`registry.ts`** — server singleton `Map<ProviderId, GenerationProvider>`:
  `register()` (also registers each `aliases` id as an id-overridden view),
  `get()`, and `resolveForModel()` — the C1 resolution rule + binding merge +
  param-preset layer. `ModelBindingRowLike` / `ResolvedModelProvider`.
- **`bootstrap.ts`** — side-effect registration of the four built-in adapters
  (`kie`, `azure`, `codex`, `openai-compat`) exactly once per process, then
  re-exports `register`/`get`/`resolveForModel`. Controllers import THIS, never
  an adapter directly.
- **`presets.ts`** — code-seeded param presets (`standard-image`, `image-edit`,
  `openrouter-dialect`, `pollinations-sync`), `parseParamPresetParams()`
  (loud validation: malformed JSON / unknown keys / unknown field sources
  throw), and `mergeParamMaps()` (deep merge of the record-shaped members).
- **`mediaStager.ts`** — server-only staging: `RawMediaInput` →
  `StagedMediaGroup` via `stageInputMedia()`; `createStagingResolver()` composes
  the strategy chain and binds `provider.uploadMedia`. Reads `MEDIA_DIR`
  (`node:fs`), materialises `data:` URIs, fetches private-host URLs, dedupes
  uploads per process.
- **Parent `lib/providers.ts`** — NOT a re-export and NOT an index: the
  client-side sibling that owns the `@/lib/providers` specifier (see Design).
  It holds provider labels (`PROVIDERS`), store-backed model prefs, visibility
  toggles, `bindingsByModel` availability, readiness (`isModelReady`) and Azure
  config helpers.

## Design

- **Contract / data / server split.** `types.ts` + `bindings.ts` are pure (type
  imports only) so client code may import them; `registry.ts`,
  `mediaStager.ts`, `bootstrap.ts`, `adapters/*` are server-only and ESLint
  `no-restricted-imports` forbids them from `components/**`, `app/**/page.*`,
  `lib/providers.ts`, `lib/store.ts`.
- **Family adapters with `aliases`.** `openai-compat` is ONE adapter for many
  OpenAI-speaking backends; `openrouter` / `pollinations` keep their OWN
  provider ids (own key row, base URL, bindings). `register()` stores an
  id-overridden view per alias, so `provider.id` stays the backend id for
  credential resolution and `generations.provider_id`.
- **Dialect as binding data, never a code branch.** `paramMap.fields` maps body
  keys → normalized sources, `valueMaps` translate values (`null` = drop the
  field), `constants` pin static values, `referenceMode` shapes refs
  (`array` / `first` / `objects`), plus caps (`maxReferences`, `maxFrames`) and
  video clamps (`durationMin/Max`, `defaultDuration`, `referenceFrame`).
- **Pinned binding polarity.** `upstreamModelId` = base variant;
  `textOnlyUpstreamId` = image no-media variant; `imageUpstreamId` = video
  media-present variant. A video `imageApiId` is never mapped into
  `textOnlyUpstreamId` (inverted meaning).
- **Staging chain.** Per media item:
  `binding.mediaStagingByOperation[op] → binding.mediaStaging →
  provider.mediaStaging`. Public `http(s)://` inputs pass through unchanged
  under every strategy; loopback/private hosts are NOT remote (re-hosted /
  fetched server-side); `/generated/…` and `data:` are converted per strategy.
  `remote-url` requires `uploadMedia()` — the binding is passed as the hook's
  4th argument so a backend uploads to its own media store.
- **Preset layering.** For `usesParamPresets` providers only:
  `preset.params ← static binding.paramMap ← custom-binding paramMap`.
  Unknown preset id becomes `binding.presetError` — the adapter fails the job
  loudly, never a silent fallback.
- **Default-binding rule.** explicit provider → active `model_bindings` row →
  static Kie binding (preserves the legacy `?? "kie"`). Static bindings are
  code; SQLite rows only add overrides / prefs / custom endpoints.
- **Credentials.** `guest/db.getProviderRuntimeConfig()` resolves the stored
  `provider_configs` key first, then the env fallback list; `codex` reports
  `keySource: "cli"` from `~/.codex/auth.json` instead of an api_key. Secrets
  never leave the server — the client gets `hasKey`/`keySource`/`ready` only.
- **Naming trap (deliberate).** `@/lib/providers` resolves to `providers.ts`
  because no `lib/providers/index.ts` exists. Adding an index would shadow the
  client module; server code must import `@/lib/providers/bootstrap` (or the
  specific module).

## Flow

1. Route parses the normalized payload → `resolveForModel(modelId,
   providerId?, guestDb.getModelBindingRows(modelId))` → `{ provider, binding,
   config }`. Steps: pick provider (explicit → active row → Kie default), find
   the static binding + row override, merge, resolve the preset layer, require
   a registered adapter, read the runtime config. Throws for unknown models,
   missing `upstreamModelId`, or unregistered adapters.
2. Route calls `provider.checkReadiness(config, binding)` → 401 with the
   adapter's reason when not ready.
3. `createStagingResolver(operation, binding, provider)` +
   `stageInputMedia(rawMedia, resolver, config)` stage the 7 media groups in
   parallel (`references`, `startFrame`, `endFrame`, `videoRef`,
   `referenceVideos`, `audioRefs`, `resources`). Uploads are deduped per
   process by input string.
4. `jobManager.submitJob()` pre-mints `taskId` (`<provider>-<ts>-<rand>`),
   writes the pending `jobStore` + `generations` rows with `provider_id`, marks
   the submit live, then runs `provider.submit(input)` in a managed background
   task.
5. Sync outcome (`{mode:"sync", mediaUrls, rawBuffers}`) → `settleJob()`.
   Async outcome (`{mode:"async", upstreamTaskId, providerMeta}`) → persist
   `provider_meta`, then `startPolling()` (3 s tick, 12 min deadline) calling
   `provider.poll(upstreamTaskId, kind, cfg, meta)` until `done`/`error`.
6. `settleJob()` mirrors remote URLs into `MEDIA_DIR`, stores raw buffers,
   updates `jobStore` + the `generations` row, emits `job:<taskId>` for SSE.
7. `GET /api/settings/providers` derives readiness (adapter `checkReadiness()`
   for the compat lanes; inline key/baseUrl/deployment rules for the rest),
   unions static `bindingsByModel` with stored rows, and lists presets;
   `PUT`/`DELETE` write `provider_configs` / `model_bindings`.

## Integration

- **Consumers (server routes)**: `app/api/generate` and `app/api/generate-video`
  (`resolveForModel`, `createStagingResolver`/`stageInputMedia`, then
  `submitJob`); `app/api/settings/providers` (`bindings` getters,
  `bootstrap.get`, preset list via `guest/db`).
- **Consumers (lib)**: `lib/jobManager.ts` (`./providers/bootstrap` for
  registration + `get`, `providers/types`, `providers/bindings`) owns submit,
  poll loop, settle and resume; `lib/guest/sqlite.ts` seeds
  `PARAM_PRESET_SEEDS` via `presets.parseParamPresetParams`; `lib/guest/db.ts`
  supplies runtime configs, binding rows and presets.
- **Client side**: `lib/providers.ts` + `lib/store.ts` (`providerStatus`,
  `modelProviders`, `bindingsByModel`, `presets` hydrated from
  `GET /api/settings/providers`); components read readiness/prefs from the
  store and never import this directory's server modules.
- **Sibling lib modules**: `modelConfig` (catalog + `apiInput`/Azure maps),
  `kieUpload` (Kie temp-store upload), `jobStore` (`ProviderMeta`),
  `jobLog` (trail), `storage` (`mirrorToR2`/`uploadBuffer` at settle).
- **Verification**: `scripts/providers/smoke-compat.mjs` — offline
  registry/bindings/staging/compat harness with a stubbed `fetch` (zero
  network).
- **External services**: kie.ai (`api.kie.ai`, temp upload on
  `kieai.redpandaai.co`), Azure Foundry, local `codex-imagegen` CLI, OpenRouter
  (`/images`, `/videos`), Pollinations (`gen.pollinations.ai` +
  `media.pollinations.ai/upload`).

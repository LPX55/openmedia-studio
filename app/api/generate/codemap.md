# /api/generate — image generation dispatch

## Responsibility
Single entry point for image generation. A thin, provider-agnostic controller
(Phase 4 / P4b): validates the request, resolves the backend from the provider
registry, stages reference media, hands the job to `jobManager.submitJob()` and
returns a `taskId` immediately. All provider branching (Kie / Azure Foundry /
Codex CLI / openai-compat payload construction) lives in
`lib/providers/adapters/*` — this route never imports an adapter.

## Design
- `POST` body: `{ model = "nano-banana-2", prompt, imageUrls = [], aspectRatio = "1:1",
  quality = "1k", resolution?, customWidth?, customHeight?, providerId?, debugOnly? }`.
  There are no `azure*` / `codex*` flags any more — the backend comes from the
  model's binding.
- `debugOnly: true` logs the normalized payload and returns `{ ok: true }`
  **before** validation (first branch in the handler).
- Validation: empty prompt → 400 `Prompt is required`; unknown model → 400
  `Unknown model: …`; provider not ready → 401 with the adapter's
  `checkReadiness().reason`.
- Provider resolution: `resolveForModel(model, providerId, guestDb.getModelBindingRows(model))`
  — explicit `providerId` → active `model_bindings` row → static default (Kie).
  Returns `{ provider, binding, config }`; `config` is
  `getProviderRuntimeConfig(providerId)` (DB key → env fallback).
- Reference cap: `imageUrls.slice(0, 14)` — the legacy Kie limit, applied before
  staging so every backend sees the same input.
- Staging operation is chosen **per request**: `image-edit` when references are
  present, else `image-generate`. `createStagingResolver(op, binding, provider)`
  resolves the strategy chain `binding.mediaStagingByOperation[op]` →
  `binding.mediaStaging` → `provider.mediaStaging`. This is what makes Azure's
  `multipart-buffer` edit leg reachable; Kie/Codex resolve to `remote-url`
  either way.
- `maxDuration = 1000`.

## Flow
1. Parse body → `debugOnly` short-circuit → prompt/model validation.
2. `resolveForModel` → readiness check (401 on failure).
3. `stageInputMedia({ references }, resolver, config)` — local `/generated/…`
   paths and `data:` URIs are re-hosted/buffered per strategy; `http(s)://` URLs
   pass through unchanged (loopback hosts are re-hosted).
4. `submitJob("image", provider, binding, { model: modelCfg, prompt, params, media })`
   → mints `taskId`, writes the pending `jobStore` record + `generations` row,
   runs `provider.submit()` in the background, settles synchronously or arms the
   poll loop.
5. Return `{ taskId }`; any thrown error → 500 `{ error }`.

## Integration
- **Registry**: `resolveForModel` from `@/lib/providers/bootstrap`
  (side-effect registration of kie/azure/codex/openai-compat).
- **Staging**: `stageInputMedia` / `createStagingResolver`
  (`lib/providers/mediaStager.ts`) — `MEDIA_DIR`, `kieUpload` re-hosting.
- **Job lifecycle**: `submitJob` (`lib/jobManager.ts`) → `settleJob`,
  `startPolling`, `jobStore`, `guestDb.insertGeneration` / `updateGeneration`,
  `jobEvents`.
- **Catalog**: `IMAGE_MODELS` (`lib/modelConfig.ts`) supplies `apiId`, size maps,
  prompt caps; the binding carries `upstreamModelId`, `paramMap`, staging.
- **Reads**: `/api/job-status`, `/api/job-stream`, `/api/jobs/[taskId]/log`.
- **Readiness source**: `GET /api/settings/providers` (the client cannot import
  the server-only registry).

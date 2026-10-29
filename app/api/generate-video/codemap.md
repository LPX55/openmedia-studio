# /api/generate-video — video generation dispatch

## Responsibility
Thin, provider-agnostic video controller (Phase 4 / P4b + P6 video lane):
validates the model, rejects image-only backends, resolves the provider/binding,
stages frames and references, and submits through `jobManager.submitJob()`.
The nine Kie payload families and the OpenRouter `/videos` dialect live in
`lib/providers/adapters/kie.ts` / `openaiCompat.ts` — the route never branches on
provider or model family.

## Design
- `POST` body: `{ videoModel|model?, prompt, startFrameUrl?, endFrameUrl?,
  videoRefUrl?, resources[] {url,label}, klingElements[] {name,description,imageUrls},
  referenceImageUrls|imageUrls[], referenceVideoUrls[], referenceAudioUrls[],
  sound = false, duration = 5, aspectRatio|aspect_ratio = "16:9", mode = "pro",
  resolution?, seed?, veoMode?, generationType?, callBackUrl?, providerId?, debugOnly? }`.
- Model default is `kling-3.0`; unknown model → 400 `Unknown video model: …`.
- `resolution` falls back to `modelCfg.defaultResolution` then `"480p"`.
- `debugOnly` returns `{ debugPayload }` (the normalized request, not the final
  provider body) and never submits.
- Provider resolution: `resolveForModel(videoModel, providerId, guestDb.getModelBindingRows(videoModel))`
  — explicit id → active row → static Kie default.
- **Video capability gate**: `provider.capabilities?.video === false` (Azure,
  Codex) → 400 `${label} does not support video generation.` — fails fast
  instead of building a broken image request upstream. `undefined` is treated as
  allowed (compat family).
- Readiness failure → 401 with the adapter's `checkReadiness().reason`.
- Duration is clamped here (same math as the adapter's payload builder) so the
  pending `generations` row records the clamped value: `seedance-2-5-edit` → `-1`;
  `apiInput.durationMax <= 0` → `0`; otherwise
  `clamp(duration, durationMin, durationMax)`.
- Staging: one `stageInputMedia` call with operation `video-generate` covering
  references, start/end frames, video ref, reference videos, audio refs and
  `resources` (`label` → `tag`). The binding decides the strategy (Kie
  `remote-url`, Azure `multipart-buffer`, compat `remote-url` with the backend's
  media-upload hook — e.g. Pollinations' store for local frames).
- Family-specific structured inputs ride `extras` and are only included when
  present: `klingElements`, `veoMode`, `generationType`, `callBackUrl`.

## Flow
1. Parse body → model lookup → resolution default → `debugOnly` short-circuit.
2. `resolveForModel` → capability gate → readiness check.
3. Clamp duration.
4. `stageInputMedia(...)` with the `video-generate` operation.
5. `submitJob("video", provider, binding, { model, prompt, params, media, extras })`
   → `{ taskId }`.
6. Errors → 500 `{ error }` (cause logged).

## Integration
- **Registry / adapters**: `resolveForModel` from `@/lib/providers/bootstrap`;
  Kie adapter builds the 9 families and posts `POST /api/v1/jobs/createTask`
  (Veo: `POST /api/v1/veo/generate`); the openai-compat adapter posts
  `POST {base}/videos` (OpenRouter) and polls `polling_url`, settling raw bytes.
- **Staging**: `lib/providers/mediaStager.ts` — local `/generated/…` frames are
  re-hosted (Kie) or uploaded through the backend's media store (compat).
- **Job lifecycle**: `submitJob` / `settleJob` / `startPolling`
  (`lib/jobManager.ts`). The Kie-Veo family is the one **unpolled** family —
  `submitJob` settles it `error` with a "check the Gallery later" message
  instead of leaving it pending.
- **Catalog**: `VIDEO_MODELS` (`lib/modelConfig.ts`) — `apiInput` flags
  (`useMotionControl`, `useMinimaxH3`, `useHappyHorse`, `useKlingTurbo`,
  `useGoogleVeo`, `useGeminiOmniVideo`, `firstFrameKey`, `referenceImagesKey`),
  duration bounds, `defaultResolution`.
- **Reads**: `/api/job-status`, `/api/job-stream`, `/api/jobs/[taskId]/log`.

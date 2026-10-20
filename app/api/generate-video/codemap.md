# /api/generate-video — video generation dispatch

## Responsibility
Builds the model-specific `input` payload and submits a video generation task to
kie.ai for any supported video model, then registers the task for async polling.

## Design
- `POST` body (all optional except `prompt`-bearing modes):
  `{ videoModel|model?, prompt, startFrameUrl, endFrameUrl, videoRefUrl, resources[],
  klingElements[], referenceImageUrls|imageUrls[], referenceVideoUrls[],
  referenceAudioUrls[], sound?, duration?, aspectRatio?, mode?, resolution?, seed?,
  veoMode?, generationType?, callBackUrl?, debugOnly? }`.
- Model catalog `VIDEO_MODELS` (`lib/modelConfig.ts`) drives everything through
  `apiInput` feature flags; a long `if/else` chain selects a payload builder:
  - `useMotionControl` — Kling 2.6 motion control (`input_urls`/`video_urls`, `mode`=resolution, `character_orientation`=mode)
  - `useMinimaxH3` — MiniMax H3 with api-id switching: image-to-video
    (`first_frame_url`/`last_frame_url`) → reference-to-video (`minimax-h3/reference-to-video`, ≤9 images / ≤3 videos / ≤3 audios) → text-to-video
  - `firstFrameKey` — Seedance-style (separate frame keys; frames and reference
    images mutually exclusive; `seedance-2-5-edit` forces `aspectRatio: "adaptive"`, duration `-1`)
  - `useHappyHorse` — Alibaba: `happyhorse/{reference,image,text}-to-video`, seed support
  - `useKlingTurbo` — Kling 3.0 Turbo text/image-to-video (duration sent as string)
  - `useGoogleVeo` — Google Veo: generationType ∈ `TEXT_2_VIDEO` /
    `FIRST_AND_LAST_FRAMES_2_VIDEO` / `REFERENCE_2_VIDEO` (lite can't reference),
    plus `watermark`, `enableFallback`, `callBackUrl`
  - `useGeminiOmniVideo` — quota math: image=1 slot, video=2 slots, max 7;
    video refs become `video_list: [{url,start,ends}]` and suppress duration
  - `referenceImagesKey` — Grok Imagine / 1.5 (`imageApiId` when refs present)
  - default — Kling start/end-frame + `resources` or `kling_elements`
    (legacy `resources` duplicated into `element_input_urls` ×2; names sanitized)
- Every URL goes through `ensureR2(...)` (local mirror; `.catch(() => url)` keeps
  the original on failure), then `rewriteLocalMediaForKie(input, apiKey)` re-hosts
  remaining `/generated/` and `data:` URLs so kie.ai can fetch them.
- Duration is clamped to `[apiInput.durationMin, durationMax]`.
- `debugOnly` returns `{ debugPayload, debugEndpoint }` without submitting.
- Endpoint: `POST /api/v1/veo/generate` (flattened body) for Veo, otherwise
  `POST /api/v1/jobs/createTask` with `{ model, callBackUrl, input }`.

## Flow
1. Resolve Kie token (`getKieTokenForUser()` ?? `KIE_API_TOKEN`); 401 if absent.
2. Find model cfg, clamp duration, build `input` (branch above).
3. Re-host local media for Kie (502 on failure).
4. Submit; on `code === 200` extract `taskId` (`data.taskId ?? data.id`).
5. `jobStore.set(taskId, { status: "pending", type: "video" })`,
   `guestDb.insertGeneration({ generation_type: "video", status: "pending",
   model, prompt, aspect_ratio, duration, kling_mode, sound, reference_image_urls })`
   (reference URLs recovered per-branch from the built input).
6. `pollKieJob(taskId, apiKey, "video")` — except Veo, which logs a warning that
   it needs a callback URL (no jobs-API polling).
7. Return `{ taskId }`; all errors → `{ error }` (Kie 401 mapped to 401).

## Integration
- **Kie.ai**: `POST https://api.kie.ai/api/v1/jobs/createTask`,
  `POST https://api.kie.ai/api/v1/veo/generate`; Bearer auth.
- **Stores**: `jobStore`, SQLite `generations`, local disk via `ensureR2`/`rewriteLocalMediaForKie`
  (`lib/storage.ts`, `lib/kieUpload.ts`).
- **Polling**: `lib/kieJobPoller.ts` → `/api/job-status`, `/api/job-stream`.
- **Models**: `VIDEO_MODELS` in `lib/modelConfig.ts`.

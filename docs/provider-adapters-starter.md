# Provider Adapters — Starter Backends Spec (OpenRouter · SpicyAPI · Pollinations · Hugging Face)

**Scope:** specification/report only — no source code. This document defines four new `GenerationProvider` adapters for HeliosGen's provider refactor, to be implemented alongside (after) the Phase 4+5 adapter wave described in `docs/provider-refactor.md`.

**Primary source:** `.slim/starter-providers-findings.md` (referred to below as **`findings:NN`**, NN = line number). Contract/architecture sources: `docs/provider-refactor.md` sections **(a)** and **(c)** (**`report:NN`**) and `.slim/deepwork/provider-refactor-plan/design.md` §1.3/§2/§3 (**`design:NN`**). Nothing here invents an API: every endpoint, status value, and URL is traceable to those three documents, and all source URLs from the findings are preserved verbatim per provider.

**Contract in force (unchanged):** `GenerationProvider` = `submit` / `poll` / `checkReadiness` / `uploadMedia` (`report:59-75`, `design:134-165`); submit mode is decided *by submit's outcome* (`SubmitOutcome` sync vs async, `design:116-118`); `PollOutcome = pending | done | error` — no new states (`report:74`, `design:120-123`); `provider_meta` is pinned as `{ upstreamTaskId, family, statusUrl, responseUrl?, upstreamModelId }` (`report:75`, `design:125-132`); every completion path funnels through `settleJob()` which mirrors media, writes `jobStore` + `generations`, emits `job:${taskId}`, and releases registries (`report:80`, `design:192-210`); mediaStaging resolves `binding.mediaStagingByOperation[op]` → `binding.mediaStaging` → `provider.mediaStaging`, with already-remote `https://` inputs passing through unchanged (`report:73`, `design:81-83`). Staging operations are `"image-generate" | "image-edit" | "video-generate"` (`design:82`).

**Adapter registry additions** (server-side singleton, `report:57`, `design:171-175`):

| adapter id (`ProviderId`) | label | modality | submit mode | poll() |
|---|---|---|---|---|
| `openrouter` | OpenRouter | image only | sync | **undefined** |
| `spicyapi` | SpicyAPI | image + video | async (202) | defined |
| `pollinations` | Pollinations | image + video | sync **or** async (decision per submit) | defined (async mode only) |
| `huggingface` | Hugging Face | image + video | sync (client hides polling) | **undefined** |

`ProviderId` is an open union (`(string & {})`, `design:60`), so these ids need no type changes beyond registry registration. Per C1, bindings are **code** in `lib/providers/bindings.ts` (pure, no `guest/db` import — `report:55,93`); `model_bindings` rows exist only for active-provider preference/overrides (`design:246-263`).

---

## 1. Per-provider adapter specs

### 1.1 `openrouter` — OpenRouter

- **Base URL:** `https://openrouter.ai/api/v1`; image discovery `GET /api/v1/images/models`, per-endpoint caps `GET /api/v1/images/models/{model}/endpoints` (`findings:9`).
- **Auth:** `Authorization: Bearer $OPENROUTER_API_KEY`; env key **`OPENROUTER_API_KEY`**. Distinct from the design's `openai-compat → OPENAI_API_KEY` row — OpenRouter gets its **own `provider_id`**, it is not an openai-compat binding (`findings:11`).
- **mediaStaging:** **`data-url`** (provider-level default). Why: reference images (`input_references[]`) accept HTTP(S) URLs **or base64 data URLs** inline, and OpenRouter has **no upload API** (`findings:15,23`). Remote `https://` refs still pass through unchanged per the pinned passthrough rule. No `uploadMedia` hook (only required for `remote-url`, `design:140-141`).

**Submit semantics — sync only** (`findings:19`):
- `POST /api/v1/images` with body fields `model, prompt, n (≤10), resolution (512|768|1K|1.5K|2K|4K), aspect_ratio (1:1…21:9|auto), size (tier or "WxH"), quality (auto|low|medium|high), output_format (png|jpeg|webp|svg), background, output_compression, seed, stream, input_references[], user`, plus the `provider` routing object (`only`/`order`/`ignore`/`sort`/`allow_fallbacks`, `provider.options.<slug>` passthrough like `steps`/`guidance` gated by `allowed_passthrough_parameters`). **No negative-prompt field** (per-provider passthrough only) (`findings:13`).
- Response: `{ created, data: [{ b64_json, media_type }], usage: { prompt_tokens, completion_tokens, total_tokens, cost } }` (`findings:13`).
- Status vocabulary: HTTP only — failed generations → **502, no charge**; no job id, no poll, no cancel. Optional SSE streaming (`image_generation.partial_image` / `image_generation.completed` / `error`, ends `data: [DONE]`) exists but is **not used** by the adapter (`findings:19`).
- Result-fetch shape: none — everything is in the POST response. Output media = base64 inline (`data[].b64_json`), no hosted URL (`findings:21`).
- `SubmitOutcome`: `{ mode: "sync", mediaUrls: [], rawBuffers: [{ buffer: base64-decode(b64_json), mimeType: media_type }] }` — `settleJob` mirrors buffers via `uploadBuffer` (`design:200,205`).

**`poll()`: explicitly undefined** — sync adapter (`findings:19`). Consequence: a crash mid-submit leaves no upstream id to resume; `resumeJob` settles such rows `error` (expected path, `design:225`).

**`checkReadiness`:** env/DB key present (`findings:29`) — i.e. `provider_configs('openrouter').api_key → OPENROUTER_API_KEY` non-empty. No binding-dependent config (no deployments).

**paramMap** (HeliosGen `GenerateInput.params` → provider field; `GenerateInput` at `design:86-114`):

| HeliosGen field | OpenRouter field | Notes |
|---|---|---|
| `prompt` (top-level) | `prompt` | `findings:25` |
| `aspectRatio` | `aspect_ratio` | `1:1`…`21:9`, `auto` |
| `quality` | `quality` | `auto\|low\|medium\|high` — matches Azure-style `azureQualityOptions` vocabulary (`findings:25`) |
| `resolution` | `resolution` | vocab `512\|768\|1K\|1.5K\|2K\|4K` (`findings:13`); only pass when the client value normalizes into that vocab |
| `customWidth` / `customHeight` | `size` (`"WxH"`) | `findings:25` |
| `seed` | `seed` | |
| `negativePrompt` | *(none)* | passthrough only via `provider.options` per slug (`findings:25`) |
| `duration`, `mode`, `sound` | *(n/a)* | no video on OpenRouter (`findings:17`) |
| steps/guidance | `provider.options.<slug>` | not part of `params`; only if the binding opts in via `allowed_passthrough_parameters` |
| media: `references[]` | `input_references[]` `{ type: "image_url", image_url: { url } }` | URL **or** base64 data URL; count varies by provider `architecture.input_modalities` (`findings:15`) |

**provider_meta example** (`findings:27`):

```json
{
  "upstreamTaskId": null,
  "family": "standard",
  "statusUrl": null,
  "responseUrl": null,
  "upstreamModelId": "openrouter-image-slug"
}
```

Note: `design:186` says meta is "written on every async submit" while the pinned `ProviderMeta` types `upstreamTaskId`/`statusUrl` as `string` (`design:127-129`). For sync-only adapters either (a) persist the diagnostic null-form shown above (needs `string | null` on those two fields), or (b) write no `provider_meta` row at all. **Recommendation: (a)** with a `string | null` widening — keeps one shape everywhere (O2 C3) and makes "sync provider" detectable from the row.

**Suggested initial logical-model bindings** (candidates; `upstreamModelId` must be resolved at implementation):
- **Scope: image only — none of the 17 video models** (`findings:17`). All 11 image models are capability candidates: `google-nano-banana`, `nano-banana-2`, `nano-banana-pro`, `nano-banana-2-lite`, `z-image`, `seedream-5-lite`, `seedream-5-pro`, `grok-imagine-image`, `gpt-image-2`, `gpt-image-2-5-flare`, `gpt-image-2-5-sunburst` (`lib/modelConfig.ts:129-383`, ids per grep).
- **Every slug is unverified** until read from `GET /api/v1/images/models` (and per-endpoint caps) — never reuse Kie-style `apiId`s here (`findings:9`).
- `textOnlyUpstreamId` usually unset: `input_references` is *optional* on one endpoint, so a single `upstreamModelId` covers both t2i and i2i unless discovery shows distinct slugs (polarity rules: `report:55`).
- `family: "standard"`, `paramMap`: the fixed rows above (static, not per-model).

**Caveats:**
- OpenAI-**flavored but not OpenAI-compatible**: path is `/images` (not `/v1/images/generations`), and `aspect_ratio`/`resolution`/`input_references` are OpenRouter-specific — a generic openai-compat binding can't express it (needs path + schema overrides it doesn't have) → **dedicated thin adapter** (`findings:29`).
- Sync-only ⇒ no crash recovery beyond `resumeJob`'s standard `error` settle (`design:225`).
- `n > 1` (`n ≤ 10`) is supported by the API but HeliosGen's job model expects one media result — bind `n = 1` initially.

**Sources (verbatim from `findings:31`):** https://openrouter.ai/docs/guides/overview/multimodal/image-generation.md (redirect target of `/docs/features/multimodal/image-generation`; `https://openrouter.ai/docs/api-reference` itself 404s on fetch).

---

### 1.2 `spicyapi` — SpicyAPI

- **What it is:** Kie-style model aggregator with an **async task queue** (image + video) plus OpenAI/Anthropic/Gemini-compat **text** endpoints. Model ids are `publisher/model/task`; each model's accepted input fields come from its `inputSchema` (`GET /api/v1/models/{id}`; public catalog `https://api.spicyapi.ai/console/v1/catalog/models`) (`findings:37`).
- **Base URLs:** native `https://api.spicyapi.ai/api/v1`; text-compat `https://api.spicyapi.ai/v1/...` (`findings:39`). **Media traffic uses the native base only.**
- **Auth:** `Authorization: Bearer sk-spicy-…` (bearer-only on `/api/v1/*`); env key **`SPICY_API_KEY`** (`findings:41`).
- **mediaStaging:** **`remote-url`** (provider-level default). Why: references must be URLs/data inside `input`, and uploaded files are retained only ~1 day (`findings:50,52`) — mirror/stage immediately. First pass: already-remote `https://` pass-through + `uploadMedia` **once the upload path is confirmed** (open spike, see caveats). Binding may override per operation via `mediaStagingByOperation` (`design:82`).

**Submit semantics — async** (`findings:44-46`):
- `POST /api/v1/jobs/createTask` `{"model": "publisher/model/task", "input": {"prompt": …}}` → **HTTP 202** `{ code: 200, msg, data: { taskId, state: "queued", estimatedCost, deadlineAt } }`. Optional `Idempotency-Key` (24h; reuse with a *different* payload → `409`). Optional `callBackUrl` webhook — **ignore** (no public ingress; no-touch list).
- `SubmitOutcome`: `{ mode: "async", upstreamTaskId: data.taskId }`.
- **Poll:** `GET /api/v1/jobs/recordInfo?taskId=…` → `data.state` vocabulary: **`queued → running → succeeded | failed | expired`**; terminal states carry `errorCode, errorMessage, cost, settled, completedAt` (`findings:45`).
- **Envelope trap:** the body `code` stays `200` **even on task failure** — must branch on `data.state`, never on `code` (`findings:45`).
- **Result-fetch shape:** hosted pre-signed URLs — `data.output.assets[]: { key, url, expiresAt, mime, width, height, bytes, pending? }` (`findings:48`). One unknown input field in `input` → **400** (`findings:45`).
- Free quote: `POST /api/v1/jobs/quote`. **No cancel** — "tasks cannot be cancelled once accepted" (`findings:46`).

**`poll()` — specified** (interval is jobManager's fixed 3s / 12m deadline, `design:218`; findings' summary says "recordInfo 3s interval", `findings:125`):

| `data.state` | `PollOutcome` |
|---|---|
| `queued`, `running` | `{ state: "pending" }` |
| `succeeded` + assets with live `url` (and `pending` falsy) | `{ state: "done", mediaUrls: assets.map(a => a.url) }` |
| `succeeded` but asset `pending: true` | `{ state: "pending" }` — retry on next tick, **not** `error` (fal C4 pattern, `design:219`, `findings:48`) |
| `failed`, `expired` | `{ state: "error", error: errorCode + errorMessage }` |

Because each `recordInfo` response returns **fresh** pre-signed links, `done` is returned with the URLs from the *current* poll, and `settleJob` mirrors them immediately (`design:204-206`).

**`checkReadiness`:** api-key resolution chain non-empty — `provider_configs('spicyapi').api_key → SPICY_API_KEY` (same class as kie/replicate/fal/openai-compat per `design:151`); no binding-dependent config. Bearer is mandatory on `/api/v1/*` (`findings:41`).

**paramMap** (`findings:54`):

| HeliosGen field | SpicyAPI field | Notes |
|---|---|---|
| `prompt` | `input.prompt` | `findings:54` |
| `model` | `model` (top-level) | `binding.upstreamModelId` = `publisher/model/task` |
| `aspectRatio`, `quality`, `resolution`, `customWidth`, `customHeight`, `duration`, `mode`, `sound`, `seed`, `negativePrompt` | **per-model `inputSchema.properties`** | populated **per model at binding time**, not hardcoded — one unknown field = 400 (`findings:45,54`) |
| media: `references[]`, `startFrame`, … | per-model `inputSchema` reference field | exact field name unknown until the OpenAPI spike (caveats) |

**provider_meta example** (`findings:56`; `statusUrl` fully resolved per `design:129`):

```json
{
  "upstreamTaskId": "task_abc123",
  "family": "standard",
  "statusUrl": "https://api.spicyapi.ai/api/v1/jobs/recordInfo?taskId=task_abc123",
  "responseUrl": null,
  "upstreamModelId": "publisher/model/task"
}
```

`responseUrl` is `null` because the result arrives **on the poll response itself** (`findings:56`). The fully-resolved `statusUrl` is what `resumeJob` needs to restart polling after a restart (`design:225`).

**Suggested initial logical-model bindings:**
- **Modality: image + video** — both ride the same queue (`findings:43`).
- Start with models whose catalog `inputSchema` covers the logical model's parameters, sourced from `https://api.spicyapi.ai/console/v1/catalog/models`. All 28 logical models are *potential* candidates, but bind only where a `publisher/model/task` id resolves.
- **Defer Kie-family-specific models**: `kling-2.6-motion-control`, `kling-3.0-motion-control`, `happyhorse`, `minimax-h3`, and the Veo trio depend on Kie payload families (`kie-motion-control`, `kie-happy-horse`, `kie-minimax-h3`, `kie-google-veo` — `report:54`) whose semantics (handles, modes) may not exist in a SpicyAPI `inputSchema`. Unless the schema proves otherwise, SpicyAPI bindings use **`family: "standard"`** with a **per-model `paramMap` generated from `inputSchema.properties`** (`findings:54`).
- Reasonable first tranche: straightforward t2i/i2i image models and t2v video models with plain `prompt`-shaped inputs; add edit/motion models only after schema inspection.

**Caveats:**
- **URL expiry ~20 min** — pre-signed asset links die quickly; `settleJob` mirrors immediately (it already does, `design:204-206`), but **`resumeJob` after a long outage may find dead links** (`findings:48,130`). Spec: on `done`, mirror at once; if mirroring fails with an expiry-like error, re-poll `recordInfo` for a fresh link within the 12m deadline before settling `error`.
- **`code:200` on failure** — always branch on `data.state` (`findings:45,130`).
- **Assets may briefly be `pending: true`** → retry as `pending`, never `error` (C4, `design:219`).
- **Media-upload open spike:** the Media docs page (`https://docs.spicyapi.ai/docs/media`, "Direct reference uploads and artefact downloads") was **not retrievable** (site serves a truncated `llms-full.txt` for every path). Exact upload path + reference field name must be pulled from **`https://docs.spicyapi.ai/openapi.yaml`** (OpenAPI 3.1) **at implementation time** — same class of spike as kie-veo (`findings:50`; C4 spike precedent `design:220`). Until resolved: remote-URL pass-through only; if a *local* input media arrives while `uploadMedia` is unresolved, fail the submit with an explicit reason (a throwing `submit()` settles `error` via the managed-task catch, `design:215`).
- Uploaded files retained ~1 day (`findings:50`) → staging must be immediate even after the spike resolves.

**Sources (verbatim from `findings:60`):** https://docs.spicyapi.ai/ (serves `llms-full.txt`; corpus → https://docs.spicyapi.ai/openapi.yaml, media page https://docs.spicyapi.ai/docs/media).

---

### 1.3 `pollinations` — Pollinations (gen.pollinations.ai)

- **Base URL:** `https://gen.pollinations.ai` (+ media store `https://media.pollinations.ai`) (`findings:66`).
- **Auth:** required for **all generation** — `Authorization: Bearer $POLLINATIONS_API_KEY` **or** `?key=` query param; keys `sk_…` from enter.pollinations.ai (Pollen prepaid; x402 USDC also available). Model listing needs no auth. Env key **`POLLINATIONS_API_KEY`** (`findings:68`).
- **mediaStaging:** **`remote-url`** (provider-level default). Why: reference images are passed as **URLs** (`image=` param / chat image parts), local files can be uploaded via `POST https://media.pollinations.ai/upload` (multipart/raw/base64, ≤400 MiB, 30-day lifecycle) to obtain a URL, and **data-urls in a GET query string are impractical** (`findings:80`). → `uploadMedia` = the media-store upload endpoint. Remote `https://` inputs pass through unchanged.

**Submit semantics — sync by default, async opt-in per submit** (`findings:70-78`):

*Sync paths (no header):*
- **Image:** `GET /image/{prompt}` — prompt is the **URL path** (must be URL-encoded); query params `model` (`publisher/model`), `width`, `height`, `seed`, `nologo`, `enhance`, `private`, `image=` (reference image URL / i2i). Returns **binary image bytes** (JPEG/PNG/SVG per model) (`findings:70`).
- **Image (OpenAI-compat alternative):** `POST /v1/images/generations` — defaults `b64_json`; `response_format: "url"` yields a stored media URL (`findings:70`).
- **Video:** `GET /video/{prompt}` — returns **MP4**; params `model` (veo-3.1-fast, seedance-2.0, kling-v3.0-std, minimax-h3, wan-3.0, grok-imagine-video…), `duration` (per-model `allowed_durations`), `image=` start frame (`findings:72`).
- Result shape: binary bytes (GET), or `b64_json`, or hosted `media.pollinations.ai` URL (`Link: <…>; rel="enclosure"`) — **our choice** (`findings:78`).
- `SubmitOutcome`: `{ mode: "sync", mediaUrls: [...url form...], rawBuffers: [{ buffer, mimeType }] }` depending on chosen response shape. **Recommendation:** use the URL form (`response_format:"url"` / `Link` header) so `settleJob` mirrors via `mirrorToR2`; use buffers only for the raw-GET path.

*Async path (opt-in):* add header **`Prefer: respond-async`** to any media route → **202** `{ id }` + `Location` + `Retry-After: 5`; job records expire **24h**; identical requests dedupe; only the submitting account can read it; no cancel documented (`findings:74`).
- `SubmitOutcome`: `{ mode: "async", upstreamTaskId: id }`.
- **Status vocabulary:** `GET /v1/jobs/{id}` → `status: succeeded | failed` (`findings:74`).
- **Result fetch:** `GET /v1/jobs/{id}/result` → **409 while pending**, otherwise a **binary download** (`findings:74`).

**`poll()` — specified for async mode, undefined for sync jobs** (sync jobs never enter a poll cycle):

| Situation | `PollOutcome` |
|---|---|
| `GET /v1/jobs/{id}` → pending/unknown-but-not-terminal | `{ state: "pending" }` |
| result endpoint → **409** | `{ state: "pending" }` (fold the fetch into `poll()`, C4 pattern `design:219`) |
| `status: succeeded` + result bytes fetched | `{ state: "done", … }` — see contract gap below |
| `status: failed` | `{ state: "error", error }` |

> **Contract gap to settle before implementation (flagged for the orchestrator):** `PollOutcome.done` carries only `mediaUrls` (`design:120-123`), but the async job result is a **binary download** behind account-scoped auth (not fetchable by bare `mirrorToR2`). Two options: (1) **extend `PollOutcome.done` with an optional `buffers` field** — `settleJob`'s `done` outcome *already* accepts `buffers` (`design:200`), so this is a one-field type change with zero funnel changes; or (2) keep async mode restricted to cases where a fetchable hosted URL exists (not documented for the jobs API). **Recommendation: (1).** This is the only contract change surfaced by these four backends; everything else fits `SubmitOutcome`/`PollOutcome` as pinned.

**`checkReadiness`:** api key non-empty — `provider_configs('pollinations').api_key → POLLINATIONS_API_KEY` (`design:151` class). Key is mandatory for all generation even though `GET /image/models` / `GET /video/models` are public (`findings:68,76`); no binding-dependent config.

**paramMap** (`findings:82`):

| HeliosGen field | Pollinations field | Notes |
|---|---|---|
| `prompt` | URL path segment (encoded) for `GET /…/{prompt}`; `prompt` body for `POST /v1/images/generations` | **URL-encoding required**; long prompts → prefer POST/async (caveats) |
| `customWidth` / `customHeight` | `width` / `height` (px) | `findings:82` |
| `aspectRatio` | *(none)* | only derivable via width/height (`findings:82`) |
| `seed` | `seed` | `findings:82` |
| `duration` (video) | `duration` | must be in the model's `allowed_durations` (from `GET /video/models`) (`findings:72,76`) |
| media: `references[0]` / `startFrame` | `image` (URL param) | `imageUrls[0] ← image` (`findings:82`); chat `image_url` parts act as reference/start-frame images (`findings:70,72`) |
| `resolution` | *(none)* | per-model `resolutions` catalog field constrains width/height choices (`findings:76`) |
| `quality`, `mode`, `sound` | *(none documented)* | not in the playground/APIDOCS param table (`findings:70,88`) |
| `negativePrompt` | *(none)* | `findings:82` |
| `model` | `model` | `publisher/model` |
| extras | `nologo`, `enhance`, `private` | provider-specific; not part of `params` (`findings:70`) |

**provider_meta example** (`findings:84`; URLs fully resolved per `design:129`):

```json
{
  "upstreamTaskId": "job-7f3c…",
  "family": "standard",
  "statusUrl": "https://gen.pollinations.ai/v1/jobs/job-7f3c…",
  "responseUrl": "https://gen.pollinations.ai/v1/jobs/job-7f3c…/result",
  "upstreamModelId": "publisher/model"
}
```

Sync variant: `{ "upstreamTaskId": null, "family": "standard", "statusUrl": null, "responseUrl": null, "upstreamModelId": "publisher/model" }` (same null-form note as §1.1).

**Suggested initial logical-model bindings:**
- **Modality: image + video** (`findings:70,72`).
- **Video (best fit — example ids in the docs):** `veo3_fast` ↔ `veo-3.1-fast`, `seedance-2` (and possibly `seedance-2-fast`) ↔ `seedance-2.0`, `kling-3.0` / `kling-3.0-turbo` ↔ `kling-v3.0-std`, `minimax-h3` ↔ `minimax-h3`, `grok-imagine` ↔ `grok-imagine-video` (`findings:72`). **All ids unverified** — confirm against live `GET /video/models` (also read `allowed_durations`/`max_duration`/`min_duration` and `max_reference_images`) (`findings:76`). `wan-3.0` has no catalog counterpart → no binding.
- **Image:** no 1:1 match documented (the only example is `black-forest-labs/flux.1-schnell`, `findings:70`, which has no catalog counterpart). Check `GET /image/models` for slugs matching the nano-banana / gpt-image / grok-imagine image families; bind only confirmed matches. Until then: **no initial image bindings** (video-only tranch first).
- `family: "standard"`; static paramMap rows above; `duration` validation against `allowed_durations` should live in `checkReadiness`/submit validation or the binding, since a bad duration is rejected upstream.

**Caveats (`findings:130`):**
- **Prompt-in-URL:** the primary image/video shape puts the prompt in the path → requires URL-encoding and **caps URL length for long prompts**. Spec: for prompts above a conservative threshold (or when `Prefer` async is on), **prefer `POST /v1/images/generations` (sync) or the async `Prefer: respond-async` path**; never truncate.
- **Async job records expire after 24h** — well beyond the 12m poll deadline; irrelevant to normal flow but relevant to resume-after-outage expectations (`findings:74`).
- The `/v1/images/generations` compat route exists but **lacks video and the async path**, so a generic openai-compat binding can't cover the catalog → **dedicated adapter** (`findings:86`).
- Rate limits are per-model (`per_user_rpm`, `resolutions`, duration bounds) — read live from the model catalogs, don't hardcode (`findings:76`).

**Sources (verbatim from `findings:88`):** https://gen.pollinations.ai/docs (full page fetched; async-jobs + media-storage sections), https://gen.pollinations.ai/openapi.json (partial; account endpoints), https://pollinations.ai/docs playground (width/height/seed UI), https://github.com/pollinations/pollinations/blob/master/APIDOCS.md (`width/height/seed/nologo/enhance/private` table).

---

### 1.4 `huggingface` — Hugging Face Inference Providers

- **What it is:** a router over third-party providers (fal-ai, Replicate, Novita, Together, WaveSpeedAI…) behind one HF token. The OpenAI-compat endpoint (`https://router.huggingface.co/v1/chat/completions`) is **chat-only** — "For other tasks like text-to-image… use the Hugging Face inference clients." **No single documented REST contract** for image/video; the client library maps task → per-provider route and payload (`findings:94`).
- **Base URLs:** `https://router.huggingface.co` (chat-compat `/v1`; client routes are per-provider, e.g. `https://router.huggingface.co/hf-inference/models/{model}` for dedicated endpoints; the fal helper is queue-based at `https://queue.fal.run`) (`findings:96`).
- **Auth:** `Authorization: Bearer $HF_TOKEN` — fine-grained token with ***Make calls to Inference Providers*** permission — or a third-party provider key for direct requests. Env key **`HF_TOKEN`** (`findings:98`).
- **mediaStaging:** **`local-file`** (provider-level default). Why: image refs for `imageToImage`/`imageTextToVideo` are passed as **blobs/data to the client**, which encodes them into each provider's payload — **there is no provider-side upload URL to stage against** (`findings:108`). (The `>25MB` data-url staging limit doesn't apply, but blob buffering does.) No `uploadMedia` hook.

**Submit semantics — sync from the caller's perspective** (`findings:100-106`):
- JS client calls: `client.textToImage({ model, inputs, parameters?, provider? })` (JS key is `inputs`; Python is `prompt=` — a paramMap must pin one), `client.textToVideo` / `client.imageToVideo` / `client.imageTextToVideo` (docs' recommended i2v model: `Lightricks/LTX-Video`). Provider targeting: `provider: "auto" | "fal-ai" | "replicate" | …` or `model:suffix` (`:fastest` / `:cheapest`) (`findings:100,102`).
- **Response: raw `Blob`/bytes — never a URL** (`findings:100,106`).
- The client internally absorbs async providers — fal queue (`{ video: { url } }` result → fetched to blob), Novita (`response.task_id` → client-side poll), Together/Replicate async tasks — all inside `providerHelper.getResponse()` (`findings:102`).
- Status vocabulary: **none exposed** — one awaited call; no job id, no status URL, no cancel in the public API (`findings:104`).
- `SubmitOutcome`: `{ mode: "sync", mediaUrls: [], rawBuffers: [{ buffer: await blob.arrayBuffer(), mimeType }] }` → `settleJob` mirrors buffers (`design:205`).

**`poll()`: explicitly undefined** — sync adapter (`findings:112`). All upstream polling happens *inside* the client call.

**`checkReadiness`:** `HF_TOKEN` resolves non-empty (DB → env, `design:151` class). Presence-only, offline — the permission check ("Make calls to Inference Providers") can't be verified without a network call, and `checkReadiness` branches are all local (`design:143-153`). Optionally document the permission requirement in the Settings UI reason text.

**paramMap** (`findings:110`):

| HeliosGen field | Hugging Face field | Notes |
|---|---|---|
| `prompt` | `inputs` (JS client key) | **pin the JS name**; Python uses `prompt` (`findings:110`) |
| `model` | `model` (Hub repo id) | from `binding.upstreamModelId` — **Hub repo id, not provider-native id** (`findings:110`) |
| `seed`, size/step-ish fields | `parameters` (provider-specific) | **weak normalization** (`findings:110`) |
| `resolution` / `customWidth`/`customHeight` | `parameters` (provider-specific, if supported) | not first-class; drop when unsupported |
| `aspectRatio` | *(none)* | not first-class (`findings:110`) |
| `duration` | provider `parameters` (if supported) | undocumented per provider — drop silently or validate per model |
| `quality`, `mode`, `sound`, `negativePrompt` | *(none)* | not documented |
| media: `references`/`startFrame` | blob args to `imageToImage` / `imageToVideo` / `imageTextToVideo` | client encodes them (`findings:102,108`) |
| provider routing | `provider` or `model:suffix` | `auto` default (`findings:100`) |

**provider_meta example** (`findings:112`):

```json
{
  "upstreamTaskId": null,
  "family": "standard",
  "statusUrl": null,
  "responseUrl": null,
  "upstreamModelId": "repo-id:provider-suffix"
}
```

**Suggested initial logical-model bindings:**
- **Modality: image + video, but every slug is a Hub repo id that must be looked up** — the findings' only concrete examples (`black-forest-labs/FLUX.1-dev` for t2i, `Lightricks/LTX-Video` for i2v, `findings:100,102`) have **no catalog counterparts**, so neither yields an initial binding.
- **Image candidates:** the 11 catalog image models *if* a matching Hub repo resolves on the router (nano-banana / gpt-image / seedream families — verify via the Hub + `GET`-style model listing on huggingface.co). Bind t2i-only unless the repo's `input_modalities` include image input.
- **Video candidates:** prefer i2v-capable catalog models — `kling-3.0-turbo`, `grok-imagine`, `minimax-h3` (they carry `imageApiId` slots, `lib/modelConfig.ts:655,681,938`) — via `imageToVideo`/`imageTextToVideo`, **only** where a router-backed repo exists. T2v-only models (Veo trio, seedance family) are unlikely to resolve; skip unless discovery shows otherwise.
- **Capability caveat before binding:** weak param normalization (§paramMap) means `duration`/`quality`/`aspectRatio` may be silently dropped — don't bind models whose UX depends on them until the repo's `parameters` are known.
- `family: "standard"`; static paramMap rows (fixed, not per-model).

**Caveats (`findings:114,130`):**
- **Client-library dependency:** adapter wraps **`@huggingface/inference`** as a **server-side dependency** — not an openai-compat binding (chat-compat is chat-only) and not raw HTTP, because the per-provider poll/fetch logic is exactly what we'd otherwise reimplement for fal/Replicate/Novita/Together (`findings:114`). Adding the package is part of this adapter's implementation task.
- **Sync-only, no recovery:** there is no recoverable `upstreamTaskId`, so a crashed in-process HF job can only settle `error` on restart — consistent with design.md §6's openai-compat hedge (`findings:130`; resume path `design:225`). No poll ⇒ nothing to restart.
- Output is bytes only ⇒ **everything** flows through `settleJob`'s buffer-mirroring branch (`design:205`).

**Sources (verbatim from `findings:116`):** https://huggingface.co/docs/inference-providers (index; auth, chat-only limitation, task list), https://github.com/huggingface/huggingface.js/blob/main/packages/inference/README.md (client examples, provider param, blob outputs), https://github.com/huggingface/huggingface.js/blob/main/packages/inference/src/lib/getProviderHelper.ts and `src/providers/{fal-ai,replicate,novita,together}.ts` (per-provider async absorption, exact result shapes).

---

## 2. Cross-cutting comparison

Reproduced from the findings' summary (`findings:120-128`), with adapter ids and readiness:

| | `openrouter` | `spicyapi` | `pollinations` | `huggingface` |
|---|---|---|---|---|
| label | OpenRouter | SpicyAPI | Pollinations | Hugging Face |
| base URL | `https://openrouter.ai/api/v1` | `https://api.spicyapi.ai/api/v1` | `https://gen.pollinations.ai` | `https://router.huggingface.co` |
| env key | `OPENROUTER_API_KEY` | `SPICY_API_KEY` | `POLLINATIONS_API_KEY` | `HF_TOKEN` |
| submit mode | sync | async (202 + taskId) | sync binary **or** async via `Prefer: respond-async` | sync (client hides polling) |
| `poll()` | — (undefined) | `recordInfo` @ 3s: `queued/running/succeeded/failed/expired` | `GET /v1/jobs/{id}` → `succeeded/failed` (+ result fetch, 409 while pending) | — (undefined) |
| output | b64 inline (`data[].b64_json`) | presigned URL (**~20 min!**) | bytes / b64 / hosted URL | blob bytes |
| mediaStaging | `data-url` | `remote-url` (**upload spike open**) | `remote-url` (media.pollinations.ai/upload) | `local-file` |
| `uploadMedia` | none | pending OpenAPI spike | `POST https://media.pollinations.ai/upload` | none |
| adapter scope | dedicated (thin, sync) | dedicated (Kie-family reuse) | dedicated | dedicated (client wrapper) |
| checkReadiness | key present | key present | key present | token present (offline; permission hint in UI) |
| crash-resume | settle `error` (no poll) | resume polling via `statusUrl` | resume polling (async jobs) / `error` (sync) | settle `error` (no recoverable id) |

**Key risks carried into implementation (`findings:130`):** SpicyAPI asset URLs expire in ~20 min → `settleJob` must mirror immediately (it already does) and `resumeJob` after a long outage may find dead links; SpicyAPI envelope `code:200` on failed tasks (branch on `data.state`); Pollinations GET path requires URL-encoding the prompt and caps URL length for long prompts (prefer `POST /v1/images/generations` or async mode for long prompts); HF has no recoverable `upstreamTaskId`, so a crashed in-process HF job can only settle `error` — consistent with design.md §6's openai-compat hedge.

---

## 3. Implementation order & per-adapter validation

### 3.1 Recommended order (easiest-first)

1. **`openrouter` — first.** Smallest surface that still exercises the whole contract end-to-end: one sync POST, **no `poll()`**, no upload hook (`data-url` staging), a single fixed paramMap, `b64_json → rawBuffers` proving the `settleJob` buffer-mirroring branch (`design:205`). Nothing here can block on an open spike, and readiness/env/row plumbing (§4) gets proven with the least risk. *Rationale: `findings:29` — "dedicated thin adapter (sync-only, ~small)".*
2. **`pollinations` — second.** No per-model schema machinery, one key, and a built-in difficulty ramp: ship **sync mode first** (zero job machinery), then switch on `Prefer: respond-async` — the **first of the new adapters to exercise `poll()` + `meta.statusUrl`/`responseUrl`** with a trivial two-value vocabulary (`succeeded|failed`) and a 409-while-pending result fetch, i.e. exactly the fal C4 pattern already pinned (`design:219`). Also validates `remote-url` staging with a *known* upload endpoint (`findings:80`). Resolve the `PollOutcome.done.buffers` gap (§1.3) before the async step.
3. **`spicyapi` — third.** Structurally a **second consumer of the Kie-family payload/status machinery** (`findings:58`), so it's cheap *once the Phase 4 Kie adapter exists* — but it is async-only (no sync fallback), carries three hostile semantics (20-min URLs, `code:200`-on-failure, `pending` assets), and is gated by the **media-upload open spike** against `https://docs.spicyapi.ai/openapi.yaml` (`findings:50`). Run the spike as a pre-step of this phase; if it stalls, do #4 first (it's independent) and keep SpicyAPI's remote-URL-only first pass.
4. **`huggingface` — last.** Adds a **new runtime dependency** (`@huggingface/inference`, `findings:114`), has the weakest param normalization (drops `aspectRatio`/`duration` silently), is sync-only with **no crash recovery** (worth least contract coverage per unit of risk), and its image coverage largely overlaps #1/#2. Its unique value — per-provider async absorption for fal/Replicate/Novita/Together (`findings:102`) — is only worth taking once the core funnel is proven by the previous three.

Ordering principle: sync adapters before async (contract simplicity), async-with-clean-API before async-with-hostile-semantics, spike-gated work isolated, dependency-adding/out-of-contract work last.

### 3.2 Per-adapter validation — smoke tests through `{taskId}` → job-status / job-stream

**Shared harness (applies to all four):**
1. Configure the credential (§4) → `GET /api/settings/providers` shows the new provider with `keySource: "db"|"env"` and `ready: true`; remove it → `ready: false` with a reason. Readiness must match `checkReadiness` (`design:143-153`).
2. `POST /api/generate` (image) or `POST /api/generate-video` with `providerId` set → **200 `{ taskId }`**, where `taskId = "${provider.id}-${Date.now()}-${rand8}"` (uniform pre-mint, `design:184`) — **never** the upstream id.
3. Immediately `GET /api/job-status?taskId=…` → `pending`, with `provider_id` already persisted (row exists *before* the upstream call, `design:184`).
4. Drive to completion: image path polls `/api/job-status` every 3s (client behavior, `report:25`); video path subscribes `GET /api/job-stream` and expects the `job:${taskId}` SSE event (25s heartbeat, 12-min cap, `report:28`).
5. On `done`: assert media mirrored under `/generated/...`, `generations.image_url|video_url` updated, `generations.provider_meta` matches the pinned JSON shape (`design:186-190`), `jobStore` updated, SSE emitted (no 12-min hang — the O1 bug), registry entries released (`design:210`).
6. Restart-resume check: async adapters with `upstreamTaskId` + `statusUrl` → `resumeJob` restarts polling (`design:225`); sync adapters (no upstream id) → settle `error`, never stuck `pending`.

**Per adapter:**
- **`openrouter`:** step 2 returns within one request (sync) — `/api/job-status` shows `done` on the first or second 3s tick with a mirrored PNG/JPEG; `provider_meta.upstreamModelId` equals the slug sent; negative case: malformed/unknown model → upstream 502 surfaces as `error` with a message, job not stuck (`findings:19`).
- **`pollinations`:** *sync leg* — same as OpenRouter, media mirrored from URL or buffer. *Async leg* — assert 202 `{ id }`, job `pending` while `GET /v1/jobs/{id}` isn't terminal, result endpoint **409 → still pending** (not `error`), `succeeded` → result fetched with credentials → `done`; `failed` → `error`. Long-prompt case: encode-heavy prompt (> URL budget) routed via POST/async still completes without truncation (`findings:130`).
- **`spicyapi`:** assert enqueue 202 + `data.taskId` → `upstreamTaskId`; poll sequence `queued → running → succeeded` at 3s; **failure with envelope `code:200` settles `error` from `data.state`** (`findings:45`); an asset with `pending: true` is retried as `pending`, then settles `done`; the asset URL is mirrored **immediately** (spot-check the file exists locally even if the presigned URL would expire ~20 min later, `findings:48`); unknown input field → 400 → `error` with the upstream message (proves per-model `paramMap` discipline, `findings:45`).
- **`huggingface`:** sync blob → buffers → mirrored bytes; confirm no `poll()`/`statusUrl` (meta nulls) and that a **kill-server-mid-job then restart** settles `error` ("Server restarted while local job was in progress" class) rather than hanging pending (`design:225`, `findings:130`); i2v case passes a local `startFrame` through `local-file` staging and still returns bytes.

---

## 4. Credential / store additions

### 4.1 `provider_configs` rows + env fallbacks

`provider_configs(provider_id PK, api_key, base_url, extra_json, updated_at)` (`design:236-245`) gains one row per new provider (auto-created by the `PUT` upsert — rows are not required ahead of time):

| `provider_id` | env fallback (`api_key`) | `base_url` default (overridable) | `extra_json` |
|---|---|---|---|
| `openrouter` | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` | *(unused — reserved)* |
| `spicyapi` | `SPICY_API_KEY` | `https://api.spicyapi.ai/api/v1` | *(unused — reserved; text-compat base never set here)* |
| `pollinations` | `POLLINATIONS_API_KEY` | `https://gen.pollinations.ai` | *(unused — reserved; media store `https://media.pollinations.ai` is fixed)* |
| `huggingface` | `HF_TOKEN` | `https://router.huggingface.co` | *(unused — reserved; optional default `provider` routing later)* |

Extend `getProviderRuntimeConfig(providerId)` (`design:269-276`) with the same DB-first-then-env chain:

- `openrouter`: `DB` → `process.env.OPENROUTER_API_KEY`
- `spicyapi`: `DB` → `process.env.SPICY_API_KEY`
- `pollinations`: `DB` → `process.env.POLLINATIONS_API_KEY`
- `huggingface`: `DB` → `process.env.HF_TOKEN`

Notes: reject placeholder values the way the existing chain does (`design:270`); **OpenRouter deliberately does not share `OPENAI_API_KEY`/`openai-compat`** (`findings:11`); no legacy `settings` rows exist for these four, so **no C7a one-shot migration applies** (`design:264-267`) and no legacy key routes wrap them (`design:304`).

### 4.2 `/api/settings/providers` readiness entries

The `GET` contract (`design:280-299`) extends `providers` with the four ids — each entry carries `id`, `label`, `hasKey`, `keySource: "db"|"env"|"none"` (no `"cli"` for these four), `baseUrl` (the resolved base URL above), `deployments: {}` (Azure-only field, empty here), and `ready` computed from the adapter's `checkReadiness` (`design:153`). `PUT /api/settings/providers` upserts `{ providerId, apiKey?, baseUrl? }` for them like any other provider (`design:300-301`); `DELETE ?providerId=` clears the key (`design:302-303`).

`bindingsByModel: Record<modelId, ProviderId[]>` (`design:295`, C8 `report:87`) will gain the new provider ids for every model with a static binding in `lib/providers/bindings.ts` — **this is the client's only signal** to render the ProviderToggle at ≥2. New bindings are code (C1), not `model_bindings` rows; rows appear only when a user makes one of them the active provider.

### 4.3 Settings UI notes per provider

(No layout/styling work here — just data and copy inputs for `@designer`/implementation.)

- **OpenRouter:** key field labeled "OpenRouter API key" with hint *"`OPENROUTER_API_KEY` — image generation only; not your OpenAI key"* (`findings:11,17`). Because it binds **image models only**, the ProviderToggle should only surface on bound image models (via `bindingsByModel`), never on video models — no `deployments`/endpoint inputs (unlike Azure, `design:290`).
- **SpicyAPI:** key field hint *"`sk-spicy-…` bearer key"* (`findings:41`). Two user-facing caveats worth surfacing as `reason`/tooltip text until resolved: reference-image **upload is an open spike** (remote URLs only at first, `findings:50`) and model params are per-model `inputSchema` (unsupported combos fail with upstream 400). No webhook/callback config — `callBackUrl` is deliberately ignored (`findings:44`).
- **Pollinations:** key field hint *"`sk_…` from enter.pollinations.ai — required for all generation; model lists are public"* (`findings:68`). Long-prompt handling (POST/async switch) is **server-side** — no UI toggle needed. Per-model rate/duration limits come from live catalogs, not user config (`findings:76`).
- **Hugging Face:** key field hint *"Fine-grained `HF_TOKEN` with **Make calls to Inference Providers** permission"* (`findings:98`) — the permission can't be checked offline, so a failed first generation (auth 401/403 → `error` with the upstream message) is the user's feedback loop; put the permission name in the reason text. Optional later: a provider-routing preference (`auto` vs pinned provider) in `extra_json` (`findings:100`).
- **Cross-cutting UI readiness:** `store.providerStatus` + `modelProviders` + `isModelReady(modelId, providerId?)` replace the `kieKeySet` kill-switch at `GenerateNode:1435`, `VideoGeneratorNode:1993`, `gallery:1787,2201` (`report:88`, `design:306-314`); `KieBanner` shows only when **zero** providers are ready (`design:311`) — with these four added, the banner text "No generation provider configured — add an API key in Settings" covers them automatically. `store.kieKeySet` stays derived for chat compatibility (`design:308`). Keys travel only via `PUT /api/settings/providers` — never `localStorage` (C7c boundary, `design:328`).

---

**Validation note for this document:** spec-only; no code was written or executed. Claims are traceable to `.slim/starter-providers-findings.md`, `docs/provider-refactor.md` (a)/(c), and `.slim/deepwork/provider-refactor-plan/design.md` §1.3/§2/§3. One contract gap is flagged for decision (§1.3: `PollOutcome.done.buffers` for Pollinations async binary results); one open spike is carried forward (§1.2: SpicyAPI media upload via `openapi.yaml`).

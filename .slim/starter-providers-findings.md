# Four Starter Generation Backends — Research Findings for HeliosGen

Contract context applied throughout: `GenerationProvider` (`submit`/`poll`/`checkReadiness`/`uploadMedia`), submit mode sync-vs-async decided *by submit's outcome*, `provider_meta {upstreamTaskId, family, statusUrl, responseUrl?, upstreamModelId}`, `PollOutcome = pending|done|error` (no new states), mediaStaging resolution `binding.mediaStagingByOperation[op] → binding.mediaStaging → provider.mediaStaging` with already-remote `https://` inputs passing through unchanged.

---

## 1. OpenRouter

**Base URL:** `https://openrouter.ai/api/v1` (image discovery: `GET /api/v1/images/models`, per-endpoint caps: `GET /api/v1/images/models/{model}/endpoints`).

**Auth:** `Authorization: Bearer $OPENROUTER_API_KEY` → suggested env key **`OPENROUTER_API_KEY`** (note: distinct from the design's `openai-compat → OPENAI_API_KEY` row; OpenRouter needs its own `provider_id`).

**Image endpoint — `POST /api/v1/images`** (OpenAI-Images-*like*, not identical). Request fields (from the API guide's parameter table): `model`, `prompt`, `n` (≤10), `resolution` (`512|768|1K|1.5K|2K|4K`), `aspect_ratio` (`1:1`…`21:9`, `auto`), `size` (tier or `"2048x2048"` shorthand), `quality` (`auto|low|medium|high`), `output_format` (`png|jpeg|webp|svg`), `background` (`auto|transparent|opaque`), `output_compression` (0–100), `seed`, `stream` (bool), `input_references[]`, `user`, plus `provider` routing object (`only`/`order`/`ignore`/`sort`/`allow_fallbacks`, and `provider.options.<provider-slug>` passthrough like `steps`/`guidance` gated by `allowed_passthrough_parameters`). No negative-prompt field (passthrough only, per provider). Response: `{ created, data: [{ b64_json, media_type }], usage: { prompt_tokens, completion_tokens, total_tokens, cost } }`.

**Reference images:** `input_references: [{ type: "image_url", image_url: { url } }]` — HTTP(S) URLs **or base64 data URLs**; count varies by provider (`architecture.input_modalities`).

**Video:** none. OpenRouter is image + text only.

**Execution mode:** **sync only** — full JSON in the POST response; optional SSE streaming (`image_generation.partial_image` / `image_generation.completed` / `error`, ends `data: [DONE]`). No job id, no poll, no cancel. Failed generations → `502`, no charge.

**Output media shape:** base64 inline (`data[].b64_json`), no hosted URL.

**mediaStaging:** **`data-url`** — reference images accept data URLs inline and there is no upload API; remote `https://` refs pass through per the existing rule.

**paramMap notes:** `prompt ← prompt`; `aspectRatio ← aspect_ratio`; `customWidth/customHeight → size ("WxH")`; `quality ← quality` (matches Azure-style `azureQualityOptions` vocabulary); `seed ← seed`; steps/guidance only via `provider.options`. No negative prompt.

**provider_meta:** `{ upstreamTaskId: null (sync), family: "standard", statusUrl: null, responseUrl: null, upstreamModelId: model }`.

**Verdict:** **Dedicated thin adapter** (sync-only, ~small). It's OpenAI-*flavored* (`b64_json`, `usage`) but the path is `/images` (not `/v1/images/generations`), and `aspect_ratio`/`resolution`/`input_references` are OpenRouter-specific — a generic openai-compat binding would need path + schema overrides it doesn't have. `checkReadiness`: env/DB key present.

**Sources:** https://openrouter.ai/docs/guides/overview/multimodal/image-generation.md (redirect target of `/docs/features/multimodal/image-generation`; `https://openrouter.ai/docs/api-reference` itself 404s on fetch).

---

## 2. SpicyAPI

**What it is:** a Kie-style model aggregator with an **async task queue** (image + video), plus OpenAI/Anthropic/Gemini-compat **text** endpoints. Model ids are `publisher/model/task`; each model's accepted input fields are defined by its `inputSchema` (`GET /api/v1/models/{id}`, public catalog `https://api.spicyapi.ai/console/v1/catalog/models`).

**Base URLs:** native `https://api.spicyapi.ai/api/v1`; text-compat `https://api.spicyapi.ai/v1/...`.

**Auth:** `Authorization: Bearer sk-spicy-…` (bearer-only on `/api/v1/*`) → suggested env key **`SPICY_API_KEY`**.

**Image + video endpoints (same queue, modality via model):**
- Submit: `POST /api/v1/jobs/createTask` `{"model": "publisher/model/task", "input": {"prompt": …}}` → HTTP **202** `{ code: 200, msg, data: { taskId, state: "queued", estimatedCost, deadlineAt } }`. Optional `Idempotency-Key` (24h); reuse with different payload → `409`. Optional `callBackUrl` webhook — ignore (no public ingress per no-touch list).
- Poll: `GET /api/v1/jobs/recordInfo?taskId=…` → `data.state`: `queued → running → succeeded | failed | expired` (terminal: `errorCode`, `errorMessage`, `cost`, `settled`, `completedAt`). Envelope `code` stays 200 even on task failure — must read `data.state`. One unknown input field = 400.
- Free quote: `POST /api/v1/jobs/quote`. **No cancel** ("tasks cannot be cancelled once accepted").

**Result/output shape:** hosted pre-signed URLs — `data.output.assets[]: { key, url, expiresAt, mime, width, height, bytes, pending? }`. Links expire ~**20 min** (re-read `recordInfo` for fresh link), files retained ~14 days, download **without** the API key. Assets can briefly show `pending: true` → treat like fal's COMPLETED-then-404: **retry as `pending`, not `error`** (design.md C4 pattern).

**Input media:** `input` is per-model `inputSchema`; reference images supported per model. The Media docs page ("Direct reference uploads and artefact downloads", `https://docs.spicyapi.ai/docs/media`) was **not retrievable** (site serves a truncated `llms-full.txt` corpus for every path); uploaded files are retained ~**1 day**. Exact upload path + reference field name must be pulled from `https://docs.spicyapi.ai/openapi.yaml` (OpenAPI 3.1) at implementation time — flagged as an open spike, same as the kie-veo spike.

**mediaStaging:** **`remote-url`** — refs must be URLs/data in `input` and uploads expire in a day, so mirror immediately; simplest first pass is https pass-through + `uploadMedia` once the upload path is confirmed from the OpenAPI spec.

**paramMap notes:** `prompt ← input.prompt`; size/aspect/steps/seed/negative are **model-specific `inputSchema` fields** — the binding's `paramMap` should be populated per model from `inputSchema.properties` at binding time, not hardcoded.

**provider_meta:** `{ upstreamTaskId: data.taskId, family: "standard", statusUrl: "/api/v1/jobs/recordInfo?taskId=…", responseUrl: null (result arrives on the poll response), upstreamModelId: model }`.

**Verdict:** **Dedicated adapter**, structurally near-identical to the Kie adapter (Kie-style `createTask`/`recordInfo` naming, same envelope philosophy) — implement it as a second consumer of the Kie-family payload/status machinery with a different base URL and `data.state` vocabulary. Not openai-compat for media.

**Sources:** https://docs.spicyapi.ai/ (serves `llms-full.txt`; corpus → https://docs.spicyapi.ai/openapi.yaml, media page https://docs.spicyapi.ai/docs/media).

---

## 3. Pollinations (gen.pollinations.ai)

**Base URL:** `https://gen.pollinations.ai` (+ media store `https://media.pollinations.ai`).

**Auth:** required for all generation — `Authorization: Bearer $POLLINATIONS_API_KEY` **or** `?key=` query param; keys `sk_…` from enter.pollinations.ai (Pollen prepaid; x402 USDC also available) → suggested env key **`POLLINATIONS_API_KEY`**. Model listing needs no auth.

**Image — `GET /image/{prompt}`**: prompt is the URL path; query params (playground + legacy `APIDOCS.md`): `model` (`publisher/model`, e.g. `black-forest-labs/flux.1-schnell`), `width` (px), `height` (px), `seed`, `nologo` (remove watermark), `enhance` (prompt enhancement), `private`, and `image=` for a **reference image URL** (image-to-image / Kontext-style). Returns **binary image bytes** (JPEG/PNG/SVG per model). Also **`POST /v1/images/generations`** (OpenAI-compat; defaults `b64_json`, `response_format: "url"` for a stored media URL); image models also work through `/v1/chat/completions` / `/v1/responses`, returning assistant text with a Markdown image + the URL in the `Link` header (image parts in chat act as reference images).

**Video — `GET /video/{prompt}`**: returns **MP4**; params `model` (veo-3.1-fast, seedance-2.0, kling-v3.0-std, minimax-h3, wan-3.0, grok-imagine-video…), `duration` (`allowed_durations` per model), `image=` start frame; chat `image_url` parts are the start frame for models listing `image` in `input_modalities`.

**Async mode (optional):** add `Prefer: respond-async` to any media route → **202** `{ id }` + `Location` + `Retry-After: 5`; poll **`GET /v1/jobs/{id}`** until `status` is `succeeded | failed`; fetch result **`GET /v1/jobs/{id}/result`** (409 while pending; binary download). Job records expire 24h; identical requests dedupe; only the submitting account can read it. No cancel documented. Without the header, requests are **synchronous binary**.

**Reference images:** `image=` URL param / chat image parts; per-model cap in catalog field `max_reference_images`. **Rate limits:** per-model catalog fields (`per_user_rpm`, `resolutions`, `max_duration`/`min_duration`/`allowed_durations`) — read live from `GET /image/models`, `GET /video/models`.

**Output media shape:** binary bytes (GET), `b64_json` or hosted `media.pollinations.ai` URL (`Link: <…>; rel="enclosure"`, `response_format:"url"`) — your choice.

**mediaStaging:** **`remote-url`** — reference images are passed as URLs, and local files can be uploaded via `POST https://media.pollinations.ai/upload` (multipart/raw/base64, ≤400 MiB, 30-day lifecycle) to get a URL; data-urls in a GET query string are impractical.

**paramMap notes:** `prompt ← path segment (encoded)`; `customWidth/customHeight ← width/height`; `seed ← seed`; aspect only derivable via width/height; negative prompt: none; video `duration ← duration`; refs `imageUrls[0] ← image`.

**provider_meta:** `{ upstreamTaskId: job id (async) | null (sync), family: "standard", statusUrl: "/v1/jobs/{id}", responseUrl: "/v1/jobs/{id}/result", upstreamModelId: model }`.

**Verdict:** **Dedicated adapter** — the primary shape is prompt-in-URL with binary/redirect responses and a non-OpenAI async job API; the `/v1/images/generations` compat route exists but lacks video and the async `Prefer: respond-async` path, so a generic openai-compat binding can't cover the catalog.

**Sources:** https://gen.pollinations.ai/docs (full page fetched; async-jobs + media-storage sections), https://gen.pollinations.ai/openapi.json (partial; account endpoints), https://pollinations.ai/docs playground (width/height/seed UI), https://github.com/pollinations/pollinations/blob/master/APIDOCS.md (`width/height/seed/nologo/enhance/private` table).

---

## 4. Hugging Face Inference Providers

**What it is:** a router over third-party providers (fal-ai, Replicate, Novita, Together, WaveSpeedAI…) behind one HF token. **The OpenAI-compat endpoint (`https://router.huggingface.co/v1/chat/completions`) is chat-only** — "For other tasks like text-to-image… use the Hugging Face inference clients." There is **no single documented REST contract** for image/video; the client library maps task → per-provider route and payload.

**Base URLs:** `https://router.huggingface.co` (chat-compat `/v1`; client routes are per-provider, e.g. `https://router.huggingface.co/hf-inference/models/{model}` for dedicated endpoints; the fal helper is queue-based, `https://queue.fal.run`).

**Auth:** `Authorization: Bearer $HF_TOKEN` (fine-grained token with *Make calls to Inference Providers* permission) — or a third-party provider key for direct requests → suggested env key **`HF_TOKEN`**.

**Image:** `client.textToImage({ model: "black-forest-labs/FLUX.1-dev", inputs: "…" })` (JS key is `inputs`; Python `text_to_image(prompt=…, model=…)`). Extra generation params go via `parameters`/provider-specific payload; provider targeting via `provider: "auto" | "fal-ai" | "replicate" | …` or `model:suffix` (`:fastest`/`:cheapest`). **Response: raw `Blob`/bytes** — never a URL.

**Video:** `client.textToVideo` / `client.imageToVideo` / `client.imageTextToVideo` (recommended i2v model in docs: `Lightricks/LTX-Video`) → **Blob**. The client internally handles **async providers**: fal queue (`{ video: { url } }` result → fetched to blob), Novita (`response.task_id` → client-side poll), Together/Replicate async tasks — all absorbed inside `providerHelper.getResponse()`.

**Execution mode:** **sync from the caller's perspective** — one awaited call, polling hidden inside the client. No exposed job id, status URL, or cancel in the public API.

**Output media shape:** binary bytes only (adapter writes the blob / buffers it for `settleJob` mirroring).

**mediaStaging:** **`local-file`** (or multipart-buffer) — image refs for `imageToImage`/`imageTextToVideo` are passed as blobs/data to the client, which encodes them into each provider's payload; there's no provider-side upload URL to stage against. (Note `>25MB data-url` staging limit doesn't apply, but blob buffering does.)

**paramMap notes:** `prompt ← inputs` (JS) — the field name differs between JS and Python, a paramMap must pin one; `model ← model` (Hub repo id, not provider-native id); size/seed/steps only via provider-specific `parameters` — weak normalization; aspect ratio not first-class.

**provider_meta:** `{ upstreamTaskId: null (hidden by client), family: "standard", statusUrl: null, responseUrl: null, upstreamModelId: "repo-id:provider-suffix" }`. `poll()` undefined — sync adapter.

**Verdict:** **Dedicated adapter wrapping `@huggingface/inference`** as a server-side dependency — not an openai-compat binding (chat-compat is chat-only, image/video REST shapes are per-provider and undocumented) and not raw-HTTP, because the per-provider poll/fetch logic is exactly what you'd otherwise have to reimplement for fal/Replicate/Novita/Together.

**Sources:** https://huggingface.co/docs/inference-providers (index; auth, chat-only limitation, task list), https://github.com/huggingface/huggingface.js/blob/main/packages/inference/README.md (client examples, provider param, blob outputs), https://github.com/huggingface/huggingface.js/blob/main/packages/inference/src/lib/getProviderHelper.ts and `src/providers/{fal-ai,replicate,novita,together}.ts` (per-provider async absorption, exact result shapes).

---

## Cross-cutting summary

| | OpenRouter | SpicyAPI | Pollinations | HF Providers |
|---|---|---|---|---|
| submit mode | sync | async (202+taskId) | sync binary **or** async via `Prefer: respond-async` | sync (client hides polling) |
| `poll()` | — | `recordInfo` 3s interval, `queued/running/succeeded/failed/expired` | `GET /v1/jobs/{id}` → `succeeded/failed` | — |
| output | b64 inline | presigned URL (~20 min!) | bytes / b64 / hosted URL | blob bytes |
| mediaStaging | `data-url` | `remote-url` (upload spike open) | `remote-url` (media.pollinations.ai/upload) | `local-file` |
| adapter scope | dedicated (thin, sync) | dedicated (Kie-family reuse) | dedicated | dedicated (client wrapper) |

**Key risks to carry into the spec:** SpicyAPI asset URLs expire in ~20 min → `settleJob` must mirror immediately (it already does) and `resumeJob` after a long outage may find dead links; SpicyAPI envelope `code:200` on failed tasks (must branch on `data.state`); Pollinations GET path requires URL-encoding the prompt and caps URL length for long prompts (prefer POST `/v1/images/generations` or async mode for long prompts); HF has no recoverable `upstreamTaskId`, so a crashed in-process HF job can only settle `error` — consistent with design.md §6's openai-compat hedge.

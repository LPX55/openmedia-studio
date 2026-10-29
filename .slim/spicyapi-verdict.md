# SpicyAPI verification report — migrate-from-openai / models / media

**Method note:** all three URLs redirect to `https://docs.spicyapi.ai/llms-full.txt` (the full MDX corpus, 1.2 MB). I extracted the canonical sections from that corpus (local page anchors: `docs/migrate-from-openai`, `docs/models`, `docs/media`) and cross-checked the live model catalog via the no-key public endpoint `GET https://api.spicyapi.ai/console/v1/catalog/models` (328 entries, fetched 2026-10-20).

---

## 1. `docs/migrate-from-openai` — what the compat layer covers

Source: https://docs.spicyapi.ai/docs/migrate-from-openai

**Text-only OpenAI compat.** The "three changes" table: base URL `https://api.spicyapi.ai/v1`, key `Authorization: Bearer sk-spicy-…`, model ID ending in `/chat`. Endpoints: `/v1/chat/completions`, `/v1/responses` (plus Anthropic `/v1/messages`, Gemini `/v1beta/models/{model}:generateContent`).

The decisive paragraph ("Endpoints you will not find here"):

> "These OpenAI endpoints do not exist and return `404`: `/v1/embeddings`, the legacy `/v1/completions`, **`/v1/images/*`**, `/v1/audio/*`, `/v1/moderations`, `/v1/files`, `/v1/batches`, `/v1/assistants` and fine-tuning. Image, video and audio models are called through the task API instead, **and videos also through `/v1/videos`**."

**So: there is NO OpenAI image-generation compat at all** — no `/v1/images/generations`, no `/v1/images/edits`. Calling an image/video model on `/v1/chat/completions` returns `400` ("not a chat model").

**Surprise: a video compat surface exists** — the OpenAI **Videos** format (Sora-style, confirmed in https://docs.spicyapi.ai/docs/quotes-and-compatibility#text-and-video-compatibility):

> "**Videos** accepts JSON with `model`, `prompt`, `input_reference`, `seconds` and `size`, which are mapped to the model's own fields. The returned video `id` is also a task id that `recordInfo` accepts. Its content endpoint redirects with HTTP `302` to a short-lived signed URL."

Endpoints (https://docs.spicyapi.ai/docs/api-reference#compatibility-endpoints):

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/videos` | create; supports `Idempotency-Key` (replay → original task) |
| `GET` | `/v1/videos/{videoId}` | status poll |
| `GET` | `/v1/videos/{videoId}/content` | `302` → short-lived signed URL |

Caveats for that path: **priced at acceptance** — `quoteId`/`expectedCost` are rejected on `/v1` (native `jobs/createTask` only); reference media goes through `input_reference` only (single field vs. the native schemas' richer multi-reference fields); errors use the OpenAI error envelope, not `{code,msg,data}`.

---

## 2. `docs/models` — catalog & schemas

Source: https://docs.spicyapi.ai/docs/models

- **No static model IDs are published anywhere in the docs** — deliberately ("Do not copy an ID from a static page"). `createTask.model` takes the exact `model` string from the authenticated `GET /api/v1/models` (or the no-key public `console/v1/catalog/models` for evaluation). Form: `publisher/model/task`.
- Per-model input: `inputSchema` = **JSON Schema 2020-12** with `x-ui` extensions; a file field is marked `x-ui.widget: upload` (single) or `multi-upload` (array); `x-ui.accept` lists MIME types; `x-ui.max_size_mb` the per-model cap. `GET /api/v1/models/{model}` also returns server-validated `examples` you can submit as-is. No "OpenAI-compat aliases" exist for media models — compat endpoints only accept chat models (text ends in `/chat`).
- Canonical unified field names across models (from `docs/guide-image-generation` + `docs/schema`): `prompt`; `image_url` (single ref), `image_urls` (edit subject array), `reference_image_urls` (guidance refs, appears even on some text-to-image endpoints), `video_url` / `audio_url`, `duration_seconds`, `keyframe_image_urls`, `last_image_url`. Values: public HTTPS URL or committed `spicy://` URI.

Live catalog IDs pulled today (volatile per the docs' own warning):

| HeliosGen family | SpicyAPI model IDs (live catalog, 2026-10-20) |
|---|---|
| **nano-banana** | `google/nano-banana-2.1/text-to-image`, `google/nano-banana-2.1/edit`, `google/nano-banana-2/{text-to-image,edit}`, `google/nano-banana-pro/{text-to-image,edit}`. Edit schema: `prompt*`, `image_urls` (array, multi-upload, required), `aspect_ratio`, `resolution`, `output_format` |
| **seedream** | `bytedance/seedream-5.0-pro/{text-to-image,edit,layer-decomposition}`, `…-5.0-flash/…`, `…-5.0-lite/…`, `bytedance/seedream-4.0/{text-to-image,edit}`. 5.0-pro t2i: `prompt*`, `resolution`, `aspect_ratio`, `output_format`, `enable_thinking` (no ref field on t2i; refs on `/edit`) |
| **kling** | `kling/4.0/{text-to-video,image-to-video,reference-to-video}`, `kling/o3/…` (+`video-edit`), `kling/3.0/…` (+`character-animation`), `kling/avatar-2.0/talking-avatar`, `2.6`, `2.5-turbo`, `2.1-master`, `2.1`. `kling/4.0/image-to-video`: `image_url*` (upload), `keyframe_image_urls`, `last_image_url`, `prompt`, `duration_seconds`, `aspect_ratio`, `resolution` |
| **veo** | ❌ **not in the live catalog** (zero matches for `veo`) |
| **minimax (video)** | `minimax/h3`, `h3-max`, `h3-spicy`, `h3-lora`, `h3-singularity-lora`, `h3-360-orbit` — each with `{text-to-video,image-to-video,reference-to-video,video-extend}` variants |
| **minimax (image)** | `minimax/h3-image-lora/{text-to-image,edit}` |
| **grok** | Text/audio only: `xai/grok-4.7/chat`, `grok-4.6`, `grok-4.5`, `grok-4.3`, `grok-tts`, `grok-stt`. **No grok image model** |
| **gpt-image** | `openai/gpt-image-2/{text-to-image,edit}`, `openai/gpt-image-2.5-sunburst/…`, `openai/gpt-image-2.5-flare/…` (t2i schema: `prompt*`, `quality`, `resolution`, `num_outputs`, `aspect_ratio`, `output_format`, `output_quality`) |
| **z-image** | `alibaba/z-image-spicy-pro/text-to-image`, `z-image-spicy`, `z-image-turbo`, `z-image-base-lora/{text-to-image,edit}`, `z-image-turbo-lora/…` (schema: `prompt*`, `width`, `height`, `seed`, `enable_prompt_expansion`) |

Also present: `bytedance/seedance-{2.5,2.0-fast,2.0-mini}` video family, `alibaba/wan-3.0*` family, `black-forest-labs/flux-3` video tasks, `lightricks/ltx-2.5`.

---

## 3. Media upload path — spike resolved

Source: https://docs.spicyapi.ai/docs/media (+ `docs/api-reference#media-apis`, OpenAPI 3.1 at https://docs.spicyapi.ai/openapi.yaml)

**3-step presigned upload, then a `spicy://` URI into the task input:**

1. **Ticket** — `POST https://api.spicyapi.ai/api/v1/common/upload-url` (Bearer auth), body `{contentType, bytes}` → `{data: {fileId, key, uploadUrl, method:"PUT", headers, expiresAt, maxBytes}}`. Ticket valid ~20 min. Allowlist: images ≤10 MiB (jpeg/png/webp/gif), audio/video ≤90 MiB / 600 s (wav, mp3, webm, mp4, quicktime→mp4), `.safetensors` LoRA ≤2 GiB.
2. **PUT** the bytes to the presigned R2 `uploadUrl` with **all ticket `headers` verbatim** (`Content-Type` + `Content-Length` are signed); **no `Authorization` header** on this request.
3. **Commit** — `POST /api/v1/files/{fileId}/commit` (Bearer) → `{status:"ready", sha256, uri:"spicy://f/fil_…", expiresAt}`. Uploaded URI retained **1 day**.

**Reference field name for generation input:** the field comes from each model's `inputSchema` (widget `upload`/`multi-upload`) — canonical names are `image_url`, `image_urls`, `reference_image_urls`, `video_url`, `audio_url` — and the value is the **`data.uri`** (`spicy://f/…`, or `spicy://a/…` for the persistent asset library via `POST /api/v1/assets`). Example: `{"model": …, "input": {"prompt": "…", "image_url": "spicy://f/fil_…", "duration_seconds": 5}}`. Alternatives: public HTTPS URL passed directly in the media field (must serve the file itself, else `invalid_asset`), or inline `data:image/png;base64,…` for ≤1 MiB decoded images (body ≤2 MiB, ≤16 images). Optional result download refresh: `POST /api/v1/common/download-url`.

---

## Verdict

**(B) — dedicated task-API (kie-family) adapter is required; the compat family covers essentially none of HeliosGen's media surface.** With one narrow exception:

- **Images: compat fails outright.** `/v1/images/*` returns 404; image models 400 on `/v1/chat/completions`. Every image model (nano-banana, seedream, gpt-image, z-image, minimax-h3-image) must go through `POST /api/v1/jobs/createTask` + `GET /api/v1/jobs/recordInfo`, per-model `inputSchema` inputs, and `spicy://`/HTTPS reference handling. This confirms the prior finding: SpicyAPI adapter is a Kie-style async queue with `SPICY_API_KEY`, dedicated scope.
- **Video: same queue contract for the native path** (task IDs `job_…`, states `queued → running → succeeded | failed | expired`, webhook via `callBackUrl` or poll `recordInfo`, result at `data.output.assets[0].url`, ~20-min links). There *is* a partial escape hatch: the OpenAI **Videos**-format endpoints (`POST /v1/videos` with `model/prompt/input_reference/seconds/size`; `GET /v1/videos/{videoId}`; `/content` 302). It could ride a compat binding **only if** HeliosGen's "openai-media-compat" family targets the OpenAI *Videos* API shape (not `chat/completions`, not `images/generations`) — and even then you lose quotes (`quoteId` rejected; priced at acceptance) and the richer multi-reference fields (`keyframe_image_urls`, `last_image_url`, `reference_image_urls` map through `input_reference` only, provider-side). For Kling/H3-class models with first/last-frame and multi-ref inputs, the native task API is strictly better.

**Bottom line:** images — dedicated kie-family adapter, no compat half. Video — dedicated adapter recommended; `/v1/videos` is a viable degraded-compat path only for plain prompt(+single ref)+seconds+size jobs.

**Model-id table:** see §2 above. Two HeliosGen families are unresolvable in the live catalog: **veo** (absent) and **grok image** (absent — grok is text/TTS/STT only). Per the docs' own contract, hard-code none of these: fetch `GET /api/v1/models?includeSchema=1` at runtime and require `enabled && available`.

Sources: [migrate-from-openai](https://docs.spicyapi.ai/docs/migrate-from-openai) · [models](https://docs.spicyapi.ai/docs/models) · [media](https://docs.spicyapi.ai/docs/media) · [api-reference#compatibility-endpoints](https://docs.spicyapi.ai/docs/api-reference#compatibility-endpoints) · [quotes-and-compatibility](https://docs.spicyapi.ai/docs/quotes-and-compatibility) · [live catalog JSON](https://api.spicyapi.ai/console/v1/catalog/models) · [openapi.yaml](https://docs.spicyapi.ai/openapi.yaml)

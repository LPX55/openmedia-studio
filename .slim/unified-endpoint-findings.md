Research complete. Here is the synthesis.

---

# Build-vs-Adopt Research: Single Unified Media-Generation Target for HeliosGen

**Grounding:** current plan (from supermemory + in-repo docs) is P1–P3 committed, P4+P5 TSC-clean awaiting joint landing, plus a 4-adapter starter wave (OpenRouter / SpicyAPI / Pollinations / HF) speced in `docs/provider-adapters-starter.md`. The question: does one binding family exist that replaces N adapters?

---

## Candidates

### 1. fal.ai — hosted aggregator, one queue contract ⭐ strongest

**What/URL:** hosted generative-media platform, 1,000+ image/video/audio/multimodal models behind one queue-based REST API. https://fal.ai, docs https://fal.ai/docs/documentation/model-apis/inference/queue (third-party profile: https://github.com/api-evangelist/fal-ai).

**Unified contract (verified from official docs):**
- Submit: `POST https://queue.fal.run/{model_id}` → `{ request_id, response_url, status_url, cancel_url, queue_position }`
- Poll: `GET …/{owner}/{app}/requests/{request_id}/status` → `status: IN_QUEUE | IN_PROGRESS | COMPLETED` (+`error`/`error_type` on failure)
- Result: `GET …/{owner}/{app}/requests/{request_id}` (model-specific JSON, e.g. `{images:[{url}]}` / `{video:{url}}`)
- Cancel: `PUT …/cancel` (200 removed / 202 signalling / 400 already-completed) — **cancel exists**, unlike kie/SpicyAPI
- Extras: SSE stream (`/status/stream`), webhooks (`?fal_webhook=`), auto-retry on 503/504 (10×)
- Sync variant: `https://fal.run/{model}` for fast models
- Auth: `Authorization: Key $FAL_KEY` — one key

**Reference images:** URLs, base64 data URIs, **or** uploaded files via fal Storage API (`/storage/upload/initiate` → signed upload → CDN URL; JS `fal.storage.upload(blob)`) — exactly HeliosGen's `uploadMedia` hook.

**Coverage:** flagship models per fal's own docs/profile: **FLUX, Veo 3, Kling 2.5, Wan 2.5, Seedream, Nano Banana**, MiniMax H3 (playground) — near-total overlap with HeliosGen's catalog (nano-banana, seedream, veo, kling, minimax-h3, wan). Gap: grok-imagine (xAI models appear on Runware, not confirmed on fal).

**Posture:** hosted only; **fal-billing (prepaid credits)** — you cannot BYOK a Google/ByteDance key. Same lock-in posture as kie today. TS client `@fal-ai/client`, first-class.

**Gaps vs GenerationProvider:** `submit`→queue POST; `poll`→status GET (3-value vocab, trivial); `checkReadiness`→key present; `uploadMedia`→Storage API. `settleJob` must mirror immediately — fal result URLs are served from CDN but not guaranteed permanent (same discipline as SpicyAPI's 20-min rule, already implemented). `provider_meta` = `{upstreamTaskId: request_id, family: "standard", statusUrl: status_url, responseUrl: response_url, upstreamModelId}` — maps 1:1; **crash-resume works** via `status_url`. Remaining work: per-model input/output **schemas as data** (result shape is model-specific) — a schema table, not adapters.

**Verdict: adopt as single target.**

---

### 2. Replicate — hosted, one predictions contract (runner-up)

**What/URL:** https://replicate.com — thousands of open + official models; https://github.com/replicate/replicate-javascript (official TS client).

**Contract:** `POST /v1/predictions` (now accepts `owner/name` directly), poll `GET /v1/predictions/{id}` (`starting/processing/succeeded/failed/canceled`), webhooks supported. Auth: `Authorization: Bearer r8_…`. **Async uniform** across image and video.

**Reference images:** data URIs, URLs, or auto-upload via `replicate.files.create` (≤100 MiB). **Critical caveat: prediction input/output files are deleted after 1 hour** (https://www.replicate.com/docs/reference/how-does-replicate-work) — `settleJob` mirroring is mandatory (already is), and resume-after-outage is harsher than fal.

**Coverage:** Kling, Wan, Seedance, MiniMax, nano-banana, Veo — strong, slightly narrower premium catalog than fal. Hosted, Replicate-billing, TS-first.

**Verdict: strong runner-up; adopt if Replicate's catalog/billing fits better. Same "one adapter" payoff.**

---

### 3. LiteLLM — the open-source unified gateway (contract reference, not adoption target)

**What/URL:** https://github.com/BerriAI/litellm — MIT, ~53k★, 100+ providers behind one OpenAI-compatible API. **It now has real media surfaces**:
- Images: `/v1/images/generations` (+`/images/edits` for some) across OpenAI, Azure, Google AI Studio, Vertex AI, Bedrock, Recraft, **OpenRouter**, Xinference, Nscale, **RunwayML (async polling absorbed by the proxy)** — https://docs.litellm.ai/docs/image_generation
- Videos: **OpenAI Video API spec** — `POST /v1/videos`, `GET /v1/videos/{id}`, `GET /v1/videos/{id}/content`, `POST /v1/videos/{id}/remix` — providers: `openai, azure, gemini, vertex_ai, runwayml, qwencloud, dashscope (Wan), minimax, volcengine (Seedance)` — https://docs.litellm.ai/docs/videos
- Reference image for video: `input_reference` — **documented for OpenAI/Azure Sora only**; unclear for veo/runway.

**Why not the single target:** (1) **Python proxy** — HeliosGen is a Tauri+Next.js desktop app; adopting LiteLLM means bundling a Python sidecar or asking users to run a gateway. (2) Coverage is **first-party-lab-heavy**: no fal/Replicate/kie/SpicyAPI/Kling-aggregator routes; Kling and grok-imagine unreachable; multi-modal output still has open tracking issues (https://github.com/BerriAI/litellm/issues/15177). (3) Image-edit/reference coverage is thin outside OpenAI-style `/images/edits`.

**Why it still matters:** LiteLLM, Together, and new-api all converging on the **OpenAI images+videos format** makes it the best candidate for a *generic `openai-media-compat` binding family* — an escape hatch for advanced users who run their own gateway. Verdict: **use for one modality-family later (optional "gateway" provider), reject as the single target.**

---

### 4. Segmind AI Gateway — hosted aggregator, **true BYOK**

**What/URL:** https://www.segmind.com/ai-gateway — one REST surface, **500+ models from 40+ labs** (Google, OpenAI, ByteDance, Alibaba, ElevenLabs…), `x-api-key` auth, v1 sync + **v2 async submit-poll-fetch** with webhooks, and explicitly **"BYOK, list-price billing. No markup"** — the only aggregator found that passes through your own upstream keys. Coverage includes Seedance 2.5, Wan 3.0, LTX 2.5, Seedream 5.0, Qwen Image 3.0.

**Gap:** exact endpoint shapes/param normalization unverified (docs at segmind.com/docs); TypeScript story less documented than fal/Replicate. **Verdict: serious alternative to fal — audit its OpenAPI before committing; BYOK posture may trump fal's credit lock-in.**

---

### 5. Runware — hosted, single-endpoint tasks array

**What/URL:** https://runware.ai — one endpoint `POST https://api.runware.ai/v1` for image/video/audio/3D/text; request = array of task objects (`taskType: imageInference|videoInference`, `taskUUID`, `model: creator:family@version`); Bearer auth; async via `deliveryMethod:"async"` + polling or webhook; official TS SDK `@runware/sdk`; outputs retained 7 days (configurable `ttl`); inline `cost`. Models include **grok-imagine, Kling, Seedance, HappyHorse-1.0** (https://runware.ai/docs/models-api/introduction, https://runware.ai/video-generation-api).

**Gaps:** bespoke (non-OpenAI, non-fal) contract; reference-image support not confirmed in fetched docs; smaller premium catalog. **Verdict: use for one modality at best; not the single target.**

---

### 6. Rejected quickly

- **Eachlabs (each::labs)** — 600+ models/46 providers, one key; docs too thin to verify a REST contract (https://www.eachlabs.ai). Watchlist only.
- **new-api (QuantumNous)** — self-hostable Go gateway with `/v1/images/generations`, `/v1/images/edits`, video task plugins (recently added Seedance 2.0), but **AGPLv3**, video via JS plugins, relay-oriented (https://github.com/QuantumNous/new-api). Reject.
- **Together.ai** — OpenAI-compatible images + new video API (Sora 2, Veo 3, Hailuo, Nano Banana, SeeDream — https://www.together.ai/blog/40-new-image-and-video-models); narrower than fal, same hosted-billing posture. Redundant with fal.
- **Vercel AI SDK `generateVideo`/`generateImage`** — TS-native unified layer (`@ai-sdk/fal`, `@ai-sdk/replicate`, `@ai-sdk/google`, `@ai-sdk/xai`…; provider-agnostic `inputReferences`, first/last-frame, internal polling with `poll.intervalMs/timeoutMs` — https://ai-sdk.dev/docs/ai-sdk-core/video-generation). **But it hides the job id** — polling absorbed in-process, so `resumeJob` has no `upstreamTaskId`; conflicts with HeliosGen's crash-recovery contract. Use as an implementation vehicle *inside* a fal adapter if desired; raw fal HTTP keeps control.

---

## Ranked recommendation

1. **Adopt fal.ai as the ONE integration target.** One binding family ("fal-queue"), uniform submit/status/result/cancel across **image + video + reference images**, native `uploadMedia` (Storage API), SSE/webhook extras, TS client, `provider_meta`/crash-resume maps 1:1 onto the existing contract. Zero per-provider adapters — per-model variance becomes **schema data**, not code.
2. **Audit Segmind's OpenAPI as the BYOK counter-offer** before committing (its list-price/BYOK posture is materially better for user-owned-keys HeliosGen; fal locks billing to fal credits).
3. Replicate = equal-architecture fallback; LiteLLM/OpenAI-video-format = future generic "gateway" provider, not the primary.

**What dies from the current plan if fal is adopted:** all four starter adapters (OpenRouter is sync-image-only and its models ride fal; SpicyAPI is a kie-clone; Pollinations and HF are strictly weaker than fal's coverage) — the P4+P5 joint landing stays valuable as *architecture proof* but its adapter breadth is no longer needed. The Kie-family per-payload machinery (`kie-motion-control`, `kie-happy-horse`, `kie-veo`…) collapses into fal schemas. **What survives:** the P1–P3 registry/jobManager/`settleJob`/mediaStaging infra (with fal as registry entry #2 alongside legacy kie), the `PollOutcome.done.buffers` gap resolution, and the SpicyAPI/HF specs as archived alternatives.

# Endpoint Compatibility Registry

Living list of backends vs the openai-media-compat contract. A backend moves
from *theoretical* to *confirmed* only by passing the promotion gate below —
docs claims alone never promote.

**Promotion gate (all required):** live `submit` returns media (url or b64) →
`settleJob` mirrors it locally → reference-field shape confirmed live (array
vs single) → error envelope observed (not assumed) → readiness gating works
without a key (negative case). Record date + model used for each confirmation.

## Confirmed compatible ✅

| Backend | Base URL | Confirmed | Evidence |
|---|---|---|---|
| Pollinations sync image | `https://gen.pollinations.ai` | 2026-10-20 | Live: `POST /v1/images/generations` (z-image-turbo) → hosted media URL with `response_format:"url"`; ref field accepts BOTH `image:["data:..."]` array and single-string forms. |
| OpenRouter images (qwen, recraft, seedream, flux families) | `https://openrouter.ai/api` | 2026-10-20/21 | Live: qwen-2.1-turbo t2i + i2v with refs (incl. the `aspect_ratio:"auto"` drop fix); recraft-v4.1-flash, seedream-5-0-flash, flux-3-image-klein spot-checks all `done` with mirrored files. Ref shape is `{type:"image_url",image_url:{url}}` objects (Zod rejects strings). `seed` is NUMERIC at runtime despite the endpoint listing claiming boolean. |

## Theoretically compatible (docs/schema-verified, NOT live-tested) 🔶

| Backend | Base URL | Basis | Gap to confirmed |
|---|---|---|---|
| OpenRouter images | `https://openrouter.ai/api` | Spike: 10/11 catalog models map to live `/api/v1/images/models` ids; dialect (`aspect_ratio`, `resolution`, `input_references`) documented | Live submit + ref shape + error envelope (needs `OPENROUTER_API_KEY`) |
| OpenRouter video | `https://openrouter.ai/api` | Spike: `/api/v1/videos/models` live, 13/17 catalog rows with schemas | Same as images, plus duration/clamp behavior |
| Pollinations video | `https://gen.pollinations.ai` | Spike: models listed, caps tighter (refs ≤2, several 5s-capped) | Weak lane — live submit + duration/clamp confirmation; async path explicitly NOT covered |
| LiteLLM-routed (self-hosted gateway) | user-run | Docs: `/v1/images/generations`, `/v1/images/edits`, OpenAI Video API spec across providers | No live test; first-party-lab coverage only; reference-image support beyond Sora unverified |
| Together | `https://api.together.xyz` | Docs: OpenAI-compatible images + video API | No live test; narrower than the spike set |
| new-api gateway (self-hosted) | user-run | Docs: `/v1/images/generations`, `/v1/images/edits`, video task plugins | AGPL — license review before any bundling; no live test |
| User-run generic gateway | user-provided | Contract conformance assumed | Live submit per deployment |
| SpicyAPI `/v1/videos` (degraded video path) | `https://api.spicyapi.ai` | Docs: OpenAI Videos-format endpoints, single `input_reference` | Degraded by design (no quotes, single ref); native task API strictly better for multi-ref models |

## Ruled out (not compat — dedicated adapter or nothing) ❌

| Backend / surface | Reason |
|---|---|
| SpicyAPI images | `/v1/images/*` 404s; image models 400 on chat endpoints — kie-family adapter only (deferred) |
| fal.ai queue | Hosted aggregator, single-vendor lock-in + credit markup — rejected on vendor-lock constraint |
| Replicate predictions | Async predictions API, no OpenAI image/video surface |
| HuggingFace Inference Providers | Chat-compat is chat-only; image/video shapes per-provider, undocumented as REST |
| Segmind Gateway | Full-proxy data path (sees prompts/files/BYOK keys) + thin legal docs — rejected pending DPA/ZDR/key-encryption answers; BYOK-hosted status unresolved |
| kie.ai task API | Native queue contract, not compat — stays as the legacy backend, not a compat binding |

## Notes

- OpenRouter + Pollinations first, per the binding-availability spike (≥3 real rows each — passed).
- `nano-banana-2.1` Pollinations listing was DOWN and `seedream-5.0-pro` degraded at spike time (2026-10-20) — re-check before binding health claims.
- Zero-catalog-coverage anywhere: `kling-3.0-turbo`, `kling-2.6/3.0-motion-control` (kie-only or hidden from provider pickers).

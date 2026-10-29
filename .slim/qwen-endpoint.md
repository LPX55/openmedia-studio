Pricing gaps closed to the extent publicly possible. kie publishes only `creditsConsumed` (example: 4.8 credits/task) with no USD rate or per-model price table → flagged. Final deliverable below, **pricing elevated to a first-class ranking column**.

# Qwen-Image-2.1 hosted endpoints — pricing-ranked compat table

Ranking factor order: **(1) contract fit, (2) price per image, (3) tier coverage.** All numbers verified live this session unless flagged ◇.

## 🥇 1. OpenRouter — USE-AS-IS · **$0.0184/img turbo, $0.046/img pro (flat, resolution-invariant)**

| | |
|---|---|
| Endpoint / auth | `POST https://openrouter.ai/api/v1/images` · `Authorization: Bearer $OPENROUTER_API_KEY` · sync |
| Model ids | `qwen/qwen-image-2.1-turbo`, `qwen/qwen-image-2.1-pro` (+ same-dialect `qwen/qwen-image-3`, `-3-pro`) |
| **Pricing** | Per-endpoint records (verified via `/images/models/{model}/endpoints`): turbo = **$0.0184/image at both 1K and 2K** (explicit variant entries — same price, **NOT resolution-scaled**); pro = **$0.046/image (1K & 2K)**. Flat per-output-image; `n` multiplies. Input refs: $0.00. No mega-pixel metering. |
| **Free tier** | No free variant for this model (OpenRouter `:free` suffixes don't exist for it). Failed gens are never billed (502 = no charge). |
| Tier diffs | turbo vs pro = 2.5× price for quality tier; no lite/base variant exists anywhere for 2.1 (unified gen+edit model) |
| Contract fit | Exact match: `prompt`/`aspect_ratio`(13)/`resolution`(1K,2K)/`size`/`quality`/`input_references`(0–4)/`seed`; response `{created, data:[{b64_json, media_type}], usage.cost}` |
| Verdict | **USE-AS-IS** — paramMap: clamp `n ≤ 6`, normalize resolution to `1K/2K` |
| Sources | https://openrouter.ai/api/v1/images/models · https://openrouter.ai/api/v1/images/models/qwen/qwen-image-2.1-turbo/endpoints · https://openrouter.ai/docs/guides/overview/multimodal/image-generation |

## 🥈 2. Alibaba Cloud Model Studio (first-party Qwen) — USE-WITH-DIALECT-OVERRIDES · **$0.014133/img (most regions), $0.016/img Singapore — cheapest verified per-image**

| | |
|---|---|
| Endpoint / auth | `POST https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1/images/generations` (Singapore/US-VA/Frankfurt/Tokyo/Beijing/HK) · `Authorization: Bearer $DASHSCOPE_API_KEY` (region-locked key) · sync |
| Model ids | `qwen-image-2.1-turbo`, `qwen-image-2.1-pro` (+ `qwen-image-3.0`, `-3.0-pro`) |
| **Pricing** | Turbo: **$0.014133/image** in Beijing, US-VA, Frankfurt, Tokyo, HK; **$0.016/image** in Singapore — **flat per image, not MP- or resolution-scaled** (512²–2048² free choice of size). Pro: $0.075/image on comparably-priced gateways; per-image on Model Studio, ◇ region table not re-verified line-by-line this session. |
| **Free tier** | Docs include a "Free quota for new users" section ◇ (existence verified in page headings; exact quota size not captured). |
| Contract fit | Mismatches: path `/compatible-mode/v1/images/generations`; refs via top-level **`image`** field (URL/data-URL, 1–10), not `input_references`; no `aspect_ratio`/`resolution` keys — use `size: "1024x1024"`/`auto`; **returns hosted URLs only — `response_format=b64_json` silently ignored** |
| Verdict | **USE-WITH-DIALECT-OVERRIDES**: path, refs field `image`, `size` mapping, URL-download media staging. Cheapest per-image + first-party truth of the model. |
| Source | https://www.alibabacloud.com/help/en/model-studio/qwen-image-generation-and-editing-api-reference (upd. 2026-10-11) |

## 🥉 3. Pollinations — USE-WITH-DIALECT-OVERRIDES · **0.016 pollen/img turbo (unit semantics ◇ partially unverifiable)**

| | |
|---|---|
| Endpoint / auth | `POST https://gen.pollinations.ai/v1/images/generations` + `/v1/images/edits` · Pollinations bearer/token (docs gate → auth scheme ◇ unverifiable publicly) · sync |
| Model ids (live) | `qwen/qwen-image-2.1-turbo`, `qwen/qwen-image-2.1` (max_reference_images: 10, healthy) |
| **Pricing** | Turbo: `completionImageTokens: 0.016` pollen, `flat_rate: true`, **no pricing_units → per image**; suspiciously equals Alibaba's $0.016, but **pollen→USD conversion rate not publicly verifiable — PRICING FLAG**. Base 2.1: `0.00000002` with `unit: megapixel, quantity: 1000000` — i.e. ~0.02 pollen/MP ◇ (arithmetic interpretation, not doc-confirmed). |
| **Free tier** | `paid_only: true` for both — no free access. |
| Contract fit | `/v1/images/generations`-shaped (standard OpenAI images path, not our bare `/images`); refs param names unverified (docs `Unauthorized`); turbo explicitly text+image input so editing is servable |
| Verdict | **USE-WITH-DIALECT-OVERRIDES** (path `/v1/images/generations`; refs field TBD by runtime probe) — keep as resilience backup |
| Source | https://gen.pollinations.ai/image/models (live) |

## ⛔ Rejected — with pricing where published

| Provider | Model id | Pricing | Verdict & reason |
|---|---|---|---|
| **kie.ai** | `qwen2-1/text-to-image`, `qwen2-1/image-to-image` | **Per-task credits, no published per-model price.** Docs expose only `creditsConsumed` (worked example: 4.8 credits/task); no USD rate or price table → **PRICING UNVERIFIABLE without account**. Async + webhook pattern. | **REJECT** — async task API, non-compat; also the credit-markup trap. https://docs.kie.ai/market/qwen2-1/text-to-image |
| **fal.ai** | `fal-ai/qwen-image-2.1` (live llms.txt); **no `-2.1-turbo`** (404) | **$0.02/MP** (per-megapixel, size-scaled → 1MP ≈ $0.02, 2MP native ≈ $0.04) — more expensive than flat-price rivals at 2K. No free tier. | **REJECT** — fal queue contract, non-compat; vendor-lock + cost concern already logged. https://fal.ai/models/fal-ai/qwen-image-2.1/llms.txt |
| **Replicate** | owner/model for 2.1-turbo **not discoverable** (`api.replicate.com` → `401 Unauthenticated` without token; no public listing surfaced) | **PRICING MISSING / UNVERIFIABLE** this session | **REJECT/UNVERIFIED** — predictions API non-compat anyway; re-probe only with `REPLICATE_API_TOKEN`. |
| **Runware** | `alibaba:qwen-image@2.1-turbo` / `@2.1-pro` | Turbo **$0.014133/img**, Pro **$0.075/img** — flat per image (their pricing table, standard tier). New-account free credits ◇ advertised historically, not verified. | **REJECT** — task-array JSON (`taskType`/`taskUUID`/`positivePrompt`), nothing images-shaped, despite having sync delivery. https://runware.ai/docs/models/alibaba-qwen-image-2-1-turbo |
| **Segmind** | `qwen-image-2.1-turbo` | **PRICING MISSING** — model page is client-rendered; no price extractable → unverifiable without account/API key. | **REJECT** — custom REST (`/v2/qwen-image-2.1-turbo` + `request_id` polling), non-compat. https://www.segmind.com/models/qwen-image-2.1-turbo |
| **Together.ai** | no qwen-image-2.1 listing found | n/a | n/a — not offered. |
| **HF Spaces** (Viggle-family) | — | — | **REJECT** — gradio_client queue, not our compat family; even free, transport is out of scope. |

## Bottom line (pricing-first)

1. **OpenRouter** is both the exact-contract hit *and* near-lowest verified price (`$0.0184` flat, resolution-invariant, b64 sync, `usage.cost` per call). Wire turbo first; pro is a 2.5× quality tier on the same binding — add both, skip lite/base/edit modeling for 2.1 (doesn't exist; editing = `input_references`).
2. **Alibaba Model Studio** undercuts it (~13% cheaper, `$0.014133`) but costs three paramMap overrides + URL-download staging + workspace-scoped regional keys — worth a second binding only if image volume makes the delta material.
3. Every rejected candidate is non-compat regardless of price (task/queue/native vocab), and two (kie, Segmind, Replicate) additionally fail on **unverifiable/missing pricing** — a disqualifier for a cost-gated product anyway.

All data gathered. Here is the binding-availability spike report.

---

# Binding-Availability Spike — HeliosGen catalog vs live OpenRouter / Pollinations

Sources: `lib/modelConfig.ts` (read in full), `https://openrouter.ai/api/v1/images/models` + `/endpoints` per model, `https://openrouter.ai/api/v1/videos/models` (probe — live, 200), `https://gen.pollinations.ai/image/models`, `https://gen.pollinations.ai/video/models`. All fetched today (2026-10-20). No repo writes.

**Catalog correction:** the task example mentioned "wan" — there is **no WAN entry** in `IMAGE_MODELS`/`VIDEO_MODELS`. The 17 video ids are: veo3_lite, veo3_fast, veo3, gemini-omni-video, kling-3.0, kling-3.0-turbo, grok-imagine, grok-imagine-1-5-preview, seedance-2, seedance-2-fast, seedance-2-mini, seedance-2-5, seedance-2-5-edit, happyhorse, minimax-h3, kling-2.6-motion-control, kling-3.0-motion-control.

OpenRouter image catalog: **61 models** (with a parallel `/api/v1/videos/models` catalog of ~30 unique models — a video API exists, contrary to prior assumption). Pollinations: ~48 image + ~24 video entries.

## Image models (11 catalog rows)

| Catalog id | Backend | Upstream id (exact string) | Notes |
|---|---|---|---|
| `google-nano-banana` | both | OR `google/gemini-2.5-flash-image` · Pol `google/gemini-2.5-flash-image` (alias `nanobanana`) | Original nano-banana. OR: refs max **3** (catalog says text-only, fine), no resolution param. Pol healthy. |
| `nano-banana-2` | both (successor) | OR `google/gemini-nano-banana-2.1` · Pol `google/gemini-3.1-flash-image` (alias `nanobanana2`) | Exact `nano-banana-2` id is **gone** upstream — line moved to 2.1. Refs 14 ✓ matches catalog. Res enum `1K/2K/4K` (uppercase). ⚠ Pol listing health: **down** (0/81). |
| `nano-banana-pro` | both | OR `google/gemini-3-pro-image` · Pol same (alias `nanobanana-pro`) | Refs 14 (catalog says 8 — upstream allows more). Res 1K/2K/4K. Healthy both. |
| `nano-banana-2-lite` | Pollinations only | `google/gemini-3.1-flash-lite-image` (aliases `nanobanana2lite`, `nanobanana-2-lite`) | Refs 14 (catalog 10). Res 1K only. Healthy. Not on OpenRouter. |
| `z-image` | Pollinations only | `tongyi-mai/z-image-turbo` (alias `z-image`) | Text-only ✓, free tier, healthy, 60 rpm. Not on OpenRouter. |
| `seedream-5-lite` | both | OR `bytedance-seed/seedream-5-0-lite` · Pol `bytedance/seedream-5.0-lite` | Refs 14 ✓. OR res enum `2K/4K` — **exactly matches catalog qualityOptions ["2k","4k"]**. Healthy both. |
| `seedream-5-pro` | both | OR `bytedance-seed/seedream-5-0-pro` · Pol `bytedance/seedream-5.0-pro` (alias `seedream-5-pro`) | Refs 14 (catalog 10). OR res `1K/2K` ✓ matches catalog ["1k","2k"]. ⚠ Pol health: degraded. |
| `grok-imagine-image` | both | OR `x-ai/grok-imagine-image-2.0`, `x-ai/grok-imagine-image-quality` · Pol `x-ai/grok-imagine-image` | **Ref-image cap mismatch**: OR max **3** refs (all Grok image variants) vs catalog maxImages 5 — only Pollinations allows 5. OR resolution `1K/2K` + quality low/medium. |
| `gpt-image-2` | both | OR `openai/gpt-image-2` · Pol `openai/gpt-image-2` | Refs 16 ✓. Quality enum `auto/low/medium/high` — **not** 1k/2k/4k; catalog's Azure `resolution` mapping does not transfer. Ratios incl. `21:9`. Pol: healthy, free. |
| `gpt-image-2-5-flare` | both | `openai/gpt-image-2.5-flare` | Refs 16 ✓. Quality `auto…max` (adds `xhigh`,`max`). Healthy both. |
| `gpt-image-2-5-sunburst` | both | `openai/gpt-image-2.5-sunburst` | Same as flare. Healthy both. |

**Dialect quirk (OpenRouter images):** payload is `prompt` + `aspect_ratio` + optional `resolution` (uppercase `1K/2K/4K`) + `input_references`; there is no t2i/i2i id split like Kie's `textOnlyApiId` — one id handles both, refs 0 allowed. Per-endpoint data confirmed for 10 candidates (providers: OpenAI direct, Google AI Studio, Google Vertex, Seed, SpaceXAI).

## Video models (17 catalog rows)

| Catalog id | Backend | Upstream id (exact string) | Notes |
|---|---|---|---|
| `veo3_lite` | both | OR `google/veo-3.1-lite` · Pol **none** | OR: 720p/1080p (**no 4k** vs catalog), durs 4/6/8, first+last frame. |
| `veo3_fast` | both | OR `google/veo-3.1-fast` · Pol `google/veo-3.1-fast` | Durs 4/6/8 (Pol `allowed_durations` [4,6,8]), res 720p/1080p (OR adds 4K), first+last frame, seed, audio. Healthy both. |
| `veo3` | OpenRouter only | `google/veo-3.1` | Quality tier. 720p/1080p/4K, durs 4/6/8, seed ✓. |
| `gemini-omni-video` | Pollinations only | `google/gemini-omni-1.1-flash` | Durs 3–10 (catalog 4–10), refs **2** images (catalog maxResources 7), **no `reference_videos` capability** (catalog maxReferenceVideos 1). Resolution schema 720p/360p/1080p/4k. |
| `kling-3.0` | both | OR `kwaivgi/kling-v3.0-pro` + `kwaivgi/kling-v3.0-std` · Pol `kwaivgi/kling-v3.0-std` | Mode split maps to two ids (std/pro); **no 4K mode anywhere**. Durs 3–15 ✓, 720p only, first+last frame, audio. OR allows `negative_prompt`, `cfg_scale` passthrough. |
| `kling-3.0-turbo` | **none** | — | `kling/v3-turbo-*` absent from both backends. |
| `grok-imagine` | both | OR `x-ai/grok-imagine-video` · Pol same | **Duration mismatch**: upstream 1–15 s, catalog offers 6–30 s → must re-clamp to 1–15. No fun/normal/spicy mode. Res 480p/720p (OR); Pol 720p only, 1 ref. |
| `grok-imagine-1-5-preview` | both | OR `x-ai/grok-imagine-video-1.5` (+ `-1.5-lite`) · Pol both ids | Durs 1–15 ✓ matches catalog, 480p/720p/1080p, first_frame only. |
| `seedance-2` | both | OR `bytedance/seedance-2.0` · Pol same (alias `seedance-2`) | Durs 4–15 ✓. Pol caps: refs **2** (catalog 9); Pol capabilities include `reference_images/videos/audios` ✓. 720p only. Healthy both. |
| `seedance-2-fast` | both | `bytedance/seedance-2.0-fast` | Durs 4–15 on OR (480p/720p); **Pol: 480p only, max 5 s**. |
| `seedance-2-mini` | both | `bytedance/seedance-2.0-mini` | Durs 4–15 ✓, first+last frame, audio, seed. Res 480p/720p ✓. |
| `seedance-2-5` | both | `bytedance/seedance-2.5` | OR durs 4–30 ✓ matches catalog exactly; res 480p/720p ✓. ⚠ Pol listing shows max_duration **4** — effectively unusable there. |
| `seedance-2-5-edit` | OpenRouter (partial) | `bytedance/seedance-2.5` (same id; description confirms editing/extension workflows) | Pol max_duration 4 kills it there. Reference-video/adaptive-ratio workflow unverified on OR schema (no `reference_*` field in OR video schema — passthrough params only `watermark/req_key/output_format`). |
| `happyhorse` | both | OR `alibaba/happyhorse-1.1` (+`-1.0`) · Pol `alibaba/happyhorse-1.1` | Durs 3–15 ✓, seed ✓, first_frame ✓. OR res 720p/1080p (catalog default 1080p ✓); Pol 720p only. |
| `minimax-h3` | both | OR `minimax/hailuo-3-max` (+ `minimax/hailuo-3`) · Pol `minimax/minimax-h3-max` (+ `minimax/minimax-h3`) | Naming drift: upstream uses **hailuo**, not `minimax-h3/*`. Durs 5–15 (Pol `allowed_durations` [5,10,15] — not continuous like catalog 4–15). Pol h3-max has `reference_images/videos/audios` ✓ but refs capped **2**. Res: OR 480p/768p, Pol 480p/768p/1080p — catalog's `768P`/`2K` strings don't match either. |
| `kling-2.6-motion-control` | **none** | — | No motion-control product on either backend. Closest is `kwaivgi/kling-video-o1` (different product, durs 5/10). |
| `kling-3.0-motion-control` | **none** | — | Same. |

## Verdicts

| Backend | Verdict | Reason |
|---|---|---|
| **OpenRouter images** | **SHIP** | 10/11 catalog models map to real live ids with published per-endpoint caps and pricing; dialect is clean (one id per model, `aspect_ratio`/`resolution`/`input_references`). |
| **OpenRouter video** | **SHIP** | `/api/v1/videos/models` is live and covers 13/17 catalog rows with full schema (durations, frame images, resolutions, seed, audio, passthrough params). |
| **Pollinations images** | **SHIP** | Covers all 11 families incl. the two OpenRouter gaps (`z-image`, `nano-banana-2-lite`); OpenAI-compatible endpoints (`/v1/images/generations`, `/v1/images/edits`) make a single-dialect adapter viable. ⚠ Health watch: nano-banana-2.1 **down**, seedream-5.0-pro degraded. |
| **Pollinations video** | **SHIP (weak)** | ≥3 real rows (veo-3.1-fast, kling-v3.0-std, seedance-2.x, minimax-h3-max, happyhorse-1.1, grok, gemini-omni-1.1-flash), but caps are consistently tighter: refs ≤2, several ids capped at 5 s (wan-3.0, seedance-2.5, minimax-h3, seedance-2.0-fast), health mostly unknown. Usable as a fallback lane only. |

## Zero-coverage catalog models (flag for the build lane)

- `kling-3.0-turbo` (`kling/v3-turbo-text-to-video` / `-image-to-video`) — no backend
- `kling-2.6-motion-control` (`kling-2.6/motion-control`) — no backend
- `kling-3.0-motion-control` (`kling-3.0/motion-control`) — no backend

These three can only stay on Kie, or the UI must hide them when Kie adapters are removed. Additionally note soft-coverage gaps even where ids exist: `nano-banana-2` (only as 2.1 successor), Grok image ref-cap 3 vs catalog 5, Grok video durations 1–15 vs catalog 6–30, Kling 3.0 4K mode unavailable, MiniMax resolution strings (`768P`/`2K`) don't match upstream enums.

/**
 * Static model→provider bindings — design.md §1.1 (O2 C1 static binding set).
 *
 * PURE DATA MODULE: no `guest/db`, no node builtins, no route imports
 * (o2-gate hedge (d) — this module is shareable code; if it pulled in the DB
 * layer, client bundles would break). Server-side `model_bindings` row overrides
 * are applied by `lib/providers/registry.ts`, and the client learns its
 * per-model provider union from `GET /api/settings/providers` (`bindingsByModel`),
 * never from this module.
 *
 * Scope: the 28 catalog models each get a code-defined Kie binding
 * (`upstreamModelId = apiId` — the default-binding rule), plus `gpt-image-2`
 * gets Azure and Codex bindings. Rows in SQLite exist only for user overrides /
 * prefs / custom bindings; the built-ins below are code, not rows.
 */
import { IMAGE_MODELS, VIDEO_MODELS } from "../modelConfig";
import type { ImageModel, VideoModel } from "../modelConfig";
import type { MediaStagingOperation, MediaStagingStrategy, ProviderId } from "./types";

/**
 * One family per video payload branch of `app/api/generate-video/route.ts`
 * (:77, :94, :164, :208, :234, :275, :361, :368 + default) — full 9-value
 * taxonomy (C1). Per-model assignments are PROVISIONAL until exercised against
 * live payloads (hedge (a)); the adapter always derives payload details from
 * the `useX` flags in `paramMap` too — `family` is metadata, never the only
 * place those flags exist (C5).
 */
export type VideoPayloadFamily =
  | "kie-motion-control"
  | "kie-minimax-h3"
  | "kie-happy-horse"
  | "kie-kling-turbo"
  | "kie-google-veo"
  | "kie-gemini-omni"
  | "kie-image-urls"
  | "kie-kling-elements"
  | "standard";

/**
 * Which normalized param feeds ONE body field of an openai-compat request.
 *
 *  - "prompt"       — the prompt text
 *  - "aspectRatio"  — the aspect ratio ("16:9")
 *  - "tier"         — the effective quality/resolution tier the catalog's
 *                     picker produced ("1k" | "2k" | "4k" | "low" | …)
 *  - "quality"      — the raw quality param
 *  - "resolution"   — the raw resolution param
 *  - "size"         — the custom pixel size ("WxH")
 *  - "width"        — the custom pixel WIDTH (a number, not "WxH")
 *  - "height"       — the custom pixel HEIGHT (a number, not "WxH")
 *  - "seed"         — the seed
 *  - "references"   — the staged reference images
 *  - "outputFormat" — the catalog's declared output format
 *
 * VIDEO sources (the OpenRouter video dialect — `POST /v1/videos`):
 *
 *  - "duration"        — the clip length in SECONDS (an int)
 *  - "sound"           — the audio toggle (a bool → `generate_audio`)
 *  - "frames"          — the staged start/end frames → `frame_images`
 *  - "inputReferences" — the staged references / videos / audios →
 *                        `input_references`
 */
export type CompatFieldSource =
  | "prompt"
  | "aspectRatio"
  | "tier"
  | "quality"
  | "resolution"
  | "size"
  | "width"
  | "height"
  | "seed"
  | "references"
  | "outputFormat"
  | "duration"
  | "sound"
  | "frames"
  | "inputReferences";

/**
 * The DIALECT of an openai-compat binding — the shape of its `paramMap`.
 *
 * Compat-plan §(a)/(b): the adapter is dialect-free; every backend difference
 * (which body key carries the aspect ratio, whether the tier is called
 * `resolution` or `quality`, which vocabulary the tier values use, how many
 * reference images the backend accepts) lives HERE, in code, per binding.
 *
 *  - `fields`      — body key → normalized source. A body key that is not
 *                    declared is NOT sent ("per-model params on needs basis
 *                    only; unknown params pass through").
 *  - `valueMaps`   — body key → normalized→upstream value map
 *                    (e.g. `{ resolution: { "1k": "1K" } }`).
 *  - `constants`   — body key → static upstream value (e.g. `output_format`).
 *  - `modelKey`    — body key carrying the upstream model id (default "model").
 *  - `maxReferences` — upstream reference-image cap (per-model, from the
 *                    binding-availability spike).
 *  - `referenceMode` — how the staged references are shaped in the body:
 *                    "array" (default — `["url", …]`, the OpenAI shape),
 *                    "first" (a single URL string — for backends whose
 *                    reference field takes ONE url), or "objects"
 *                    (`[{type:"image_url",image_url:{url}}, …]` — the
 *                    OpenRouter `/v1/images` dialect, verified live).
 */
export type CompatParamMap = {
  fields?: Record<string, CompatFieldSource>;
  valueMaps?: Record<string, Record<string, string | null>>;
  constants?: Record<string, string | number>;
  modelKey?: string;
  maxReferences?: number;
  referenceMode?: "array" | "first" | "objects";
  /**
   * VIDEO — the upstream FRAME cap: `1` = the first frame only, `2` = first +
   * last. Undefined ⇒ both frames ride when they exist.
   */
  maxFrames?: number;
  /**
   * VIDEO — the upstream duration clamp. It RE-clamps the catalog's picker to
   * the model's own limits (the spike's "must re-clamp to 1–15" rule): a value
   * outside the range is pulled to the nearest bound, never sent as-is.
   */
  durationMin?: number;
  durationMax?: number;
  /**
   * VIDEO — the duration sent when the catalog has NO duration picker (its
   * clamped duration is 0). The model's own default clip length.
   */
  defaultDuration?: number;
  /**
   * VIDEO — when set, the staged REFERENCES ride as a FRAME image with this
   * `frame_type` instead of as an `input_references` entry — the shape of a
   * backend whose only image input is a first frame.
   */
  referenceFrame?: "first_frame" | "last_frame";
};

/**
 * The media-upload endpoint of an openai-compat binding — the counterpart of
 * the "remote-url" staging strategy (compat-plan §b: "per-binding override").
 *
 * A backend that stages local reference media as a URL needs somewhere to
 * PUT the bytes: Pollinations uploads to its MEDIA STORE
 * (`https://media.pollinations.ai/upload` — a SIBLING host of the generation
 * base URL `https://gen.pollinations.ai`), not to the generation endpoint.
 *
 * The endpoint AND its field convention are the BINDING's business — the
 * adapter stays generic (compat-plan §a: no vendor branches in code):
 *
 *  - `url`      — absolute upload endpoint.
 *  - `field`    — multipart form field / JSON key carrying the bytes
 *                 (default "file").
 *  - `encoding` — body encoding (default "multipart"; "raw" posts the bytes,
 *                 "base64" posts a base64 payload under `field`).
 *  - `headers`  — extra request headers (merged over the defaults).
 *  - `fields`   — extra non-file multipart fields.
 */
export interface CompatMediaUpload {
  /** Absolute URL of the upload endpoint. */
  url: string;
  /** Multipart form field / JSON key carrying the bytes (default "file"). */
  field?: string;
  /** Body encoding of the upload (default "multipart"). */
  encoding?: "multipart" | "raw" | "base64";
  /** Extra request headers (merged over the adapter's defaults). */
  headers?: Record<string, string>;
  /** Extra non-file multipart fields. */
  fields?: Record<string, string>;
  /**
   * Provider id whose runtime key authenticates the upload (the stored DB key
   * first, then that provider's env fallback — resolved by
   * `getProviderRuntimeConfig`). When absent, the existing behavior holds: the
   * generation-target backend's own key authenticates the upload.
   *
   * CROSS-PROVIDER upload: the endpoint belongs to ANOTHER provider than the
   * one that generates (e.g. the OpenRouter video lane documents NO upload
   * endpoint of its own, so its local frames are staged through the
   * Pollinations media store) — the generation backend's key would NOT
   * authenticate that host.
   */
  keyProviderId?: string;
}

/**
 * How one provider executes one logical model (design §1.1).
 *
 * Polarity is PINNED (O2 C1) and identical across providers:
 *  - `upstreamModelId`    — the base variant (image: media-present `apiId`;
 *                            video: text-only `apiId` / t2v).
 *  - `textOnlyUpstreamId` — variant selected when there is NO input media.
 *                            IMAGE polarity: from `ImageModel.textOnlyApiId`
 *                            (t2v variant; image base `apiId` stays default).
 *  - `imageUpstreamId`    — variant selected when input frames/images ARE
 *                            present. VIDEO i2v slot: from `VideoModel.imageApiId`.
 *                            A video `imageApiId` must NEVER be mapped into
 *                            `textOnlyUpstreamId` — its meaning relative to the
 *                            image field is inverted (O2 C1).
 */
export interface ModelProviderBinding {
  /** Logical catalog id — bare, never `"provider:model"` (design §1.1). */
  modelId: string;
  providerId: ProviderId;
  /** Model string sent upstream (default-binding rule: = `apiId` for Kie). */
  upstreamModelId: string;
  /** No-input-media variant (IMAGE t2v, from `textOnlyApiId`). */
  textOnlyUpstreamId?: string;
  /** Input-media variant (VIDEO i2v, from `imageApiId`). */
  imageUpstreamId?: string;
  /** 9-value payload taxonomy (videos); images are always "standard". */
  family?: VideoPayloadFamily;
  /** Static adapter-specific shaping — derived from the model's `apiInput` (+ Azure size maps). */
  paramMap?: Record<string, unknown>;
  /**
   * Backend base URL of an openai-compat binding (e.g.
   * "https://openrouter.ai/api/v1"). Overrides the provider config's
   * `base_url` — a code-seeded backend carries its own; a user-pointed
   * backend (LiteLLM / new-api gateway) leaves it unset and uses the
   * configured one (compat-plan §b/§d).
   */
  baseUrl?: string;
  /**
   * Endpoint path appended to the base URL (default "/v1/images/generations";
   * OpenRouter's image dialect uses "/images").
   */
  pathOverride?: string;
  /**
   * Env var holding this backend's API key (the stored DB key wins). The
   * openai-compat family deliberately does NOT share one key across backends
   * (e.g. "OPENROUTER_API_KEY" ≠ "OPENAI_API_KEY").
   */
  keyEnv?: string;
  /** Per-binding staging override (finding 1i) — provider level is only the default. */
  mediaStaging?: MediaStagingStrategy;
  /** Per-operation staging override (finding 1i) — e.g. Azure generations vs edits. */
  mediaStagingByOperation?: Partial<Record<MediaStagingOperation, MediaStagingStrategy>>;
  /**
   * The media-upload endpoint used by the "remote-url" staging strategy — the
   * binding's own media store (e.g. Pollinations' `media.pollinations.ai`).
   *
   * Only consulted when the resolved staging strategy is "remote-url"; the
   * upload hook is otherwise never called (a data-url backend never uploads).
   */
  mediaUpload?: CompatMediaUpload;
  /**
   * Param preset id (compat-plan §c) — the BASE layer of this binding's
   * effective params (`preset ← binding.paramMap ← custom overrides`).
   *
   * Set by the custom binding's `"preset"` key (per binding) or by the
   * provider-level default (`provider_configs.extra_json.presetId`); the
   * binding-level value wins. Only the openai-compat family has presets.
   */
  presetId?: string;
  /**
   * Set when `presetId` does NOT resolve to a stored preset. The compat
   * adapter fails the job with this message (settled, never a silent
   * fallback) — compat-plan §c: "validation rejects unknown keys loudly".
   */
  presetError?: string;
  /** True when the binding is user-defined (`model_bindings.is_custom`). */
  isCustom?: boolean;
}

/**
 * Derive the payload family from the video `apiInput` flags, in the same
 * precedence order the route evaluates its branches (route lines in comments).
 * `kling-3.0` fires BOTH `useImageUrls` (:361) and `useKlingElements` (:368);
 * first match in route order wins — its elements payload still rides in
 * `paramMap.useKlingElements`. Provisional per hedge (a).
 */
function deriveFamily(apiInput: VideoModel["apiInput"]): VideoPayloadFamily {
  if (apiInput.useMotionControl)   return "kie-motion-control"; // :77
  if (apiInput.useMinimaxH3)       return "kie-minimax-h3";     // :94
  if (apiInput.useHappyHorse)      return "kie-happy-horse";    // :164
  if (apiInput.useKlingTurbo)      return "kie-kling-turbo";    // :208
  if (apiInput.useGoogleVeo)       return "kie-google-veo";     // :234 (also selects /api/v1/veo/generate)
  if (apiInput.useGeminiOmniVideo) return "kie-gemini-omni";    // :275
  if (apiInput.useImageUrls)       return "kie-image-urls";     // :361
  if (apiInput.useKlingElements)   return "kie-kling-elements"; // :368
  return "standard"; // seedance (:138), grok (:298), and the remaining default branch
}

function kieImageBinding(m: ImageModel): ModelProviderBinding {
  const binding: ModelProviderBinding = {
    modelId: m.id,
    providerId: "kie",
    upstreamModelId: m.apiId,
    family: "standard", // image payloads have no video-style branches (C1.3)
    paramMap: { ...m.apiInput },
  };
  if (m.textOnlyApiId) binding.textOnlyUpstreamId = m.textOnlyApiId;
  return binding;
}

function kieVideoBinding(m: VideoModel): ModelProviderBinding {
  const binding: ModelProviderBinding = {
    modelId: m.id,
    providerId: "kie",
    upstreamModelId: m.apiId,
    family: deriveFamily(m.apiInput),
    paramMap: { ...m.apiInput },
  };
  if (m.imageApiId) binding.imageUpstreamId = m.imageApiId;
  return binding;
}

const gptImage2 = IMAGE_MODELS.find((m) => m.id === "gpt-image-2");

/**
 * Azure Foundry binding for `gpt-image-2` (the only catalog model with Azure
 * shaping — `azureSizeMap`/`azureResolutionSizeMaps`/`azureApiVersion`).
 *
 * - `upstreamModelId` mirrors the logical id: Azure routes by the per-user
 *   DEPLOYMENT name from `cfg.extra.deployments[modelId]` (readiness requires
 *   baseUrl + that deployment — finding 1ii), which is runtime config, not
 *   static data.
 * - No `textOnlyUpstreamId`: both text and image variants run through the same
 *   deployment — the endpoint differs by media presence (`/images/generations`
 *   vs `/images/edits`), not the model string.
 * - Per-operation staging (finding 1i): JSON-b64 for generations, multipart
 *   buffers for edits — one provider, two strategies, hence `ByOperation`.
 */
const gptImage2AzureBinding: ModelProviderBinding | undefined = gptImage2
  ? {
      modelId: gptImage2.id,
      providerId: "azure",
      upstreamModelId: gptImage2.id,
      paramMap: {
        ...gptImage2.apiInput,
        azureApiVersion: gptImage2.azureApiVersion,
        azureSizeMap: gptImage2.azureSizeMap,
        azureResolutionSizeMaps: gptImage2.azureResolutionSizeMaps,
      },
      mediaStagingByOperation: {
        "image-generate": "data-url",
        "image-edit": "multipart-buffer",
      },
    }
  : undefined;

/**
 * Codex CLI binding for `gpt-image-2`. The `codex-imagegen` CLI takes no model
 * argument (one shared `codex login` session), so `upstreamModelId` mirrors the
 * logical id; readiness is the `keySource: "cli"` branch (finding 1iii).
 * Staging is the codex provider-level default (`local-file`, design §1.3).
 */
const gptImage2CodexBinding: ModelProviderBinding | undefined = gptImage2
  ? {
      modelId: gptImage2.id,
      providerId: "codex",
      upstreamModelId: gptImage2.id,
      paramMap: { ...gptImage2.apiInput },
    }
  : undefined;

// ── OpenRouter image dialect (compat-plan §b; spike: .slim/binding-spike.md) ──

/** OpenRouter's image API base URL (spike, 2026-10-20). */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** OpenRouter's image endpoint path — NOT the OpenAI "/v1/images/generations". */
export const OPENROUTER_IMAGE_PATH = "/images";

/** OpenRouter's key env var — the compat family does NOT share OpenAI's key. */
export const OPENROUTER_KEY_ENV = "OPENROUTER_API_KEY";

/**
 * The dialect fields every OpenRouter image model shares.
 *
 * The OpenRouter image dialect (spike §"Dialect quirk"): the body is
 * `prompt` + `aspect_ratio` + optional `resolution` (UPPERCASE 1K/2K/4K) +
 * `input_references` — ONE upstream id serves t2i and i2i (refs 0 allowed),
 * so there is no Kie-style text-only split here. `seed` / `size` /
 * `output_format` are not part of the dialect ⇒ not declared ⇒ not sent.
 */
const OR_IMAGE_FIELDS = {
  prompt: "prompt",
  aspect_ratio: "aspectRatio",
  input_references: "references",
} as const;

/**
 * OpenRouter image bindings — the 10 SHIP upstream ids of the
 * binding-availability spike (2026-10-20).
 *
 * Ids are copied VERBATIM from the spike table. The two catalog models the
 * spike marks "Pollinations only" (`nano-banana-2-lite`, `z-image`) are NOT
 * on OpenRouter ⇒ no binding here (they arrive with the Pollinations lane).
 */
const openRouterImageBindings: ModelProviderBinding[] = [
  // google-nano-banana → OR "google/gemini-2.5-flash-image" (the original
  // Nano Banana). OR caps this model at 3 reference images; the catalog entry
  // is text-only (maxImages 0) — the cap is the binding's, not the catalog's.
  // The model has NO resolution parameter upstream ⇒ `resolution` is not sent.
  {
    modelId: "google-nano-banana",
    providerId: "openrouter",
    upstreamModelId: "google/gemini-2.5-flash-image",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_IMAGE_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    paramMap: {
      fields: { ...OR_IMAGE_FIELDS },
      maxReferences: 3,
      referenceMode: "objects",
    },
  },

  // nano-banana-2 → OR "google/gemini-nano-banana-2.1" (the exact "nano-banana-2"
  // id is gone upstream — the line moved to 2.1). Refs 14 ✓ matches the
  // catalog; resolution enum is 1K/2K/4K (UPPERCASE).
  {
    modelId: "nano-banana-2",
    providerId: "openrouter",
    upstreamModelId: "google/gemini-nano-banana-2.1",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_IMAGE_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    paramMap: {
      fields: { ...OR_IMAGE_FIELDS, resolution: "tier" },
      valueMaps: { resolution: { "1k": "1K", "2k": "2K", "4k": "4K" } },
      maxReferences: 14,
      referenceMode: "objects",
    },
  },

  // nano-banana-pro → OR "google/gemini-3-pro-image". Refs 14 upstream vs 8 in
  // the catalog (upstream allows more — the binding keeps the upstream cap).
  {
    modelId: "nano-banana-pro",
    providerId: "openrouter",
    upstreamModelId: "google/gemini-3-pro-image",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_IMAGE_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    paramMap: {
      fields: { ...OR_IMAGE_FIELDS, resolution: "tier" },
      valueMaps: { resolution: { "1k": "1K", "2k": "2K", "4k": "4K" } },
      maxReferences: 14,
      referenceMode: "objects",
    },
  },

  // seedream-5-lite → OR "bytedance-seed/seedream-5-0-lite". Refs 14 ✓; the
  // upstream resolution enum 2K/4K exactly matches the catalog's
  // qualityOptions ["2k","4k"] ⇒ the tier maps 1:1 (uppercased).
  {
    modelId: "seedream-5-lite",
    providerId: "openrouter",
    upstreamModelId: "bytedance-seed/seedream-5-0-lite",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_IMAGE_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    paramMap: {
      fields: { ...OR_IMAGE_FIELDS, resolution: "tier" },
      valueMaps: { resolution: { "2k": "2K", "4k": "4K" } },
      maxReferences: 14,
      referenceMode: "objects",
    },
  },

  // seedream-5-pro → OR "bytedance-seed/seedream-5-0-pro". Refs 14 upstream vs
  // 10 in the catalog; upstream resolution enum 1K/2K matches the catalog's
  // ["1k","2k"].
  {
    modelId: "seedream-5-pro",
    providerId: "openrouter",
    upstreamModelId: "bytedance-seed/seedream-5-0-pro",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_IMAGE_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    paramMap: {
      fields: { ...OR_IMAGE_FIELDS, resolution: "tier" },
      valueMaps: {
        resolution: { "1k": "1K", "2k": "2K" },
        // "auto" is not in the endpoint enum — drop it and let the server
        // default (verified live: the router 400s "auto" outright).
        aspect_ratio: { auto: null },
      },
      maxReferences: 14,
      referenceMode: "objects",
    },
  },

  // grok-imagine-image → OR "x-ai/grok-imagine-image-2.0".
  // NOTE — REF-CAP MISMATCH: OpenRouter accepts max 3 reference images for
  // every Grok image variant, the catalog allows 5 (maxImages 5). The binding
  // keeps the upstream cap (3); the catalog is NOT changed here.
  // The catalog entry exposes no quality tier (supportsQuality false) and OR's
  // Grok quality vocabulary is low/medium (not the catalog's 1k/2k/4k) ⇒ only
  // the resolution tier is sent.
  {
    modelId: "grok-imagine-image",
    providerId: "openrouter",
    upstreamModelId: "x-ai/grok-imagine-image-2.0",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_IMAGE_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    paramMap: {
      fields: { ...OR_IMAGE_FIELDS, resolution: "tier" },
      valueMaps: {
        resolution: { "1k": "1K", "2k": "2K" },
        // "auto" is not in the endpoint enum — drop it and let the server
        // default (verified live: the router 400s "auto" outright).
        aspect_ratio: { auto: null },
      },
      maxReferences: 3,
      referenceMode: "objects",
    },
  },

  // grok-imagine-image → OR "x-ai/grok-imagine-image-quality" — the upstream
  // QUALITY variant of the same catalog model (the spike lists both ids).
  // Same caps as the 2.0 entry above (refs ≤ 3, resolution 1K/2K). Kept as a
  // separate static binding so the id is pinned and selectable; the default
  // binding resolution picks the 2.0 entry above.
  {
    modelId: "grok-imagine-image",
    providerId: "openrouter",
    upstreamModelId: "x-ai/grok-imagine-image-quality",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_IMAGE_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    paramMap: {
      fields: { ...OR_IMAGE_FIELDS, resolution: "tier" },
      valueMaps: {
        resolution: { "1k": "1K", "2k": "2K" },
        // "auto" is not in the endpoint enum — drop it and let the server
        // default (verified live: the router 400s "auto" outright).
        aspect_ratio: { auto: null },
      },
      maxReferences: 3,
      referenceMode: "objects",
    },
  },

  // gpt-image-2 → OR "openai/gpt-image-2". Refs 16 ✓; ratios incl. 21:9.
  // NOTE — QUALITY-VOCABULARY MISMATCH: the upstream quality enum is
  // auto/low/medium/high, the catalog's tier vocabulary is 1k/2k/4k ⇒ mapped
  // here (1k→low, 2k→medium, 4k→high). The catalog is NOT changed; the
  // upstream-only tiers (xhigh/max) are unreachable from the catalog picker.
  {
    modelId: "gpt-image-2",
    providerId: "openrouter",
    upstreamModelId: "openai/gpt-image-2",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_IMAGE_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    paramMap: {
      fields: { ...OR_IMAGE_FIELDS, quality: "tier" },
      valueMaps: { quality: { "1k": "low", "2k": "medium", "4k": "high" } },
      maxReferences: 16,
      referenceMode: "objects",
    },
  },

  // gpt-image-2-5-flare → OR "openai/gpt-image-2.5-flare". Refs 16 ✓; quality
  // auto…max upstream (adds xhigh/max) vs the catalog's 1k/2k/4k ⇒ mapped
  // here, same mismatch note as gpt-image-2 above.
  {
    modelId: "gpt-image-2-5-flare",
    providerId: "openrouter",
    upstreamModelId: "openai/gpt-image-2.5-flare",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_IMAGE_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    paramMap: {
      fields: { ...OR_IMAGE_FIELDS, quality: "tier" },
      valueMaps: { quality: { "1k": "low", "2k": "medium", "4k": "high" } },
      maxReferences: 16,
      referenceMode: "objects",
    },
  },

  // gpt-image-2-5-sunburst → OR "openai/gpt-image-2.5-sunburst" — same caps
  // and same quality-vocabulary mapping as gpt-image-2-5-flare.
  {
    modelId: "gpt-image-2-5-sunburst",
    providerId: "openrouter",
    upstreamModelId: "openai/gpt-image-2.5-sunburst",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_IMAGE_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    paramMap: {
      fields: { ...OR_IMAGE_FIELDS, quality: "tier" },
      valueMaps: { quality: { "1k": "low", "2k": "medium", "4k": "high" } },
      maxReferences: 16,
      referenceMode: "objects",
    },
  },

  // qwen-image-2.1-turbo → OR "qwen/qwen-image-2.1-turbo" (verified live
  // 2026-10-26: sole provider alibaba; despite the endpoint listing's
  // `seed: boolean` metadata, runtime validation REQUIRES a numeric seed
  // (ZodError otherwise) — trust runtime, not the listing. Absent seed ⇒
  // field omitted. $0.0184 flat at 1K+2K).
  {
    modelId: "qwen-image-2.1-turbo",
    providerId: "openrouter",
    upstreamModelId: "qwen/qwen-image-2.1-turbo",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_IMAGE_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    paramMap: {
      fields: { ...OR_IMAGE_FIELDS, resolution: "tier", seed: "seed" },
      valueMaps: {
        resolution: { "1k": "1K", "2k": "2K" },
        // "auto" is not in the endpoint enum — drop it and let the server
        // default (verified live: the router 400s "auto" outright).
        aspect_ratio: { auto: null },
      },
      maxReferences: 4,
      referenceMode: "objects",
    },
  },

  // qwen-image-2.1-pro → OR "qwen/qwen-image-2.1-pro" — 2.5x quality tier
  // ($0.046), same caps as turbo. Same numeric-seed correction applies:
  // the endpoint listing claims boolean, runtime requires a number.
  {
    modelId: "qwen-image-2.1-pro",
    providerId: "openrouter",
    upstreamModelId: "qwen/qwen-image-2.1-pro",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_IMAGE_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    paramMap: {
      fields: { ...OR_IMAGE_FIELDS, resolution: "tier", seed: "seed" },
      valueMaps: {
        resolution: { "1k": "1K", "2k": "2K" },
        // "auto" is not in the endpoint enum — drop it and let the server
        // default (verified live: the router 400s "auto" outright).
        aspect_ratio: { auto: null },
      },
      maxReferences: 4,
      referenceMode: "objects",
    },
  },

  // Sweep 2026-10-21 — verified live via /api/v1/images/models/{id}/endpoints.
  // Pricing captured 2026-10-21; re-check before bulk use (OpenRouter reprices).
  // flux-3-image-klein → OR "black-forest-labs/flux-3-image-klein" ($0.008 768
  // → $0.036 4K, size-scaled — the only per-size pricing in this batch).
  {
    modelId: "flux-3-image-klein",
    providerId: "openrouter",
    upstreamModelId: "black-forest-labs/flux-3-image-klein",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_IMAGE_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    paramMap: {
      fields: { ...OR_IMAGE_FIELDS, resolution: "tier" },
      valueMaps: {
        resolution: { "1k": "1K", "1.5k": "1.5K", "2k": "2K", "4k": "4K" },
        aspect_ratio: { auto: null },
      },
      maxReferences: 10,
      referenceMode: "objects",
    },
  },

  // seedream-5-0-flash → OR "bytedance-seed/seedream-5-0-flash" ($0.018 flat).
  // Endpoint declares seed:boolean (same trap as qwen) — seed is NOT mapped,
  // so it is never sent; the server default applies.
  {
    modelId: "seedream-5-0-flash",
    providerId: "openrouter",
    upstreamModelId: "bytedance-seed/seedream-5-0-flash",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_IMAGE_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    paramMap: {
      fields: { ...OR_IMAGE_FIELDS, resolution: "tier" },
      valueMaps: {
        resolution: { "1k": "1K", "2k": "2K" },
        aspect_ratio: { auto: null },
      },
      maxReferences: 14,
      referenceMode: "objects",
    },
  },

  // recraft-v4-1-flash → OR "recraft/recraft-v4.1-flash" ($0.007 flat).
  // Text-only on OpenRouter (endpoint declares no references field);
  // no resolution tiers either.
  {
    modelId: "recraft-v4-1-flash",
    providerId: "openrouter",
    upstreamModelId: "recraft/recraft-v4.1-flash",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_IMAGE_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    paramMap: {
      fields: { ...OR_IMAGE_FIELDS, aspect_ratio: "aspectRatio" },
      valueMaps: {
        aspect_ratio: { auto: null },
      },
    },
  },

  // mai-image-2.6-flash → OR "microsoft/mai-image-2.6-flash" (token-metered:
  // input text/image + output image tokens, NOT per-image). No resolution
  // tiers; refs 0-5 per the endpoint record (shape unverified — objects per
  // OR docs, confirm on first live use).
  {
    modelId: "mai-image-2.6-flash",
    providerId: "openrouter",
    upstreamModelId: "microsoft/mai-image-2.6-flash",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_IMAGE_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    paramMap: {
      fields: { ...OR_IMAGE_FIELDS },
      valueMaps: {
        aspect_ratio: { auto: null },
      },
      maxReferences: 5,
      referenceMode: "objects",
    },
  },

  // recraft-v4-styles-vector → OR "recraft/recraft-v4-styles-vector"
  // ($0.05/image + $0.005/input ref). Upstream REQUIRES ≥1 reference;
  // a text-only call will fail server-side — the UI should steer users
  // to attach one (max 10).
  {
    modelId: "recraft-v4-styles-vector",
    providerId: "openrouter",
    upstreamModelId: "recraft/recraft-v4-styles-vector",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_IMAGE_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    paramMap: {
      fields: { ...OR_IMAGE_FIELDS },
      valueMaps: {
        aspect_ratio: { auto: null },
      },
      maxReferences: 10,
      referenceMode: "objects",
    },
  },

  // krea-2-medium-turbo → OR "krea/krea-2-medium-turbo". Single tier (1K),
  // refs 0-1; endpoint declares seed:boolean — NOT mapped (same trap as
  // qwen/seedream). WARNING: endpoint record carries no pricing — cost
  // UNVERIFIED, confirm before bulk use.
  {
    modelId: "krea-2-medium-turbo",
    providerId: "openrouter",
    upstreamModelId: "krea/krea-2-medium-turbo",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_IMAGE_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    paramMap: {
      fields: { ...OR_IMAGE_FIELDS },
      valueMaps: {
        aspect_ratio: { auto: null },
      },
      maxReferences: 1,
      referenceMode: "objects",
    },
  },

  // krea-2-medium → OR "krea/krea-2-medium" — as turbo; same caveats.
  {
    modelId: "krea-2-medium",
    providerId: "openrouter",
    upstreamModelId: "krea/krea-2-medium",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_IMAGE_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    paramMap: {
      fields: { ...OR_IMAGE_FIELDS },
      valueMaps: {
        aspect_ratio: { auto: null },
      },
      maxReferences: 1,
      referenceMode: "objects",
    },
  },
];

// ── Cross-provider media store (shared by the Pollinations + OpenRouter lanes) ──

/**
 * Pollinations' MEDIA STORE upload endpoint — a SIBLING host of the generation
 * base URL (findings §3: `POST https://media.pollinations.ai/upload`;
 * multipart / raw / base64, ≤400 MiB, 30-day lifecycle).
 *
 * SHARED by two lanes:
 *  - the Pollinations image bindings, whose backend takes reference images as
 *    URLs (a local file has to be uploaded to the media store first — a
 *    data-url in the request body is impractical), and
 *  - the OpenRouter VIDEO bindings, which document NO upload endpoint of
 *    their own: their local frames are staged through this store as a
 *    CROSS-PROVIDER upload, authenticated with the POLLINATIONS key
 *    (`mediaUpload.keyProviderId`), not with the OpenRouter one.
 *
 * Declared HERE (before the OpenRouter video bindings) because that array is
 * a module-level literal — a later declaration would be in the temporal dead
 * zone when the array is evaluated.
 */
export const POLLINATIONS_MEDIA_UPLOAD_URL = "https://media.pollinations.ai/upload";

// ── OpenRouter VIDEO dialect (compat-plan §b; sweep 2026-10-21) ──────────────

/**
 * OpenRouter's VIDEO endpoint path — `POST {base}/videos`, i.e.
 * `https://openrouter.ai/api/v1/videos` (the same absolute URL the images
 * lane reaches through `OPENROUTER_BASE_URL` + `/images`).
 */
export const OPENROUTER_VIDEO_PATH = "/videos";

/**
 * The dialect fields the OpenRouter VIDEO endpoint takes (contract verified
 * 2026-10-21):
 *
 *   model            — the upstream model id
 *   prompt           — the prompt text (optional)
 *   duration         — the clip length in SECONDS (an int)
 *   resolution       — the resolution tier ("720p", "768p", …)
 *   aspect_ratio     — the aspect ratio (optional; "auto" is NOT in the
 *                      upstream enum — the router 400s on it, so it is dropped)
 *   seed             — the seed (optional, numeric)
 *   generate_audio   — the audio flag (bool)
 *   frame_images     — [{type:"image_url", image_url:{url}, frame_type:
 *                      "first_frame"|"last_frame"}]
 *   input_references — [{type:"image_url"|"audio_url"|"video_url",
 *                      "<x>_url":{url}}]
 *
 * A field the binding does NOT declare is never sent (the backend 400s on
 * unexpected shapes) and a field without a value is omitted — never null.
 */
const OR_VIDEO_FIELDS = {
  prompt: "prompt",
  duration: "duration",
  resolution: "resolution",
  aspect_ratio: "aspectRatio",
  seed: "seed",
  generate_audio: "sound",
  frame_images: "frames",
  input_references: "inputReferences",
} as const;

/**
 * The OpenRouter video bindings — the swept upstream ids of
 * `docs/compat-endpoints.md` (video table, 2026-10-21).
 *
 * Two rules shape every binding:
 *
 *  - REFERENCES ARE HTTPS-URLS ONLY. The video endpoint takes no `data:` URI
 *    and OpenRouter documents NO upload endpoint of its own ⇒ the binding
 *    stages media as "remote-url": an already-public URL passes through, a
 *    LOCAL file has to be uploaded first. The upload itself is CROSS-PROVIDER
 *    — the bytes go to the Pollinations MEDIA STORE
 *    (`media.pollinations.ai/upload`), authenticated with the POLLINATIONS key
 *    (`mediaUpload.keyProviderId`), because OpenRouter's own key does not
 *    authenticate that host. A missing Pollinations key fails LOUDLY (the
 *    family's `uploadMedia` hook) — a silently dropped reference is worse than
 *    a surfaced error.
 *  - THE CATALOG ENTRY IS THE SOURCE OF THE CAPS. The binding re-clamps the
 *    duration to the model's own limits and drops the tiers the upstream enum
 *    rejects (the "auto" ratio / an unsupported resolution) instead of sending
 *    a value the router would 400 on.
 *
 * The upstream ids come from the live listing (2026-10-21); the per-model caps
 * from `docs/compat-endpoints.md` + the binding-availability spike. Pricing is
 * NOT captured yet (the registry's pricing column still says "record at
 * binding time") — the cost of a live test is UNVERIFIED.
 */
const openRouterVideoBindings: ModelProviderBinding[] = [
  // google/veo-3.1-lite → catalog `veo3_lite`. Caps: 16:9/9:16, 720p/1080p
  // (NO 4k — the catalog offers one), durations 4/6/8, first + last frame,
  // audio. The catalog entry has NO duration picker (the Kie Veo payload sends
  // no duration), so the binding carries its own default (6 s — the middle of
  // the model's own 4/6/8) and clamps to [4, 8].
  {
    modelId: "veo3_lite",
    providerId: "openrouter",
    upstreamModelId: "google/veo-3.1-lite",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_VIDEO_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    mediaStaging: "remote-url",
    // CROSS-PROVIDER upload: OpenRouter documents no upload endpoint of its
    // own, so a LOCAL frame is staged through the Pollinations media store —
    // authenticated with the POLLINATIONS key (`keyProviderId`), not with the
    // OpenRouter one (the two backends never share a key).
    mediaUpload: {
      url: POLLINATIONS_MEDIA_UPLOAD_URL,
      field: "file",
      encoding: "multipart",
      keyProviderId: "pollinations",
    },
    paramMap: {
      fields: {
        prompt: OR_VIDEO_FIELDS.prompt,
        duration: OR_VIDEO_FIELDS.duration,
        resolution: OR_VIDEO_FIELDS.resolution,
        aspect_ratio: OR_VIDEO_FIELDS.aspect_ratio,
        generate_audio: OR_VIDEO_FIELDS.generate_audio,
        frame_images: OR_VIDEO_FIELDS.frame_images,
      },
      valueMaps: {
        // "4k" is not in the upstream enum (720p/1080p only) — drop it and let
        // the server default apply (the images lane's verified auto-drop).
        resolution: { "4k": null },
        // "auto" is not in the upstream enum — the router 400s on it.
        aspect_ratio: { auto: null },
      },
      maxFrames: 2,
      durationMin: 4,
      durationMax: 8,
      defaultDuration: 6,
    },
  },

  // x-ai/grok-imagine-video-1.5 → catalog `grok-imagine-1-5-preview`. Caps:
  // 16:9/9:16/1:1/4:3/3:2, 480p/720p/1080p, durations 1–15, FIRST frame only.
  // The catalog's only image handle is "resource" (it is even REQUIRED) ⇒ the
  // staged reference rides as the first FRAME (`referenceFrame`), not as an
  // `input_references` entry.
  {
    modelId: "grok-imagine-1-5-preview",
    providerId: "openrouter",
    upstreamModelId: "x-ai/grok-imagine-video-1.5",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_VIDEO_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    mediaStaging: "remote-url",
    // CROSS-PROVIDER upload: OpenRouter documents no upload endpoint of its
    // own, so a LOCAL frame is staged through the Pollinations media store —
    // authenticated with the POLLINATIONS key (`keyProviderId`), not with the
    // OpenRouter one (the two backends never share a key).
    mediaUpload: {
      url: POLLINATIONS_MEDIA_UPLOAD_URL,
      field: "file",
      encoding: "multipart",
      keyProviderId: "pollinations",
    },
    paramMap: {
      fields: {
        prompt: OR_VIDEO_FIELDS.prompt,
        duration: OR_VIDEO_FIELDS.duration,
        resolution: OR_VIDEO_FIELDS.resolution,
        aspect_ratio: OR_VIDEO_FIELDS.aspect_ratio,
        frame_images: OR_VIDEO_FIELDS.frame_images,
      },
      valueMaps: {
        // The catalog offers "auto", "3:4" and "2:3" — none of them are in the
        // upstream enum ⇒ dropped (the server default applies).
        aspect_ratio: { auto: null, "3:4": null, "2:3": null },
      },
      maxFrames: 1,
      referenceFrame: "first_frame",
      durationMin: 1,
      durationMax: 15,
    },
  },

  // x-ai/grok-imagine-video-1.5-lite → the same catalog entry (the lite
  // variant of the same model — same caps). A SECOND static binding so the id
  // is pinned; the default binding resolution picks the entry above.
  {
    modelId: "grok-imagine-1-5-preview",
    providerId: "openrouter",
    upstreamModelId: "x-ai/grok-imagine-video-1.5-lite",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_VIDEO_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    mediaStaging: "remote-url",
    // CROSS-PROVIDER upload: OpenRouter documents no upload endpoint of its
    // own, so a LOCAL frame is staged through the Pollinations media store —
    // authenticated with the POLLINATIONS key (`keyProviderId`), not with the
    // OpenRouter one (the two backends never share a key).
    mediaUpload: {
      url: POLLINATIONS_MEDIA_UPLOAD_URL,
      field: "file",
      encoding: "multipart",
      keyProviderId: "pollinations",
    },
    paramMap: {
      fields: {
        prompt: OR_VIDEO_FIELDS.prompt,
        duration: OR_VIDEO_FIELDS.duration,
        resolution: OR_VIDEO_FIELDS.resolution,
        aspect_ratio: OR_VIDEO_FIELDS.aspect_ratio,
        frame_images: OR_VIDEO_FIELDS.frame_images,
      },
      valueMaps: {
        aspect_ratio: { auto: null, "3:4": null, "2:3": null },
      },
      maxFrames: 1,
      referenceFrame: "first_frame",
      durationMin: 1,
      durationMax: 15,
    },
  },

  // kwaiv/kling-3.0-pro → catalog `kling-3.0`. Caps: 720p only, durations
  // 3–15, first + last frame, audio. The catalog models the quality as a
  // MODE (std/pro/4K) and offers no resolution tier ⇒ the binding pins the
  // resolution as a constant (720p — the only tier upstream has). The "pro"
  // variant is the default binding (the catalog's default mode is "pro").
  {
    modelId: "kling-3.0",
    providerId: "openrouter",
    upstreamModelId: "kwaiv/kling-3.0-pro",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_VIDEO_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    mediaStaging: "remote-url",
    // CROSS-PROVIDER upload: OpenRouter documents no upload endpoint of its
    // own, so a LOCAL frame is staged through the Pollinations media store —
    // authenticated with the POLLINATIONS key (`keyProviderId`), not with the
    // OpenRouter one (the two backends never share a key).
    mediaUpload: {
      url: POLLINATIONS_MEDIA_UPLOAD_URL,
      field: "file",
      encoding: "multipart",
      keyProviderId: "pollinations",
    },
    paramMap: {
      fields: {
        prompt: OR_VIDEO_FIELDS.prompt,
        duration: OR_VIDEO_FIELDS.duration,
        aspect_ratio: OR_VIDEO_FIELDS.aspect_ratio,
        generate_audio: OR_VIDEO_FIELDS.generate_audio,
        frame_images: OR_VIDEO_FIELDS.frame_images,
      },
      constants: { resolution: "720p" },
      maxFrames: 2,
      durationMin: 3,
      durationMax: 15,
    },
  },

  // kwaiv/kling-3.0-std → the same catalog entry (the standard variant of
  // the same model — same caps). A SECOND static binding so the id is pinned.
  {
    modelId: "kling-3.0",
    providerId: "openrouter",
    upstreamModelId: "kwaiv/kling-3.0-std",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_VIDEO_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    mediaStaging: "remote-url",
    // CROSS-PROVIDER upload: OpenRouter documents no upload endpoint of its
    // own, so a LOCAL frame is staged through the Pollinations media store —
    // authenticated with the POLLINATIONS key (`keyProviderId`), not with the
    // OpenRouter one (the two backends never share a key).
    mediaUpload: {
      url: POLLINATIONS_MEDIA_UPLOAD_URL,
      field: "file",
      encoding: "multipart",
      keyProviderId: "pollinations",
    },
    paramMap: {
      fields: {
        prompt: OR_VIDEO_FIELDS.prompt,
        duration: OR_VIDEO_FIELDS.duration,
        aspect_ratio: OR_VIDEO_FIELDS.aspect_ratio,
        generate_audio: OR_VIDEO_FIELDS.generate_audio,
        frame_images: OR_VIDEO_FIELDS.frame_images,
      },
      constants: { resolution: "720p" },
      maxFrames: 2,
      durationMin: 3,
      durationMax: 15,
    },
  },

  // bytedance/seedance-2.0-fast → catalog `seedance-2-fast`. Caps: 480p/720p
  // (the catalog also offers 1080p — dropped), durations 4–15, first + last
  // frame. The upstream reference cap is UNVERIFIED ⇒ the conservative cap of
  // the compat video lane (2) applies.
  {
    modelId: "seedance-2-fast",
    providerId: "openrouter",
    upstreamModelId: "bytedance/seedance-2.0-fast",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_VIDEO_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    mediaStaging: "remote-url",
    // CROSS-PROVIDER upload: OpenRouter documents no upload endpoint of its
    // own, so a LOCAL frame is staged through the Pollinations media store —
    // authenticated with the POLLINATIONS key (`keyProviderId`), not with the
    // OpenRouter one (the two backends never share a key).
    mediaUpload: {
      url: POLLINATIONS_MEDIA_UPLOAD_URL,
      field: "file",
      encoding: "multipart",
      keyProviderId: "pollinations",
    },
    paramMap: {
      fields: {
        prompt: OR_VIDEO_FIELDS.prompt,
        duration: OR_VIDEO_FIELDS.duration,
        resolution: OR_VIDEO_FIELDS.resolution,
        aspect_ratio: OR_VIDEO_FIELDS.aspect_ratio,
        // Seedance renders audio by default (`generate_audio: true` in the
        // live model record) and the upstream policy REJECTS some clips for
        // audio copyright — without this field the catalog's sound toggle
        // could not turn it off (verified live on the mini variant).
        generate_audio: OR_VIDEO_FIELDS.generate_audio,
        frame_images: OR_VIDEO_FIELDS.frame_images,
        input_references: OR_VIDEO_FIELDS.input_references,
      },
      valueMaps: {
        resolution: { "1080p": null },
        // "adaptive" is a Kie-ism — the upstream enum has no such ratio.
        aspect_ratio: { adaptive: null },
      },
      maxFrames: 2,
      maxReferences: 2,
      durationMin: 4,
      durationMax: 15,
    },
  },

  // bytedance/seedance-2.0-mini → catalog `seedance-2-mini`. Caps: 480p/720p,
  // durations 4–15, first + last frame, seed ✓ (the only swept model whose
  // endpoint record carries a seed).
  {
    modelId: "seedance-2-mini",
    providerId: "openrouter",
    upstreamModelId: "bytedance/seedance-2.0-mini",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_VIDEO_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    mediaStaging: "remote-url",
    // CROSS-PROVIDER upload: OpenRouter documents no upload endpoint of its
    // own, so a LOCAL frame is staged through the Pollinations media store —
    // authenticated with the POLLINATIONS key (`keyProviderId`), not with the
    // OpenRouter one (the two backends never share a key).
    mediaUpload: {
      url: POLLINATIONS_MEDIA_UPLOAD_URL,
      field: "file",
      encoding: "multipart",
      keyProviderId: "pollinations",
    },
    paramMap: {
      fields: {
        prompt: OR_VIDEO_FIELDS.prompt,
        duration: OR_VIDEO_FIELDS.duration,
        resolution: OR_VIDEO_FIELDS.resolution,
        aspect_ratio: OR_VIDEO_FIELDS.aspect_ratio,
        seed: OR_VIDEO_FIELDS.seed,
        generate_audio: OR_VIDEO_FIELDS.generate_audio,
        frame_images: OR_VIDEO_FIELDS.frame_images,
        input_references: OR_VIDEO_FIELDS.input_references,
      },
      valueMaps: {
        aspect_ratio: { adaptive: null },
      },
      maxFrames: 2,
      maxReferences: 2,
      durationMin: 4,
      durationMax: 15,
    },
  },

  // minimax/hailuo-3 → catalog `minimax-h3` (upstream uses "hailuo", not
  // "minimax-h3/*" — a naming drift, see the spike). Caps: 480p/768p, durations
  // 5–15 (the catalog offers 4–15 ⇒ re-clamped), first + last frame. The
  // catalog's resolution strings ("768P"/"2K") do NOT match the upstream enum
  // ⇒ "768P" maps to "768p", "2K" is dropped.
  {
    modelId: "minimax-h3",
    providerId: "openrouter",
    upstreamModelId: "minimax/hailuo-3",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_VIDEO_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    mediaStaging: "remote-url",
    // CROSS-PROVIDER upload: OpenRouter documents no upload endpoint of its
    // own, so a LOCAL frame is staged through the Pollinations media store —
    // authenticated with the POLLINATIONS key (`keyProviderId`), not with the
    // OpenRouter one (the two backends never share a key).
    mediaUpload: {
      url: POLLINATIONS_MEDIA_UPLOAD_URL,
      field: "file",
      encoding: "multipart",
      keyProviderId: "pollinations",
    },
    paramMap: {
      fields: {
        prompt: OR_VIDEO_FIELDS.prompt,
        duration: OR_VIDEO_FIELDS.duration,
        resolution: OR_VIDEO_FIELDS.resolution,
        aspect_ratio: OR_VIDEO_FIELDS.aspect_ratio,
        generate_audio: OR_VIDEO_FIELDS.generate_audio,
        frame_images: OR_VIDEO_FIELDS.frame_images,
        input_references: OR_VIDEO_FIELDS.input_references,
      },
      valueMaps: {
        resolution: { "768P": "768p", "2K": null },
      },
      maxFrames: 2,
      maxReferences: 2,
      durationMin: 5,
      durationMax: 15,
    },
  },

  // minimax/hailuo-3-max → the same catalog entry (the max variant of the
  // same model — same caps). A SECOND static binding so the id is pinned.
  {
    modelId: "minimax-h3",
    providerId: "openrouter",
    upstreamModelId: "minimax/hailuo-3-max",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_VIDEO_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    mediaStaging: "remote-url",
    // CROSS-PROVIDER upload: OpenRouter documents no upload endpoint of its
    // own, so a LOCAL frame is staged through the Pollinations media store —
    // authenticated with the POLLINATIONS key (`keyProviderId`), not with the
    // OpenRouter one (the two backends never share a key).
    mediaUpload: {
      url: POLLINATIONS_MEDIA_UPLOAD_URL,
      field: "file",
      encoding: "multipart",
      keyProviderId: "pollinations",
    },
    paramMap: {
      fields: {
        prompt: OR_VIDEO_FIELDS.prompt,
        duration: OR_VIDEO_FIELDS.duration,
        resolution: OR_VIDEO_FIELDS.resolution,
        aspect_ratio: OR_VIDEO_FIELDS.aspect_ratio,
        frame_images: OR_VIDEO_FIELDS.frame_images,
        input_references: OR_VIDEO_FIELDS.input_references,
      },
      valueMaps: {
        resolution: { "768P": "768p", "2K": null },
      },
      maxFrames: 2,
      maxReferences: 2,
      durationMin: 5,
      durationMax: 15,
    },
  },

  // alibaba/wan-2.6 → catalog `wan-2.6` (added by this sweep). Caps: 16:9/9:16,
  // 720p/1080p-class, durations 5/10, FIRST frame only.
  {
    modelId: "wan-2.6",
    providerId: "openrouter",
    upstreamModelId: "alibaba/wan-2.6",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_VIDEO_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    mediaStaging: "remote-url",
    // CROSS-PROVIDER upload: OpenRouter documents no upload endpoint of its
    // own, so a LOCAL frame is staged through the Pollinations media store —
    // authenticated with the POLLINATIONS key (`keyProviderId`), not with the
    // OpenRouter one (the two backends never share a key).
    mediaUpload: {
      url: POLLINATIONS_MEDIA_UPLOAD_URL,
      field: "file",
      encoding: "multipart",
      keyProviderId: "pollinations",
    },
    paramMap: {
      fields: {
        prompt: OR_VIDEO_FIELDS.prompt,
        duration: OR_VIDEO_FIELDS.duration,
        resolution: OR_VIDEO_FIELDS.resolution,
        aspect_ratio: OR_VIDEO_FIELDS.aspect_ratio,
        generate_audio: OR_VIDEO_FIELDS.generate_audio,
        frame_images: OR_VIDEO_FIELDS.frame_images,
      },
      maxFrames: 1,
      durationMin: 5,
      durationMax: 10,
    },
  },

  // black-forest-labs/flux-video-edit → catalog `flux-video-edit` (added by
  // this sweep). The caps VARY upstream ("edit/upscale variants, caps vary")
  // ⇒ only the prompt and the source VIDEO are sent — no duration, no
  // resolution, no aspect ratio (an unknown field is a 400).
  {
    modelId: "flux-video-edit",
    providerId: "openrouter",
    upstreamModelId: "black-forest-labs/flux-video-edit",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_VIDEO_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    mediaStaging: "remote-url",
    // CROSS-PROVIDER upload: OpenRouter documents no upload endpoint of its
    // own, so a LOCAL frame is staged through the Pollinations media store —
    // authenticated with the POLLINATIONS key (`keyProviderId`), not with the
    // OpenRouter one (the two backends never share a key).
    mediaUpload: {
      url: POLLINATIONS_MEDIA_UPLOAD_URL,
      field: "file",
      encoding: "multipart",
      keyProviderId: "pollinations",
    },
    paramMap: {
      fields: {
        prompt: OR_VIDEO_FIELDS.prompt,
        input_references: OR_VIDEO_FIELDS.input_references,
      },
      maxReferences: 1,
    },
  },

  // black-forest-labs/flux-video-upscale → catalog `flux-video-upscale` (added
  // by this sweep). Same caps as the edit variant: the source video rides as
  // an `input_references` entry, nothing else is sent.
  {
    modelId: "flux-video-upscale",
    providerId: "openrouter",
    upstreamModelId: "black-forest-labs/flux-video-upscale",
    family: "standard",
    baseUrl: OPENROUTER_BASE_URL,
    pathOverride: OPENROUTER_VIDEO_PATH,
    keyEnv: OPENROUTER_KEY_ENV,
    mediaStaging: "remote-url",
    // CROSS-PROVIDER upload: OpenRouter documents no upload endpoint of its
    // own, so a LOCAL frame is staged through the Pollinations media store —
    // authenticated with the POLLINATIONS key (`keyProviderId`), not with the
    // OpenRouter one (the two backends never share a key).
    mediaUpload: {
      url: POLLINATIONS_MEDIA_UPLOAD_URL,
      field: "file",
      encoding: "multipart",
      keyProviderId: "pollinations",
    },
    paramMap: {
      fields: {
        prompt: OR_VIDEO_FIELDS.prompt,
        input_references: OR_VIDEO_FIELDS.input_references,
      },
      maxReferences: 1,
    },
  },
];

// ── Pollinations image dialect (compat-plan §b; spike: .slim/binding-spike.md) ──

/** Pollinations' generation base URL (spike, 2026-10-20). */
export const POLLINATIONS_BASE_URL = "https://gen.pollinations.ai";

/** Pollinations' OpenAI-compatible SYNC image path (spike: `/v1/images/generations`). */
export const POLLINATIONS_IMAGE_PATH = "/v1/images/generations";

/** Pollinations' key env var — the compat family does NOT share one key. */
export const POLLINATIONS_KEY_ENV = "POLLINATIONS_API_KEY";

/**
 * The dialect fields every Pollinations image model shares.
 *
 * The Pollinations SYNC leg (`POST /v1/images/generations`, OpenAI-compatible)
 * speaks the backend's NATIVE parameter names (findings §3 + starter spec
 * paramMap table):
 *
 *  - `prompt` — the prompt text.
 *  - `width` / `height` — the pixel size. The backend has NO aspect-ratio
 *    parameter ("aspect only derivable via width/height"), so the catalog's
 *    aspect ratio does NOT ride along; only the custom pixel size does
 *    (`customWidth`/`customHeight` → the numeric width/height fields — the
 *    "size" source would produce a "WxH" STRING, which this dialect does not
 *    take).
 *  - `seed` — the seed.
 *  - `image` — the reference images. The value is the ARRAY of staged URLs
 *    (the OpenAI `images/edits` shape — Pollinations exposes
 *    `/v1/images/edits` too, spike line 59) capped at the model's upstream
 *    reference cap. The native GET route takes a single `image=` url; the
 *    JSON body takes the array, and the upstream model catalogue advertises
 *    multi-reference caps (up to 16) that a single-url field could not
 *    express. A binding that needs the scalar form sets
 *    `referenceMode: "first"`.
 *
 * NOT sent (undocumented upstream — findings §3: "quality, mode, sound — none
 * documented"): the quality/resolution tier, the aspect ratio, a negative
 * prompt. The catalog's tier picker therefore has no effect on this lane.
 */
const POL_IMAGE_FIELDS = {
  prompt: "prompt",
  width: "width",
  height: "height",
  seed: "seed",
} as const;

/**
 * One Pollinations image binding.
 *
 * Every Pollinations binding shares the backend (base URL + key env + media
 * store + staging strategy); only the upstream model id and the reference cap
 * differ per model (the binding-availability spike, 2026-10-20).
 *
 * `maxReferences` = the model's UPSTREAM reference cap (spike), not the
 * catalog's: `0` ⇒ the model is text-only upstream and no reference field is
 * declared at all (the family never sends undeclared fields).
 */
function pollinationsImageBinding(
  modelId: string,
  upstreamModelId: string,
  maxReferences: number,
): ModelProviderBinding {
  const fields: Record<string, CompatFieldSource> = { ...POL_IMAGE_FIELDS };
  if (maxReferences > 0) fields.image = "references";
  return {
    modelId,
    providerId: "pollinations",
    upstreamModelId,
    family: "standard",
    baseUrl: POLLINATIONS_BASE_URL,
    pathOverride: POLLINATIONS_IMAGE_PATH,
    keyEnv: POLLINATIONS_KEY_ENV,
    // Reference images are URLs upstream ⇒ local media is uploaded to the
    // media store first (the "remote-url" strategy + the binding's upload
    // endpoint). Already-remote URLs pass through unchanged (pinned rule).
    mediaStaging: "remote-url",
    mediaUpload: {
      url: POLLINATIONS_MEDIA_UPLOAD_URL,
      field: "file",
      encoding: "multipart",
    },
    paramMap: {
      fields,
      maxReferences,
    },
  };
}

/**
 * Pollinations image bindings — the 11 SHIP upstream ids of the
 * binding-availability spike (2026-10-20), copied VERBATIM from the spike's
 * image table (the alias in brackets is the upstream-side model alias, kept
 * here as documentation — the request carries the canonical id).
 *
 * VIDEO IS EXPLICITLY OUT: the Pollinations video lane is the "weak lane"
 * (tighter caps, several ids capped at 5 s, mostly unknown health) — it does
 * not ride this lane.
 */
const pollinationsImageBindings: ModelProviderBinding[] = [
  // google-nano-banana → "google/gemini-2.5-flash-image" (alias
  // "nanobanana") — the original Nano Banana. The catalog entry is text-only
  // (maxImages 0) while the upstream model takes references; the OR lane
  // caps this model at 3 refs and Pollinations publishes no separate cap ⇒
  // 3 is used here as the conservative upstream cap.
  pollinationsImageBinding("google-nano-banana", "google/gemini-2.5-flash-image", 3),

  // nano-banana-2 → "google/gemini-3.1-flash-image" (alias "nanobanana2") —
  // the successor line (the exact "nano-banana-2" id is gone upstream).
  // Refs 14 ✓ matches the catalog. ⚠ Health watch: the spike saw this
  // listing DOWN (0/81) — the binding stays, the health is the backend's.
  pollinationsImageBinding("nano-banana-2", "google/gemini-3.1-flash-image", 14),

  // nano-banana-pro → "google/gemini-3-pro-image" (alias
  // "nanobanana-pro"). Refs 14 upstream vs 8 in the catalog (upstream allows
  // more — the binding keeps the upstream cap).
  pollinationsImageBinding("nano-banana-pro", "google/gemini-3-pro-image", 14),

  // nano-banana-2-lite → "google/gemini-3.1-flash-lite-image" (aliases
  // "nanobanana2lite" / "nanobanana-2-lite") — POLLINATIONS ONLY (not on
  // OpenRouter). Refs 14 upstream vs 10 in the catalog.
  pollinationsImageBinding("nano-banana-2-lite", "google/gemini-3.1-flash-lite-image", 14),

  // z-image → "tongyi-mai/z-image-turbo" (alias "z-image") — POLLINATIONS
  // ONLY (not on OpenRouter). Text-only upstream ⇒ NO reference field is
  // declared (maxReferences 0).
  pollinationsImageBinding("z-image", "tongyi-mai/z-image-turbo", 0),

  // seedream-5-lite → "bytedance/seedream-5.0-lite". Refs 14 ✓ matches the
  // catalog. (The upstream resolution enum is NOT sent — Pollinations has no
  // quality/resolution parameter; see POL_IMAGE_FIELDS.)
  pollinationsImageBinding("seedream-5-lite", "bytedance/seedream-5.0-lite", 14),

  // seedream-5-pro → "bytedance/seedream-5.0-pro" (alias "seedream-5-pro").
  // Refs 14 upstream vs 10 in the catalog. ⚠ Health watch: degraded in the
  // spike.
  pollinationsImageBinding("seedream-5-pro", "bytedance/seedream-5.0-pro", 14),

  // grok-imagine-image → "x-ai/grok-imagine-image" (the OR ids are
  // "x-ai/grok-imagine-image-2.0" / "-quality"). REF-CAP MISMATCH: OpenRouter
  // allows 3 refs, Pollinations allows 5 — and only Pollinations reaches the
  // catalog's maxImages 5 ⇒ the binding keeps the upstream cap 5.
  pollinationsImageBinding("grok-imagine-image", "x-ai/grok-imagine-image", 5),

  // gpt-image-2 → "openai/gpt-image-2". Refs 16 ✓. The upstream quality enum
  // (auto/low/medium/high) does NOT match the catalog's 1k/2k/4k picker and
  // Pollinations takes no quality parameter at all ⇒ the tier is not sent.
  pollinationsImageBinding("gpt-image-2", "openai/gpt-image-2", 16),

  // gpt-image-2-5-flare → "openai/gpt-image-2.5-flare". Refs 16 ✓.
  pollinationsImageBinding("gpt-image-2-5-flare", "openai/gpt-image-2.5-flare", 16),

  // gpt-image-2-5-sunburst → "openai/gpt-image-2.5-sunburst". Refs 16 ✓.
  pollinationsImageBinding("gpt-image-2-5-sunburst", "openai/gpt-image-2.5-sunburst", 16),
];

/**
 * C1 static binding set: 11 image models + 17 video models, each with a Kie
 * binding (`upstreamModelId = apiId`), plus Azure and Codex for `gpt-image-2`,
 * OpenRouter for the 19 SHIP image models and the 12 swept VIDEO models, and
 * Pollinations for the 11 SHIP image models → 63 code-defined bindings.
 * Immutable by convention — merge copies for overrides (the registry never
 * mutates these).
 */
export const BUILT_IN_BINDINGS: readonly ModelProviderBinding[] = [
  ...IMAGE_MODELS.map(kieImageBinding),
  ...VIDEO_MODELS.map(kieVideoBinding),
  ...(gptImage2AzureBinding ? [gptImage2AzureBinding] : []),
  ...(gptImage2CodexBinding ? [gptImage2CodexBinding] : []),
  ...openRouterImageBindings,
  ...openRouterVideoBindings,
  ...pollinationsImageBindings,
];

const DEFAULT_BINDINGS = new Map<string, ModelProviderBinding>(
  BUILT_IN_BINDINGS.filter((b) => b.providerId === "kie").map((b) => [b.modelId, b]),
);

/**
 * C1 default-binding rule: with no `model_bindings` row marking an active
 * provider, the active provider is `"kie"` with the static binding above
 * (preserves `lib/providers.ts`'s `?? "kie"` default).
 *
 * Throws for ids outside the catalog — registering custom LOGICAL models is
 * explicitly out of scope (design §1.2/C6); unknown id ⇒ programming error.
 */
export function getDefaultBinding(modelId: string): ModelProviderBinding {
  const binding = DEFAULT_BINDINGS.get(modelId);
  if (!binding) {
    throw new Error(
      `bindings: no built-in default binding for model "${modelId}" ` +
        `(custom logical models are out of scope — design §1.2/C6)`,
    );
  }
  return binding;
}

/**
 * Providers selectable for `modelId` from STATIC data: `{"kie"} ∪ {providers
 * of built-in bindings}` — never empty (C1.2), so a selector renders at ≥2 for
 * `gpt-image-2` exactly as before. With the OpenRouter + Pollinations image
 * bindings this yields `kie + openrouter` / `kie + pollinations` (plus
 * `azure`/`codex` for `gpt-image-2`). Stored `model_bindings` rows are unioned
 * in server-side by `GET /api/settings/providers` (`bindingsByModel`); this
 * module cannot see them (hedge (d) — pure, no DB).
 */
export function getAvailableProvidersForModel(modelId: string): ProviderId[] {
  const out: ProviderId[] = ["kie"];
  for (const b of BUILT_IN_BINDINGS) {
    if (b.modelId === modelId && b.providerId !== "kie") out.push(b.providerId);
  }
  return out;
}

/**
 * A representative OpenRouter binding — all 10 OR image bindings share the
 * same backend (base URL + key env + dialect), so any of them describes the
 * PROVIDER-level readiness. Used by `GET /api/settings/providers` to ask the
 * registered adapter's own `checkReadiness()` (compat-plan §b).
 */
export function getOpenRouterBinding(): ModelProviderBinding | undefined {
  return BUILT_IN_BINDINGS.find((b) => b.providerId === "openrouter");
}

/**
 * A representative Pollinations binding — all 11 Pollinations image bindings
 * share the same backend (base URL + key env + media store + dialect), so any
 * of them describes the PROVIDER-level readiness (compat-plan §b).
 */
export function getPollinationsBinding(): ModelProviderBinding | undefined {
  return BUILT_IN_BINDINGS.find((b) => b.providerId === "pollinations");
}

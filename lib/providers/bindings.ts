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
 *  - "seed"         — the seed
 *  - "references"   — the staged reference images
 *  - "outputFormat" — the catalog's declared output format
 */
export type CompatFieldSource =
  | "prompt"
  | "aspectRatio"
  | "tier"
  | "quality"
  | "resolution"
  | "size"
  | "seed"
  | "references"
  | "outputFormat";

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
 */
export type CompatParamMap = {
  fields?: Record<string, CompatFieldSource>;
  valueMaps?: Record<string, Record<string, string>>;
  constants?: Record<string, string>;
  modelKey?: string;
  maxReferences?: number;
};

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
      valueMaps: { resolution: { "1k": "1K", "2k": "2K" } },
      maxReferences: 14,
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
      valueMaps: { resolution: { "1k": "1K", "2k": "2K" } },
      maxReferences: 3,
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
      valueMaps: { resolution: { "1k": "1K", "2k": "2K" } },
      maxReferences: 3,
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
    },
  },
];

/**
 * C1 static binding set: 11 image models + 17 video models, each with a Kie
 * binding (`upstreamModelId = apiId`), plus Azure and Codex for `gpt-image-2`
 * and OpenRouter for the 10 SHIP image models → 40 code-defined bindings.
 * Immutable by convention — merge copies for overrides (the registry never
 * mutates these).
 */
export const BUILT_IN_BINDINGS: readonly ModelProviderBinding[] = [
  ...IMAGE_MODELS.map(kieImageBinding),
  ...VIDEO_MODELS.map(kieVideoBinding),
  ...(gptImage2AzureBinding ? [gptImage2AzureBinding] : []),
  ...(gptImage2CodexBinding ? [gptImage2CodexBinding] : []),
  ...openRouterImageBindings,
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
 * `gpt-image-2` exactly as before. With the OpenRouter image bindings this
 * yields `kie + openrouter` for the 10 SHIP image models (plus `azure`/`codex`
 * for `gpt-image-2`). Stored `model_bindings` rows are unioned in server-side
 * by `GET /api/settings/providers` (`bindingsByModel`); this module cannot see
 * them (hedge (d) — pure, no DB).
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

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
  /** Per-binding staging override (finding 1i) — provider level is only the default. */
  mediaStaging?: MediaStagingStrategy;
  /** Per-operation staging override (finding 1i) — e.g. Azure generations vs edits. */
  mediaStagingByOperation?: Partial<Record<MediaStagingOperation, MediaStagingStrategy>>;
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

/**
 * C1 static binding set: 11 image models + 17 video models, each with a Kie
 * binding (`upstreamModelId = apiId`), plus Azure and Codex for `gpt-image-2`
 * → 30 code-defined bindings. Immutable by convention — merge copies for
 * overrides (the registry never mutates these).
 */
export const BUILT_IN_BINDINGS: readonly ModelProviderBinding[] = [
  ...IMAGE_MODELS.map(kieImageBinding),
  ...VIDEO_MODELS.map(kieVideoBinding),
  ...(gptImage2AzureBinding ? [gptImage2AzureBinding] : []),
  ...(gptImage2CodexBinding ? [gptImage2CodexBinding] : []),
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
 * `gpt-image-2` exactly as before. Stored `model_bindings` rows are unioned in
 * server-side by `GET /api/settings/providers` (`bindingsByModel`); this module
 * cannot see them (hedge (d) — pure, no DB).
 */
export function getAvailableProvidersForModel(modelId: string): ProviderId[] {
  const out: ProviderId[] = ["kie"];
  for (const b of BUILT_IN_BINDINGS) {
    if (b.modelId === modelId && b.providerId !== "kie") out.push(b.providerId);
  }
  return out;
}

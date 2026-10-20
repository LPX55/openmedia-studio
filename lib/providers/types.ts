/**
 * Provider contract — design.md §1.3 (Phase 4 foundation, P4a).
 *
 * Pure type + tiny-helper module: NO `guest/db`, route, or node-builtin imports.
 * `lib/providers/bindings.ts` type-imports from here and must stay client-safe
 * (o2-gate hedge (d)): bindings are shared code, and the client learns its
 * available providers from `GET /api/settings/providers`, never from DB access.
 * Server-only behaviour lives in `mediaStager.ts` / `registry.ts` instead.
 *
 * `ProviderMeta` is reused from `lib/jobStore.ts` (C3 pinned shape — single
 * source; `import type` only so no runtime edge is created).
 */
import type { ProviderMeta } from "../jobStore";
import type { ImageModel, VideoModel } from "../modelConfig";
import type { ModelProviderBinding } from "./bindings";

/**
 * Open provider id union (design §1.3): the built-ins plus future adapters
 * (Phase 6: replicate / fal / openai-compat). `lib/providers.ts` keeps its own
 * narrower client-side trio (`"kie" | "azure" | "codex"`), which is assignable
 * to this type.
 */
export type ProviderId = "kie" | "azure" | "codex" | "replicate" | "fal" | "openai-compat" | (string & {});

export type MediaKind = "image" | "video" | "audio";

/**
 * How one provider+operation wants input media handed to it (design §1.3):
 *  - "data-url"         → `data:<mime>;base64,…` URI (Replicate, fal, OpenAI/Azure JSON)
 *  - "multipart-buffer" → `{ buffer, filename, mime }` for multipart/form-data (Azure/OpenAI edits)
 *  - "local-file"       → absolute MEDIA_DIR path on disk (Codex CLI)
 *  - "remote-url"       → must be an HTTP(S) URL; local inputs go through `uploadMedia()` (Kie.ai)
 */
export type MediaStagingStrategy = "data-url" | "multipart-buffer" | "local-file" | "remote-url";

/** Generation operations with distinct staging needs (O2 finding 1i). */
export type MediaStagingOperation = "image-generate" | "image-edit" | "video-generate";

/**
 * Per-binding/per-operation resolution order (O2 finding 1i — granularity must
 * be per-binding, provider level is only the default):
 *
 *   binding.mediaStagingByOperation[operation] → binding.mediaStaging → provider.mediaStaging
 *
 * Required because one provider needs different strategies per operation:
 * Azure accepts JSON-b64 for `images/generations` but multipart for
 * `/images/edits`, while Replicate/fal need `data-url` and Kie needs
 * `remote-url` + `uploadMedia()`.
 */
export function resolveMediaStagingStrategy(
  operation: MediaStagingOperation,
  binding: Pick<ModelProviderBinding, "mediaStaging" | "mediaStagingByOperation"> | undefined,
  providerStaging: MediaStagingStrategy,
): MediaStagingStrategy {
  return binding?.mediaStagingByOperation?.[operation] ?? binding?.mediaStaging ?? providerStaging;
}

/** An input media item after staging (design §1.3). */
export interface StagedMedia {
  /** Exactly what the caller handed us — never rewritten. */
  originalUrl: string;
  kind: MediaKind;
  /** The strategy that was resolved for this item (even when it just passed through). */
  strategy: MediaStagingStrategy;
  /** Populated for "remote-url" / "data-url" and for already-remote `http(s)://` passthrough. */
  url?: string;
  /** Populated for "local-file" — absolute path under MEDIA_DIR. */
  filePath?: string;
  /** Populated for "multipart-buffer". */
  buffer?: Buffer;
  mimeType?: string;
  filename?: string;
}

/** Where a provider's resolved key/baseUrl/endpoints came from (never the raw env list). */
export type ProviderKeySource = "db" | "env" | "cli" | "none";

/**
 * Resolved credentials handed to `submit`/`poll`/`uploadMedia`/`checkReadiness`.
 *
 * Structural mirror of `lib/guest/db.ts`'s Phase-3 `ProviderRuntimeConfig`
 * (declared here instead of imported so this module's import graph — and thus
 * `bindings.ts`'s — stays free of `guest/db`, hedge (d)). The two definitions
 * are structurally identical, so values from `guestDb.getProviderRuntimeConfig()`
 * are assignable without a cast.
 */
export interface ProviderRuntimeConfig {
  providerId: string;
  apiKey: string | null;
  baseUrl: string | null;
  /** Parsed `provider_configs.extra_json`, e.g. `{ deployments: { "gpt-image-2": "…" } }`. */
  extra: Record<string, unknown>;
  keySource: ProviderKeySource;
}

/** Input to `GenerationProvider.submit()` — already staged (see mediaStager.ts). */
export interface GenerateInput {
  /** Pre-minted by `jobManager.submitJob()` before any upstream call (design §2.1). */
  taskId: string;
  kind: "image" | "video";
  model: ImageModel | VideoModel;
  binding: ModelProviderBinding;
  prompt: string;
  params: {
    aspectRatio?: string;
    quality?: string;
    resolution?: string;
    customWidth?: number;
    customHeight?: number;
    duration?: number;
    mode?: string;
    sound?: boolean;
    seed?: number;
    negativePrompt?: string;
  };
  media: {
    references?: StagedMedia[];
    startFrame?: StagedMedia;
    endFrame?: StagedMedia;
    videoRef?: StagedMedia;
    referenceVideos?: StagedMedia[];
    audioRefs?: StagedMedia[];
    resources?: Array<{ media: StagedMedia; tag?: string }>;
  };
  /**
   * Family-specific structured inputs carried opaquely (P4b): e.g. Kie
   * `klingElements` ({ name, description, imageUrls[] }), Veo `veoMode` /
   * `generationType`, and `callBackUrl`. The adapter interprets them — they
   * don't fit the normalized media slots above.
   */
  extras?: Record<string, unknown>;
  /** Resolved key + baseUrl + endpoints from guest.db / env (design §3.2). */
  credentials: ProviderRuntimeConfig;
}

/** `submit()` may finish inline (sync providers) or hand back an upstream task (async queue providers). */
export type SubmitOutcome =
  | { mode: "async"; upstreamTaskId: string; providerMeta?: ProviderMeta }
  | { mode: "sync"; mediaUrls: string[]; rawBuffers?: Array<{ buffer: Buffer; mimeType: string }> };

/**
 * Result of one `poll()` tick. `done` carries `mediaUrls` AND optional
 * `buffers` (approved recommendation: sync-style providers whose results arrive
 * as bytes — e.g. base64 payloads — still flow through the poll loop without a
 * detour through URL-only persistence).
 */
export type PollOutcome =
  | { state: "pending"; progress?: number }
  | { state: "done"; mediaUrls: string[]; buffers?: Array<{ buffer: Buffer; mimeType: string }> }
  | { state: "error"; error: string };

/**
 * Provider-side EXECUTION capabilities (O2 C5 — capability/execution split):
 * what an adapter can do. Deliberately separate from logical-model UI
 * capabilities (`apiInput` in full, `textOnlyPromptMaxLength`, `useMotionControl`,
 * …), which stay on the catalog in `lib/modelConfig.ts` because clients read
 * them directly at every enumerated call site (C5).
 */
export interface GenerationCapabilities {
  /** `submit()` may resolve with `{ mode: "sync" }` (no upstream task to poll). */
  syncSubmission: boolean;
  /** `poll()` is implemented for async upstream tasks. */
  polling: boolean;
  /** `uploadMedia()` is implemented — required to stage local media under "remote-url". */
  mediaUpload: boolean;
  /** Provider-level default staging (always overridable per binding / per operation). */
  mediaStaging: MediaStagingStrategy;
}

/**
 * Per-provider UI tweaks for a logical model (design §1.1 / C5). The host is
 * an optional `providerOverrides?: Record<ProviderId, ModelUiOverride>` field on
 * the catalog entry — the replacement for today's `azureQualityOptions` /
 * `azureResolutionOptions` living on `ImageModel`. `modelConfig.ts` itself is
 * NOT changed in P4a (P4b/P5 wire the field + call sites).
 *
 * Execution-side shaping (size maps, api versions) belongs in
 * `ModelProviderBinding.paramMap`, not here.
 */
export interface ModelUiOverride {
  /** Replaces `azureQualityOptions` — quality picker options under this provider. */
  qualityOptions?: string[];
  /** Replaces `azureResolutionOptions` — resolution tiers shown alongside quality. */
  resolutionOptions?: string[];
  /** Provider-specific aspect-ratio subset (defaults to the model's `ratios`). */
  ratios?: string[];
}

/** `providerOverrides` map shape: provider id → UI override. */
export type ProviderOverrides = Record<ProviderId, ModelUiOverride>;

/**
 * A registered generation adapter (design §1.3). Adapters register through
 * `registry.register()` in P4b — P4a defines the contract only.
 */
export interface GenerationProvider {
  readonly id: ProviderId;
  readonly label: string;
  /**
   * Provider-level DEFAULT media staging — always overridable per binding and
   * per operation via `resolveMediaStagingStrategy()` (finding 1i).
   */
  readonly mediaStaging: MediaStagingStrategy;
  /** Optional execution-capability descriptor (C5) for readiness derivation. */
  readonly capabilities?: GenerationCapabilities;

  /** Required when the effective staging strategy is "remote-url" (e.g. kieUpload.ts). */
  uploadMedia?(localPathOrDataUrl: string, mimeType: string, cfg: ProviderRuntimeConfig): Promise<string>;

  /**
   * Validates whether required credentials + endpoint config are present.
   * All three branches are contract (O2 finding 1ii–iii):
   *
   *  - **azure** (finding 1ii): NOT ready unless `cfg.baseUrl` AND
   *    `cfg.extra.deployments[binding.modelId]` exist — mirrors today's
   *    `if (azureBaseUrl && azureDeployment)` gate (`app/api/generate/route.ts:327`),
   *    so the new check is at least as strict as the old kill-switch. Without a
   *    binding there is no deployment key ⇒ not ready.
   *  - **codex** (finding 1iii): `keySource: "cli"` branch — ready iff the
   *    shared `codex login` session exists (`~/.codex/auth.json`, `CODEX_HOME`,
   *    as in `app/api/settings/codex-status/route.ts`); there is no api_key in
   *    `provider_configs`, so the key-chain rule must not apply.
   *  - **kie / replicate / fal / openai-compat**: ready iff the api_key
   *    resolution chain (db → env fallback, design §3.2) produced a key
   *    (`keySource !== "none"`).
   */
  checkReadiness(cfg: ProviderRuntimeConfig, binding?: ModelProviderBinding): { ready: boolean; reason?: string };

  /** Submits generation; may complete synchronously or return an async upstream taskId. */
  submit(input: GenerateInput): Promise<SubmitOutcome>;

  /**
   * Polls upstream status for async jobs (called by the jobManager poll loop).
   * `meta` is the C3-pinned `ProviderMeta` JSON — the ONLY channel for
   * family/statusUrl/responseUrl/upstreamModelId, since `poll()` has no binding
   * parameter (design §2.1/C3, §2.3/C4).
   */
  poll?(
    upstreamTaskId: string,
    kind: "image" | "video",
    cfg: ProviderRuntimeConfig,
    meta?: ProviderMeta,
  ): Promise<PollOutcome>;
}

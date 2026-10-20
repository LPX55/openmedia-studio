/**
 * OpenAI-compatible image adapter — compat-plan §(b) (Deepwork P6, step 1).
 *
 * ONE adapter serves the whole `openai-compat` family. Every OpenAI-speaking
 * backend (OpenAI direct, OpenRouter, Pollinations' sync leg, LiteLLM /
 * new-api gateways, …) rides it as a BINDING — never as a code branch:
 *
 *   binding.baseUrl       backend base URL          (e.g. an OpenRouter-style
 *                                                      "…/api/v1" base)
 *   binding.pathOverride  endpoint path              ("/images")
 *   binding.keyEnv        env var with the API key   (the stored DB key wins)
 *   binding.paramMap      the DIALECT: which body key each normalized param
 *                         feeds, plus value maps (catalog tier → upstream value)
 *
 * The family is SYNC-ONLY: one POST returns the finished image(s) — there is
 * no upstream task id, hence NO `poll()` (compat-plan §b). Async compat
 * backends stay out of scope until the harness question reopens.
 *
 * Reference media rides the SAME endpoint as plain generations
 * (`input_references`), so there is no `/images/edits` branch and no
 * Kie-style text-only split: one upstream id serves t2i AND i2i (refs 0
 * allowed). `binding.textOnlyUpstreamId` is still honoured when a binding
 * defines one — the family just doesn't need it.
 *
 * SERVER-ONLY (reads `process.env` for the per-backend key) — never import
 * this module from client code.
 */
import type { CompatFieldSource, CompatParamMap, ModelProviderBinding } from "../bindings";
import type {
  GenerateInput,
  GenerationProvider,
  ProviderRuntimeConfig,
  SubmitOutcome,
} from "../types";

/** Default endpoint path of the OpenAI images API (overridable per binding). */
const DEFAULT_PATH = "/v1/images/generations";

/** Default body key carrying the upstream model id. */
const DEFAULT_MODEL_KEY = "model";

/** Body key for the prompt — the one field every dialect shares. */
const PROMPT_KEY = "prompt";

/** Longest upstream request we wait for (image generation can be slow). */
const REQUEST_TIMEOUT_MS = 10 * 60_000;

// ── Credential / endpoint resolution ─────────────────────────────────────────

/** Strip trailing slashes so `base + path` never doubles up. */
function trimBase(base: string): string {
  return base.replace(/\/+$/, "");
}

/**
 * The backend's base URL: the binding's pinned base URL wins (a code-seeded
 * backend such as OpenRouter carries its own), otherwise the provider config
 * (`provider_configs.base_url` — the user-pointed backend story, compat-plan
 * §d). No backend URL is hardcoded in this module.
 */
function resolveBaseUrl(
  cfg: ProviderRuntimeConfig,
  binding: ModelProviderBinding | undefined,
): string | null {
  const raw = binding?.baseUrl ?? cfg.baseUrl ?? null;
  if (!raw || !raw.trim()) return null;
  return trimBase(raw.trim());
}

/**
 * The backend's API key: the stored DB key (resolved for THIS provider id by
 * `lib/guest/db.ts`) wins; otherwise the binding's `keyEnv` env var (e.g.
 * `OPENROUTER_API_KEY`) — the family deliberately does NOT share one key
 * across backends.
 */
function resolveApiKey(
  cfg: ProviderRuntimeConfig,
  binding: ModelProviderBinding | undefined,
): string | null {
  if (cfg.apiKey && cfg.apiKey.trim()) return cfg.apiKey.trim();
  const envName = binding?.keyEnv;
  if (envName) {
    const fromEnv = process.env[envName];
    if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  }
  return null;
}

/** Endpoint path: the binding's override, else the OpenAI default. */
function resolvePath(binding: ModelProviderBinding | undefined): string {
  const raw = (binding?.pathOverride ?? DEFAULT_PATH).trim();
  if (!raw) return DEFAULT_PATH;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

// ── Request body ─────────────────────────────────────────────────────────────

/** Staged reference images, as the upstream sees them (data-url or remote). */
function referenceUrls(input: GenerateInput): string[] {
  const refs = input.media.references ?? [];
  return refs.map((r) => r.url ?? r.originalUrl).filter((u) => !!u);
}

/**
 * Value of one normalized source. `undefined` ⇒ the field is NOT sent (the
 * dialect decides what the backend accepts — compat-plan §a: "per-model params
 * on needs basis only").
 */
function resolveFieldValue(
  source: CompatFieldSource,
  input: GenerateInput,
): string | number | string[] | undefined {
  const p = input.params;
  switch (source) {
    case "prompt":
      return input.prompt;
    case "aspectRatio":
      return p.aspectRatio;
    case "tier":
      // The catalog's picker value ("1k" | "2k" | "4k" | "low" | …). The
      // route's `resolution` is the Azure-style tier — used as a fallback so
      // a client that sends the tier there still lands on the same field.
      return p.quality ?? p.resolution;
    case "quality":
      return p.quality;
    case "resolution":
      return p.resolution;
    case "size":
      return p.customWidth && p.customHeight
        ? `${p.customWidth}x${p.customHeight}`
        : undefined;
    case "seed":
      return typeof p.seed === "number" ? p.seed : undefined;
    case "references":
      return referenceUrls(input);
    case "outputFormat": {
      const apiInput = (input.model as { apiInput?: { outputFormat?: string } }).apiInput;
      return apiInput?.outputFormat;
    }
    default:
      return undefined;
  }
}

/** Apply a dialect value map (normalized value → upstream value). */
function applyValueMap(
  valueMap: Record<string, string> | undefined,
  value: string | number | string[],
): string | number | string[] {
  if (!valueMap || typeof value !== "string") return value;
  return valueMap[value] ?? value;
}

/** The upstream output format the request asked for (for the buffer MIME). */
function outputFormatOf(
  body: Record<string, unknown>,
  spec: CompatParamMap,
): string | undefined {
  for (const [key, source] of Object.entries(spec.fields ?? {})) {
    if (source !== "outputFormat") continue;
    const v = body[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/** MIME for a returned base64 image. */
function mimeFor(outputFormat: string | undefined): string {
  const f = (outputFormat ?? "").toLowerCase();
  if (f === "jpg" || f === "jpeg") return "image/jpeg";
  if (f === "webp") return "image/webp";
  if (f === "gif") return "image/gif";
  return "image/png";
}

/**
 * Log-safe view of the request body: staged references are data URLs (base64
 * blobs), so only their count is logged.
 */
function loggableBody(
  body: Record<string, unknown>,
  spec: CompatParamMap,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  for (const [key, source] of Object.entries(spec.fields ?? {})) {
    if (source !== "references") continue;
    const v = out[key];
    if (Array.isArray(v)) out[key] = `[${v.length} staged reference(s)]`;
  }
  return out;
}

/**
 * Build the upstream request body from the normalized params + the binding's
 * dialect. Fields the dialect does not declare are NOT sent; the model id
 * always is.
 */
function buildBody(
  input: GenerateInput,
  upstreamModelId: string,
  spec: CompatParamMap,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  body[spec.modelKey ?? DEFAULT_MODEL_KEY] = upstreamModelId;

  for (const [key, source] of Object.entries(spec.fields ?? {})) {
    let value = resolveFieldValue(source, input);
    if (value === undefined || value === null) continue;
    value = applyValueMap(spec.valueMaps?.[key], value);
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      // Upstream reference cap (spike: OR caps differ per model).
      if (source === "references" && spec.maxReferences !== undefined) {
        value = value.slice(0, spec.maxReferences);
      }
    }
    body[key] = value;
  }

  for (const [key, value] of Object.entries(spec.constants ?? {})) body[key] = value;

  // The prompt is fundamental — send it even if the dialect forgot to map it.
  if (body[PROMPT_KEY] === undefined) body[PROMPT_KEY] = input.prompt;

  return body;
}

// ── Response ─────────────────────────────────────────────────────────────────

interface CompatImageItem {
  b64_json?: string;
  url?: string;
  mime_type?: string;
}

/**
 * Normalize the upstream response: `data[].b64_json` → raw buffers,
 * `data[].url` → mirrored urls (compat-plan §b). An item carrying both keeps
 * the buffer (bytes are already in hand; the url would duplicate it).
 */
function parseResponse(
  json: unknown,
  defaultMime: string,
): { mediaUrls: string[]; rawBuffers: Array<{ buffer: Buffer; mimeType: string }> } {
  const data = Array.isArray((json as { data?: unknown } | null)?.data)
    ? ((json as { data: CompatImageItem[] }).data ?? [])
    : [];

  const mediaUrls: string[] = [];
  const rawBuffers: Array<{ buffer: Buffer; mimeType: string }> = [];

  for (const item of data) {
    if (!item) continue;
    if (item.b64_json) {
      rawBuffers.push({
        buffer: Buffer.from(item.b64_json, "base64"),
        mimeType: item.mime_type ?? defaultMime,
      });
    } else if (item.url) {
      mediaUrls.push(item.url);
    }
  }

  return { mediaUrls, rawBuffers };
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export const openaiCompatProvider: GenerationProvider = {
  id: "openai-compat",
  label: "OpenAI-Compatible",
  /**
   * Backend ids this family adapter serves (compat-plan §b). Each backend
   * keeps its OWN provider id — so it can carry its own key row
   * (`provider_configs`), its own base URL and its own `model_bindings` rows
   * (PK `(model_id, provider_id)`). The registry registers an id-overridden
   * view per alias, so `provider.id` stays the BACKEND id.
   */
  aliases: ["openrouter"],
  mediaStaging: "data-url",
  // The only family whose dialect is described by a PARAM PRESET (compat-plan
  // §c) — the registry resolves the preset layer into the binding's paramMap.
  usesParamPresets: true,
  capabilities: {
    syncSubmission: true,
    polling: false,
    mediaUpload: false,
    mediaStaging: "data-url",
  },

  /**
   * Ready iff the backend has a key AND a base URL — there is no deployment
   * concept in this family (that is Azure's, finding 1ii).
   */
  checkReadiness(
    cfg: ProviderRuntimeConfig,
    binding?: ModelProviderBinding,
  ): { ready: boolean; reason?: string } {
    if (!resolveApiKey(cfg, binding)) {
      return {
        ready: false,
        reason: "No API key configured for this OpenAI-compatible backend. Add one in Settings.",
      };
    }
    if (!resolveBaseUrl(cfg, binding)) {
      return {
        ready: false,
        reason: "No base URL configured for this OpenAI-compatible backend. Add one in Settings.",
      };
    }
    return { ready: true };
  },

  async submit(input: GenerateInput): Promise<SubmitOutcome> {
    const cfg = input.credentials;
    const binding = input.binding;

    // An unknown param preset must fail LOUDLY (compat-plan §c) — never a
    // silent fallback to the binding's own params. The throw happens inside
    // the managed submit, so the job settles with this message.
    if (binding.presetError) {
      throw new Error(binding.presetError);
    }

    const apiKey = resolveApiKey(cfg, binding);
    if (!apiKey) {
      throw new Error("No API key configured for this OpenAI-compatible backend. Add one in Settings.");
    }
    const baseUrl = resolveBaseUrl(cfg, binding);
    if (!baseUrl) {
      throw new Error("No base URL configured for this OpenAI-compatible backend. Add one in Settings.");
    }

    const url = `${baseUrl}${resolvePath(binding)}`;
    const spec = (binding.paramMap ?? {}) as CompatParamMap;

    // No input media ⇒ the binding's text-only variant (when it declares one).
    // The OpenRouter dialect does NOT need it: one id serves t2i and i2i.
    const hasRefs = (input.media.references ?? []).length > 0;
    const upstreamModelId =
      !hasRefs && binding.textOnlyUpstreamId
        ? binding.textOnlyUpstreamId
        : binding.upstreamModelId;

    const body = buildBody(input, upstreamModelId, spec);

    console.log("[openai-compat] request →", {
      url,
      model: upstreamModelId,
      body: loggableBody(body, spec),
    });

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error("Invalid API key for this OpenAI-compatible backend — please update it in Settings.");
      }
      throw new Error(`Upstream error ${res.status}: ${text.slice(0, 500)}`);
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Upstream returned non-JSON: ${text.slice(0, 200)}`);
    }

    const { mediaUrls, rawBuffers } = parseResponse(json, mimeFor(outputFormatOf(body, spec)));
    if (mediaUrls.length === 0 && rawBuffers.length === 0) {
      throw new Error("Upstream returned no image data");
    }

    return { mode: "sync", mediaUrls, rawBuffers };
  },
};

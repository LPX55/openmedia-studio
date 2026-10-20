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
 *   binding.mediaUpload   the media-upload endpoint   (only for the
 *                         "remote-url" staging strategy — e.g. Pollinations'
 *                         media store)
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
 * SERVER-ONLY (reads `process.env` for the per-backend key, touches the local
 * media dir) — never import this module from client code.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MEDIA_DIR } from "../../guest/paths";
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
    case "width":
      return typeof p.customWidth === "number" ? p.customWidth : undefined;
    case "height":
      return typeof p.customHeight === "number" ? p.customHeight : undefined;
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
    // The staged references are urls (or data-url blobs) — only their count
    // is logged, whatever shape the dialect asked for.
    const count = Array.isArray(v) ? v.length : v === undefined ? 0 : 1;
    out[key] = `[${count} staged reference(s)]`;
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
        // A cap of 0 (a text-only upstream model) means "no references" — the
        // field is dropped entirely, never sent as an empty array.
        if (value.length === 0) continue;
      }
      // A backend whose reference field takes ONE url (the native Pollinations
      // `image=` shape) asks for it explicitly.
      if (source === "references" && spec.referenceMode === "first") {
        value = value[0];
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

// ── Media upload (the "remote-url" staging strategy) ─────────────────────────

/** MIME by file extension — the upload's Content-Type for a local file. */
const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

/**
 * Read the bytes of a raw input media string — the three shapes the stager
 * hands to `uploadMedia()`: a `data:` URI, a local `/generated/…` path, or a
 * private-host http(s) URL (the stager routes only NON-remote inputs here —
 * a public http(s) url passes through untouched, the pinned rule).
 */
async function readLocalBytes(
  raw: string,
  mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
  if (raw.startsWith("data:")) {
    const m = /^data:([^;,]+)?((?:;[^;,]+)*),([\s\S]*)$/.exec(raw);
    if (!m) throw new Error("openai-compat upload: malformed data: URI");
    const mime = m[1] || mimeType || "application/octet-stream";
    const payload = m[3] ?? "";
    const buffer = /;base64/i.test(m[2] ?? "")
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    return { buffer, mimeType: mime, filename: `file.${extForMime(mime)}` };
  }

  if (/^https?:\/\//i.test(raw)) {
    const res = await fetch(raw);
    if (!res.ok) {
      throw new Error(`openai-compat upload: source fetch failed (${res.status}): ${raw}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || mimeType;
    return { buffer, mimeType: mime, filename: `file.${extForMime(mime)}` };
  }

  const rel = raw.replace(/^\/generated\//, "").replace(/^\/+/, "");
  const buffer = await readFile(join(MEDIA_DIR, rel));
  const ext = rel.split(".").pop()?.toLowerCase() ?? "";
  const mime = mimeType || MIME_BY_EXT[ext] || "application/octet-stream";
  const name = rel.split("/").pop() || `file.${ext || "bin"}`;
  return { buffer, mimeType: mime, filename: name };
}

/** File extension for a MIME type — the multipart filename ("bin" fallback). */
function extForMime(mime: string): string {
  const sub = mime.split("/")[1]?.split(";")[0]?.toLowerCase() ?? "";
  if (sub === "jpeg") return "jpg";
  for (const [ext, known] of Object.entries(MIME_BY_EXT)) {
    if (known === mime) return ext;
  }
  return "bin";
}

/**
 * Pull the media URL out of an upload response — generic across the shapes
 * media stores answer with: a JSON object (`{"url": …}`, `{"data": {"url": …}}`,
 * `file_url`/`image_url`/`media_url`/`output_url`/`href`), a bare URL string,
 * or a redirect (`Location` header).
 */
function extractUploadUrl(text: string, location: string | null): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      json = {};
    }
    const nested = (json.data ?? json.result ?? json.file) as Record<string, unknown> | undefined;
    const candidates = [
      json.url,
      json.file_url,
      json.image_url,
      json.media_url,
      json.output_url,
      json.href,
      json.path,
      nested?.url,
      nested?.file_url,
      nested?.image_url,
      nested?.media_url,
      nested?.output_url,
      nested?.href,
      nested?.path,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c.trim();
    }
  }
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (location && /^https?:\/\//i.test(location)) return location;
  throw new Error(
    `openai-compat upload: the response carried no media URL (${trimmed.slice(0, 200)})`,
  );
}

/**
 * A plain ArrayBuffer-backed copy of the bytes.
 *
 * Node's `Buffer` is a POOLED view (`ArrayBufferLike`), which the fetch /
 * Blob typings reject — the copy hands them a plain `Uint8Array`.
 */
function toBodyBytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(buffer.byteLength);
  out.set(buffer);
  return out;
}

/**
 * POST the bytes to the binding's media-upload endpoint and return the URL the
 * backend handed back.
 *
 * The endpoint, the field name and the body encoding come from the BINDING
 * (compat-plan §a: a vendor difference is configuration, never a code
 * branch) — this function is the generic realisation of that configuration.
 */
async function uploadToMediaStore(
  spec: NonNullable<ModelProviderBinding["mediaUpload"]>,
  bytes: { buffer: Buffer; mimeType: string; filename: string },
  apiKey: string | null,
): Promise<string> {
  const field = spec.field ?? "file";
  const encoding = spec.encoding ?? "multipart";
  const headers: Record<string, string> = { ...(spec.headers ?? {}) };
  if (apiKey && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let body: BodyInit;
  if (encoding === "raw") {
    headers["Content-Type"] = headers["Content-Type"] ?? bytes.mimeType;
    body = toBodyBytes(bytes.buffer);
  } else if (encoding === "base64") {
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
    body = JSON.stringify({ [field]: bytes.buffer.toString("base64") });
  } else {
    const form = new FormData();
    form.append(field, new Blob([toBodyBytes(bytes.buffer)], { type: bytes.mimeType }), bytes.filename);
    for (const [k, v] of Object.entries(spec.fields ?? {})) form.append(k, v);
    body = form; // fetch sets the multipart boundary itself
  }

  const res = await fetch(spec.url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`openai-compat upload failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return extractUploadUrl(text, res.headers.get("location"));
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
   *
   * "openrouter" — the OpenRouter image dialect (data-url staging).
   * "pollinations" — Pollinations' OpenAI-compatible SYNC leg (remote-url
   * staging: local references are uploaded to its media store first).
   */
  aliases: ["openrouter", "pollinations"],
  mediaStaging: "data-url",
  // The only family whose dialect is described by a PARAM PRESET (compat-plan
  // §c) — the registry resolves the preset layer into the binding's paramMap.
  usesParamPresets: true,
  capabilities: {
    syncSubmission: true,
    polling: false,
    // The upload hook IS implemented (see `uploadMedia` below) — it is only
    // REACHED by a binding that stages media as "remote-url" (Pollinations);
    // the data-url backends never call it.
    mediaUpload: true,
    mediaStaging: "data-url",
  },

  /**
   * Upload a local media file to the BACKEND's media store and return its URL.
   *
   * Called by the stager ONLY when the resolved staging strategy is
   * "remote-url" AND the input is not already a public URL (a data-url
   * backend never reaches this path — the hook is opt-in per binding).
   *
   * The endpoint + field convention come from the BINDING (`mediaUpload`),
   * never from a vendor branch in code (compat-plan §a): Pollinations'
   * binding points at its media store (`media.pollinations.ai/upload`), any
   * other backend points at its own.
   */
  async uploadMedia(
    localPathOrDataUrl: string,
    mimeType: string,
    cfg: ProviderRuntimeConfig,
    binding?: ModelProviderBinding,
  ): Promise<string> {
    const spec = binding?.mediaUpload;
    if (!spec?.url) {
      throw new Error(
        `openai-compat: the "${binding?.providerId ?? "unknown"}" backend stages media as ` +
          `"remote-url" but its binding declares no media-upload endpoint (mediaUpload.url).`,
      );
    }
    const apiKey = resolveApiKey(cfg, binding);
    const bytes = await readLocalBytes(localPathOrDataUrl, mimeType);
    return uploadToMediaStore(spec, bytes, apiKey);
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

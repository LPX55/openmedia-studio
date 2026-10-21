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
 * The family serves TWO upstream shapes:
 *
 *  - IMAGES (sync): one POST returns the finished image(s) — no upstream task
 *    id, hence NO `poll()` for that leg (compat-plan §b).
 *  - VIDEO (async): `POST {base}/videos` returns `202 {id, polling_url}` — the
 *    task is polled at `polling_url` and the finished BYTES are fetched from
 *    the result endpoint (`…/content?index=0`, bearer-authenticated) and handed
 *    to the settle funnel as raw buffers (never base64).
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
import { envFallbackKeyName, getProviderRuntimeConfig } from "../../guest/db";
import { MEDIA_DIR } from "../../guest/paths";
import { appendJobLog, describeError, urlHost } from "../../jobLog";
import type { ProviderMeta } from "../../jobStore";
import type { CompatFieldSource, CompatParamMap, ModelProviderBinding } from "../bindings";
import type {
  GenerateInput,
  GenerationProvider,
  PollOutcome,
  ProviderRuntimeConfig,
  StagedMedia,
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

/**
 * Total budget of ONE submit (all attempts together). It matches the 12-min
 * job ceiling of the SSE/poll path, so a submit can never outlive the job
 * lifecycle it belongs to.
 */
const SUBMIT_BUDGET_MS = 12 * 60_000;

/** How many attempts one submit makes: the original + ONE retry. */
const MAX_ATTEMPTS = 2;

// ── Failure classification (network level vs. not) ───────────────────────────

/** The kind of a failed fetch. */
export type FetchFailureKind = "network" | "timeout" | "abort" | "unknown";

export interface FetchFailure {
  kind: FetchFailureKind;
  /**
   * True for TRANSPORT failures (DNS, timeout, connection reset) — those get
   * ONE retry. An HTTP 4xx/5xx is NOT a transport failure: the request
   * reached the server, so it is never retried.
   */
  retryable: boolean;
  /** The underlying errno code, when there is one. */
  code?: string;
}

/** errno / undici codes that mean "the request never made it to the server". */
const RETRYABLE_CODES = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ECONNABORTED",
  "ETIMEDOUT", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Classify a thrown fetch error. Only the transport failures are retryable —
 * everything else (a bug in our own code, an aborted request) is not.
 */
export function classifyFetchError(e: unknown): FetchFailure {
  const err = e as
    | { name?: string; message?: string; cause?: { code?: string; errors?: Array<{ code?: string }> } }
    | undefined;
  const name = err?.name ?? "";
  if (name === "TimeoutError") return { kind: "timeout", retryable: true, code: "ETIMEDOUT" };
  if (name === "AbortError") return { kind: "abort", retryable: false };
  const code = err?.cause?.code ?? err?.cause?.errors?.[0]?.code;
  if (code && RETRYABLE_CODES.has(code)) return { kind: "network", retryable: true, code };
  // "fetch failed" without a code is still a transport failure.
  if (/fetch failed/i.test(err?.message ?? "")) {
    return { kind: "network", retryable: true, code: code ?? "FETCH_FAILED" };
  }
  return { kind: "unknown", retryable: false, code };
}

/** The HTTP status CLASS — 2xx/3xx/4xx/5xx. Never the body. */
function statusClass(status: number): string {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500) return "5xx";
  return "unknown";
}

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

/**
 * The key that authenticates a MEDIA UPLOAD.
 *
 * Two cases:
 *  - The binding's `mediaUpload.keyProviderId` is set ⇒ the upload is a
 *    CROSS-PROVIDER one: the endpoint belongs to ANOTHER provider than the
 *    generation target (e.g. the OpenRouter video lane stages local frames
 *    through the Pollinations media store), so the key of THAT provider
 *    authenticates the upload — the generation backend's key would be
 *    rejected by the upload host. Resolved through
 *    `getProviderRuntimeConfig` (the stored DB key first, then that
 *    provider's env fallback).
 *  - Otherwise ⇒ the generation backend's own key (unchanged behavior).
 *
 * A cross-provider upload WITHOUT its key fails LOUDLY: an unauthenticated
 * upload is a silent no-op at worst and a confusing 401 at best.
 */
function resolveUploadKey(
  cfg: ProviderRuntimeConfig,
  binding: ModelProviderBinding | undefined,
  spec: NonNullable<ModelProviderBinding["mediaUpload"]>,
): string | null {
  const providerId = spec.keyProviderId;
  if (!providerId) return resolveApiKey(cfg, binding);

  const key = getProviderRuntimeConfig(providerId).apiKey;
  if (key && key.trim()) return key.trim();

  const envName = envFallbackKeyName(providerId);
  throw new Error(
    `openai-compat upload needs a "${providerId}" key (Settings, or ${envName ?? "its env var"}) — ` +
      `the media-upload endpoint ${spec.url} is authenticated with the "${providerId}" key, ` +
      `not with the generation backend's.`,
  );
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

/** Apply a dialect value map (normalized value → upstream value). A map entry
 * of null means DROP the field (used for catalog sentinels like "auto" that
 * an endpoint's enum rejects — the server default applies instead). */
function applyValueMap(
  valueMap: Record<string, string | null> | undefined,
  value: string | number | string[],
): string | number | string[] | undefined {
  if (!valueMap || typeof value !== "string") return value;
  if (!(value in valueMap)) return value;
  const mapped = valueMap[value];
  return mapped === null ? undefined : mapped;
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
 * Log-safe view of the request: the SHAPE only.
 *
 * The body is never logged — the prompt is user content and the staged
 * references are base64 blobs. Only the field names, the upstream model and
 * the reference COUNT are safe to print.
 */
function bodyShape(
  body: Record<string, unknown>,
  spec: CompatParamMap,
): { fields: string[]; stagedReferences: number } {
  let stagedReferences = 0;
  for (const [key, source] of Object.entries(spec.fields ?? {})) {
    if (source !== "references") continue;
    const v = body[key];
    stagedReferences += Array.isArray(v) ? v.length : v === undefined ? 0 : 1;
  }
  return { fields: Object.keys(body).sort(), stagedReferences };
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
      // OpenRouter `/v1/images` dialect: reference items are objects, not
      // bare URL strings (verified live — Zod rejects strings with
      // "expected object, received string").
      if (source === "references" && spec.referenceMode === "objects") {
        body[key] = Array.isArray(value)
          ? value.map((u) => ({ type: "image_url", image_url: { url: u } }))
          : value;
        continue;
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

// ── Bounded fetch (one retry on transport failures) ───────────────────────────

/**
 * POST the body, retrying ONCE when the failure is a TRANSPORT failure
 * (DNS, timeout, connection reset). An HTTP 4xx/5xx is NOT retried — the
 * request reached the server, and replaying it would only cost money.
 *
 * The whole submit shares ONE budget (`SUBMIT_BUDGET_MS`, the 12-min job
 * ceiling): the per-attempt timeout is capped by what is left of it, so a
 * retry can never outlive the job lifecycle.
 */
async function fetchWithRetry(
  taskId: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const deadline = Date.now() + SUBMIT_BUDGET_MS;
  const host = urlHost(url) ?? "unknown";
  let attempt = 0;

  for (;;) {
    attempt += 1;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("openai-compat: the 12-minute request budget is exhausted");
    }
    const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, remaining);
    appendJobLog(
      taskId,
      "submit",
      `attempt ${attempt}/${MAX_ATTEMPTS} · host ${host} · timeout ${Math.round(timeoutMs / 1000)}s`,
    );

    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      appendJobLog(
        taskId,
        "submit",
        `attempt ${attempt} answered · HTTP ${res.status} (${statusClass(res.status)})`,
      );
      return res;
    } catch (e) {
      const failure = classifyFetchError(e);
      appendJobLog(
        taskId,
        "retry",
        `attempt ${attempt} failed · ${failure.kind}${failure.code ? ` (${failure.code})` : ""} · ${describeError(e)}`,
      );
      if (!failure.retryable) throw e;
      if (attempt >= MAX_ATTEMPTS) {
        appendJobLog(taskId, "retry", "no retry left — the submit fails with this error");
        throw e;
      }
      appendJobLog(taskId, "retry", `retrying once after a ${failure.kind} failure`);
    }
  }
}

// ── Video: the OpenRouter video dialect (contract verified 2026-10-21) ───────

/**
 * One frame image of a video request:
 *   `{type:"image_url", image_url:{url}, frame_type:"first_frame"|"last_frame"}`
 */
interface CompatFrameImage {
  type: "image_url";
  image_url: { url: string };
  frame_type: "first_frame" | "last_frame";
}

/**
 * One input reference of a video request:
 *   `{type:"image_url"|"video_url"|"audio_url", "<x>_url":{url}}`
 */
interface CompatInputReference {
  type: "image_url" | "video_url" | "audio_url";
  image_url?: { url: string };
  video_url?: { url: string };
  audio_url?: { url: string };
}

/** The staged URL of one media item (the passthrough URL, or the original). */
function stagedUrlOf(media: StagedMedia | undefined): string | undefined {
  return media?.url ?? media?.originalUrl;
}

/**
 * The clip length to send: the catalog's (already clamped) duration, else the
 * binding's own default, re-clamped to the model's upstream limits.
 *
 * A model without a duration picker (its clamped duration is 0) falls back to
 * the binding's `defaultDuration`; a model whose caps are unknown sends no
 * duration at all — an absent field is omitted, never 0.
 */
function resolveVideoDuration(
  input: GenerateInput,
  spec: CompatParamMap,
): number | undefined {
  const raw = input.params.duration;
  let seconds =
    typeof raw === "number" && raw > 0 ? Math.round(raw) : 0;
  if (seconds === 0) {
    seconds =
      typeof spec.defaultDuration === "number" && spec.defaultDuration > 0
        ? spec.defaultDuration
        : 0;
  }
  if (seconds === 0) return undefined;
  if (typeof spec.durationMin === "number" && seconds < spec.durationMin) {
    seconds = spec.durationMin;
  }
  if (typeof spec.durationMax === "number" && seconds > spec.durationMax) {
    seconds = spec.durationMax;
  }
  return seconds;
}

/**
 * The frame images of a video request — the staged start/end frames.
 *
 * `spec.maxFrames` caps them (1 = the first frame only — the models whose
 * caps list "first frame"), and `spec.referenceFrame` says that the staged
 * REFERENCES ride as a frame instead of as an `input_references` entry (the
 * models whose only image input is a first frame).
 */
function buildVideoFrames(
  input: GenerateInput,
  spec: CompatParamMap,
): CompatFrameImage[] {
  const frames: CompatFrameImage[] = [];
  const max = spec.maxFrames ?? 2;
  const media = input.media;

  if (max >= 1) {
    const start = stagedUrlOf(media.startFrame);
    if (start) {
      frames.push({ type: "image_url", image_url: { url: start }, frame_type: "first_frame" });
    } else if (spec.referenceFrame === "first_frame") {
      const reference = (media.references ?? []).map((r) => stagedUrlOf(r)).find(Boolean);
      if (reference) {
        frames.push({ type: "image_url", image_url: { url: reference }, frame_type: "first_frame" });
      }
    }
  }

  if (max >= 2) {
    const end = stagedUrlOf(media.endFrame);
    if (end) {
      frames.push({ type: "image_url", image_url: { url: end }, frame_type: "last_frame" });
    } else if (spec.referenceFrame === "last_frame") {
      const reference = (media.references ?? []).map((r) => stagedUrlOf(r)).find(Boolean);
      if (reference) {
        frames.push({ type: "image_url", image_url: { url: reference }, frame_type: "last_frame" });
      }
    }
  }

  return frames;
}

/**
 * The input references of a video request — the staged reference images, the
 * reference videos and the reference audios, shaped by their media kind.
 *
 * `spec.maxReferences` caps the list (0 ⇒ the field is not declared at all —
 * the models whose caps list frames only).
 */
function buildVideoInputReferences(
  input: GenerateInput,
  spec: CompatParamMap,
): CompatInputReference[] {
  const refs: CompatInputReference[] = [];
  const media = input.media;

  const push = (url: string | undefined, type: CompatInputReference["type"]) => {
    if (!url) return;
    refs.push({ type, [type]: { url } } as CompatInputReference);
  };

  // The references are already riding as a frame image — do not send them twice.
  if (!spec.referenceFrame) {
    for (const r of media.references ?? []) push(stagedUrlOf(r), "image_url");
    for (const r of media.resources ?? []) push(stagedUrlOf(r.media), "image_url");
  }
  push(stagedUrlOf(media.videoRef), "video_url");
  for (const v of media.referenceVideos ?? []) push(stagedUrlOf(v), "video_url");
  for (const a of media.audioRefs ?? []) push(stagedUrlOf(a), "audio_url");

  const cap = spec.maxReferences ?? 0;
  return cap > 0 ? refs.slice(0, cap) : [];
}

/**
 * Build the upstream VIDEO request body from the normalized params + the
 * binding's dialect — the same "paramMap-driven" rule as the images leg.
 *
 * A field the dialect does not declare is NOT sent, and a field without a
 * value is omitted (never null, never 0): the backend 400s on unexpected
 * shapes. The "auto" aspect ratio is dropped even when the dialect forgot to
 * map it — the router 400s on "auto" (verified live on the images lane).
 */
function buildVideoBody(
  input: GenerateInput,
  upstreamModelId: string,
  spec: CompatParamMap,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  body[spec.modelKey ?? DEFAULT_MODEL_KEY] = upstreamModelId;

  for (const [key, source] of Object.entries(spec.fields ?? {})) {
    switch (source) {
      case "prompt": {
        if (input.prompt?.trim()) body[key] = input.prompt;
        break;
      }
      case "duration": {
        const duration = resolveVideoDuration(input, spec);
        if (duration !== undefined) body[key] = duration;
        break;
      }
      case "resolution": {
        let value = applyValueMap(spec.valueMaps?.[key], input.params.resolution ?? "");
        if (typeof value === "string" && value.trim().toLowerCase() === "auto") {
          value = undefined; // "auto" is not in the upstream enum — drop it
        }
        if (value !== undefined && value !== "") body[key] = value;
        break;
      }
      case "aspectRatio": {
        let value = applyValueMap(spec.valueMaps?.[key], input.params.aspectRatio ?? "");
        if (typeof value === "string" && value.trim().toLowerCase() === "auto") {
          value = undefined; // "auto" is not in the upstream enum — drop it
        }
        if (value !== undefined && value !== "") body[key] = value;
        break;
      }
      case "seed": {
        if (typeof input.params.seed === "number") body[key] = input.params.seed;
        break;
      }
      case "sound": {
        body[key] = input.params.sound === true;
        break;
      }
      case "frames": {
        const frames = buildVideoFrames(input, spec);
        if (frames.length > 0) body[key] = frames;
        break;
      }
      case "inputReferences": {
        const refs = buildVideoInputReferences(input, spec);
        if (refs.length > 0) body[key] = refs;
        break;
      }
      default:
        // A source of the IMAGES dialect ("references", "tier", …) has no
        // meaning in a video body — it is simply not sent.
        break;
    }
  }

  // The constants ride last — they pin a field the catalog has no picker for
  // (e.g. the resolution of a model whose catalog entry only offers modes).
  for (const [key, value] of Object.entries(spec.constants ?? {})) body[key] = value;

  return body;
}

/**
 * The absolute status URL of a submitted video task.
 *
 * The backend answers with a RELATIVE `polling_url` ("/api/v1/videos/…") ⇒ it
 * is resolved against the ORIGIN of the backend's base URL (bearer auth, same
 * host as the submit).
 */
function resolvePollingUrl(
  pollingUrl: string | undefined,
  baseUrl: string,
  upstreamTaskId: string,
): string {
  if (pollingUrl && /^https?:\/\//i.test(pollingUrl)) return pollingUrl;
  const path = pollingUrl ?? `/api/v1/videos/${encodeURIComponent(upstreamTaskId)}`;
  try {
    return new URL(path, new URL(baseUrl).origin).toString();
  } catch {
    return path;
  }
}

/**
 * The result endpoint of a finished task: the status URL + "/content"
 * (`GET /api/v1/videos/{id}/content?index=0` → the raw video bytes).
 */
function contentUrlOf(statusUrl: string): string | null {
  try {
    const url = new URL(statusUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/content`;
    url.search = "index=0";
    return url.toString();
  } catch {
    return null;
  }
}

/** The string array of a JSON field (an empty array when it is absent). */
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

/**
 * The error message of an upstream error envelope: `{error:{code,message}}`
 * (the contract's shape) — with a plain `message` as the fallback.
 */
function errorMessageOf(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as { error?: unknown; message?: unknown };
  const err = record.error;
  if (typeof err === "string" && err.trim()) return err;
  if (err && typeof err === "object") {
    const detail = err as { message?: unknown; code?: unknown };
    if (typeof detail.message === "string" && detail.message.trim()) return detail.message;
    if (detail.code !== undefined) return `Upstream error ${String(detail.code)}`;
  }
  if (typeof record.message === "string" && record.message.trim()) return record.message;
  return undefined;
}

/**
 * Submit a VIDEO task: `POST {base}/videos` → `202 {id, polling_url, status}`.
 *
 * The response carries no media — the task is polled by `pollVideo()`.
 */
async function submitVideo(input: GenerateInput): Promise<SubmitOutcome> {
  const cfg = input.credentials;
  const binding = input.binding;

  if (binding.presetError) throw new Error(binding.presetError);

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
  const body = buildVideoBody(input, binding.upstreamModelId, spec);

  // Shape only — never the body (the prompt is user content, the references
  // are user media).
  console.log("[openai-compat] video request →", {
    host: urlHost(url) ?? "unknown",
    model: binding.upstreamModelId,
    fields: Object.keys(body).sort(),
  });

  const res = await fetchWithRetry(input.taskId, url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error("Invalid API key for this OpenAI-compatible backend — please update it in Settings.");
    }
    let message = text.slice(0, 300);
    try {
      message = errorMessageOf(JSON.parse(text)) ?? message;
    } catch { /* not JSON — keep the excerpt */ }
    throw new Error(`Upstream error ${res.status}: ${message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Upstream returned non-JSON: ${text.slice(0, 200)}`);
  }

  const record = (json ?? {}) as { id?: unknown; task_id?: unknown; polling_url?: unknown };
  const id =
    (typeof record.id === "string" && record.id) ||
    (typeof record.task_id === "string" && record.task_id) ||
    "";
  if (!id) throw new Error("Upstream returned no video task id");

  const statusUrl = resolvePollingUrl(
    typeof record.polling_url === "string" ? record.polling_url : undefined,
    baseUrl,
    id,
  );

  appendJobLog(input.taskId, "submit", `video task accepted · id ${id} · status ${statusUrl}`);

  const providerMeta: ProviderMeta = {
    upstreamTaskId: id,
    family: (binding.family as string | undefined) ?? "standard",
    statusUrl,
    upstreamModelId: binding.upstreamModelId,
  };

  return { mode: "async", upstreamTaskId: id, providerMeta };
}

/**
 * One tick of the video poll loop.
 *
 * Status mapping (the contract's six):
 *   pending / in_progress → pending
 *   completed             → done
 *   failed / cancelled / expired → error (the job's own error string)
 *
 * A finished task's BYTES live behind a bearer-authenticated endpoint
 * (`…/content?index=0`), and the settle funnel's mirror sends no
 * Authorization header ⇒ the bytes are fetched here and handed over as raw
 * buffers (the "video buffers, not b64" path). When the fetch fails the tick
 * stays `pending` and the next tick retries it.
 */
async function pollVideo(
  upstreamTaskId: string,
  kind: "image" | "video",
  cfg: ProviderRuntimeConfig,
  meta?: ProviderMeta,
): Promise<PollOutcome> {
  if (kind !== "video") {
    return { state: "error", error: "openai-compat: polling is implemented for video tasks only." };
  }
  const apiKey = cfg.apiKey;
  if (!apiKey) {
    return { state: "error", error: "No API key configured for this OpenAI-compatible backend. Add one in Settings." };
  }
  const statusUrl = meta?.statusUrl ?? "";
  if (!statusUrl) {
    return { state: "error", error: "openai-compat: the video task carries no status URL." };
  }

  const res = await fetch(statusUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      message = errorMessageOf(JSON.parse(text)) ?? message;
    } catch { /* not JSON — keep the excerpt */ }
    return { state: "error", error: `Upstream error ${res.status}: ${message}` };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { state: "error", error: `Upstream returned non-JSON: ${text.slice(0, 200)}` };
  }
  const record = (json ?? {}) as Record<string, unknown>;
  const status = String(record.status ?? record.state ?? "").toLowerCase();

  if (status === "completed") {
    const contentUrl = contentUrlOf(statusUrl);
    if (contentUrl) {
      try {
        const contentRes = await fetch(contentUrl, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (contentRes.ok) {
          const buffer = Buffer.from(await contentRes.arrayBuffer());
          if (buffer.length > 0) {
            const mimeType =
              contentRes.headers.get("content-type")?.split(";")[0]?.trim() || "video/mp4";
            return { state: "done", mediaUrls: [], buffers: [{ buffer, mimeType }] };
          }
        }
      } catch {
        // The content endpoint is not ready yet — the next tick retries it.
      }
    }
    const unsigned = stringArray(record.unsigned_urls);
    const signed = stringArray(record.urls);
    if (unsigned.length === 0 && signed.length === 0) {
      // Nothing to fetch and nothing to mirror — keep the task alive for the
      // next tick instead of settling with an empty result.
      return { state: "pending" };
    }
    return { state: "done", mediaUrls: unsigned.length ? unsigned : signed };
  }

  if (status === "failed" || status === "cancelled" || status === "expired") {
    return {
      state: "error",
      error: errorMessageOf(record) ?? `Video generation ${status}`,
    };
  }

  // pending / in_progress (and any status the backend adds later) → keep polling.
  return { state: "pending" };
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
    // The IMAGES leg is sync (one POST returns the media)…
    syncSubmission: true,
    // …the VIDEO leg is async (202 + polling_url ⇒ the poll loop below).
    polling: true,
    // The upload hook IS implemented (see `uploadMedia` below) — it is only
    // REACHED by a binding that stages media as "remote-url" (Pollinations;
    // OpenRouter's video lane, whose local frames are staged through the
    // Pollinations media store as a cross-provider upload).
    mediaUpload: true,
    mediaStaging: "data-url",
    // The family serves video too (the async `/videos` leg).
    video: true,
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
   *
   * The AUTHENTICATING KEY follows the binding too: a `mediaUpload` that
   * names a `keyProviderId` is a cross-provider upload (e.g. the OpenRouter
   * video lane stages local frames through the Pollinations media store) and
   * is authenticated with THAT provider's key — see `resolveUploadKey`.
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
    const apiKey = resolveUploadKey(cfg, binding, spec);
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
    // The VIDEO leg of the family (OpenRouter's `/videos`) is async: it
    // answers `202 {id, polling_url}` and the result arrives through the poll
    // loop. The IMAGES leg below is untouched.
    if (input.kind === "video") return submitVideo(input);

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
    const shape = bodyShape(body, spec);

    // The request is logged as a SHAPE only — host, model, field names and
    // the reference COUNT. Never the body (the prompt is user content, the
    // staged references are base64 blobs) and never the key.
    console.log("[openai-compat] request →", {
      host: urlHost(url) ?? "unknown",
      model: upstreamModelId,
      fields: shape.fields,
      stagedReferences: shape.stagedReferences,
    });

    const res = await fetchWithRetry(
      input.taskId,
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error("Invalid API key for this OpenAI-compatible backend — please update it in Settings.");
      }
      // The upstream body is NOT logged (it can echo the prompt): only the
      // status class and the body's SIZE go into the trail. The excerpt stays
      // in the thrown error, which the job's terminal message already carries.
      appendJobLog(
        input.taskId,
        "submit",
        `upstream error · HTTP ${res.status} (${statusClass(res.status)}) · ${text.length} byte(s) of body`,
      );
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

    appendJobLog(
      input.taskId,
      "submit",
      `upstream answered · ${mediaUrls.length} url(s) · ${rawBuffers.length} buffer(s)`,
    );

    return { mode: "sync", mediaUrls, rawBuffers };
  },

  /**
   * One tick of the family's ASYNC leg (the video dialect).
   *
   * The upstream task survives a server restart, so the job manager can
   * restart the loop from the persisted `provider_meta` (`statusUrl`).
   */
  async poll(
    upstreamTaskId: string,
    kind: "image" | "video",
    cfg: ProviderRuntimeConfig,
    meta?: ProviderMeta,
  ): Promise<PollOutcome> {
    return pollVideo(upstreamTaskId, kind, cfg, meta);
  },
};

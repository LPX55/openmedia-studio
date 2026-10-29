/**
 * `hf-gradio` adapter — P7 plan §b (HF Spaces / Gradio, step 3).
 *
 * ONE adapter serves the whole Gradian Space family. Every HF Space rides it
 * as a BINDING (each Space its own backend base URL; the HF token is one
 * credentials row for the whole family) — never as a code branch:
 *
 *   binding.baseUrl          the Space origin ("https://<owner>-<space>.hf.space")
 *   binding.upstreamModelId  the fn channel ("/generate_image", …) — NOT a
 *                            model string; the positional data[] replaces
 *                            everything a model id would shape
 *   binding.argMap           the GradioArgMap DIALECT: data[] index →
 *                            normalized source / constant, plus the
 *                            fileInputs set (see bindings.ts)
 *   binding.keyEnv           env var with the HF token (the stored DB key wins)
 *
 * THE WIRE SHAPE (spike-verified, `docs/provider-phase7-spike.md`):
 *
 *   submit:  POST {base}/gradio_api/call/{fn}          body {data: [...]}
 *            → 200 {event_id}
 *   poll:    GET  {base}/gradio_api/call/{fn}/{event_id}
 *            → an SSE stream (the "invisible response") whose frames are
 *              `event: <complete|generating|error|heartbeat>` + `data: <json>`.
 *              The FIRST frame may arrive mid-stream; the reader keeps consuming
 *              until a terminal frame or EOF. Per-tick budget is
 *              POLL_TICK_TIMEOUT_MS — an abort is a transient transport
 *              failure: the job loop retries, the next tick re-opens the
 *              stream with the SAME event_id.
 *   upload:  POST {base}/gradio_api/upload             multipart field "files"
 *            → JSON array of uploaded paths ("/tmp/gradio/…"), which a data[]
 *              slot wraps as {"path": …, "meta": {"_type": "gradio.FileData"}}.
 *
 * RESULT DELIVERY — the public/private split (plan §b, pinned):
 *
 *  - PUBLIC Space (no token): the completed payload carries a real URL — hand
 *    it back as `mediaUrls` and let the settle funnel mirror the bytes.
 *  - PRIVATE Space (token present): the file URL is token-gated — the settle
 *    funnel can NOT mirror it. The adapter fetches the bytes ITSELF (with the
 *    bearer token, bounded by MAX_BUFFER_BYTES) and returns them via the
 *    `done.buffers` path with an EMPTY `mediaUrls` — the private URL is never
 *    handed to the settle funnel.
 *
 * SERVER-ONLY: guest paths + node-style fetch — never import from client code.
 */
import { MEDIA_DIR } from "../../guest/paths";
import { appendJobLog, urlHost } from "../../jobLog";
import type { ProviderMeta } from "../../jobStore";
import type { GradioArgMap, ModelProviderBinding } from "../bindings";
import type {
  GenerateInput,
  GenerationProvider,
  PollOutcome,
  ProviderRuntimeConfig,
  SubmitOutcome,
} from "../types";
import { resolveFieldValue } from "./sources";

/** The whole submit shares one budget (mirrors openaiCompat's bounded POST). */
const SUBMIT_TIMEOUT_MS = 60_000;

/**
 * ONE poll tick's read budget. A Space generating a video streams mostly
 * heartbeats — an idle stream must not hold the tick forever. An abort here
 * is a TRANSIENT failure: `poll()` throws, the job loop keeps the task, and
 * the next tick re-opens the stream (the event_id is still valid upstream).
 * Exported because smoke-gradio asserts the contract window [20 s, 30 s].
 */
export const POLL_TICK_TIMEOUT_MS = 25_000;

/** The ceiling of an in-adapter private-Space byte fetch (done.buffers path). */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

// ── Config resolvers ────────────────────────────────────────────────────────

/** Strip trailing slashes so `base + path` never doubles up. */
function trimBase(base: string): string {
  return base.replace(/\/+$/, "");
}

/**
 * The Space's base URL: the binding's pinned URL wins (a code-seeded Space
 * carries its own), otherwise the provider config's `base_url` (a user-added
 * Space configured in Settings). No Space URL is hardcoded in this module.
 */
function resolveSpaceBaseUrl(
  cfg: ProviderRuntimeConfig,
  binding: ModelProviderBinding | undefined,
): string | null {
  const raw = binding?.baseUrl ?? cfg.baseUrl ?? null;
  if (!raw || !raw.trim()) return null;
  return trimBase(raw.trim());
}

/**
 * The HF token: the stored DB key (resolved for the provider id by
 * `lib/guest/db.ts`) wins; otherwise the binding's `keyEnv` env var
 * ("HF_TOKEN", the family default when the binding is not in hand — poll()
 * sees no binding). Token OPTIONAL — public Spaces answer unauthenticated.
 */
const GRADIO_TOKEN_ENV_DEFAULT = "HF_TOKEN";

function resolveSpaceToken(
  cfg: ProviderRuntimeConfig,
  binding: ModelProviderBinding | undefined,
): string | null {
  if (cfg.apiKey && cfg.apiKey.trim()) return cfg.apiKey.trim();
  const envName = binding?.keyEnv ?? GRADIO_TOKEN_ENV_DEFAULT;
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return null;
}

/** Fn channel normalization: exactly one leading slash ("/generate_image"). */
function normalizeFn(raw: string): string {
  return "/" + raw.replace(/^\/+/, "");
}

// ── The positional data[] array ─────────────────────────────────────────────

/**
 * The Gradio FileData dict for one file slot — the shape a `/gradio_api/upload`
 * path (or a public media URL) rides in, verified on the positional dialect.
 */
function fileDataOf(value: string): { path: string; meta: { _type: string } } {
  return { path: value, meta: { _type: "gradio.FileData" } };
}

/**
 * The positional `data[]` array of an argMap call: every index from 0 through
 * the highest mapped index contributes a value; an UNRESOLVED index rides as
 * a literal `null` — Gradio's wire shape for "use the upstream default". The
 * array's shape itself must NEVER shrink (positional order is authoritative).
 *
 * Resolution order at each index: fileInputs slot (a staged media wrapped
 * into FileData) → constant → source — the spec's precedence, so a fileIndex
 * listed in `sources` AND `fileInputs` still ends up wrapped.
 */
function buildDataArray(
  input: GenerateInput,
  argMap: GradioArgMap,
): unknown[] {
  const sources = argMap.sources ?? {};
  const constants = argMap.constants ?? {};
  const fileInputs = new Set(argMap.fileInputs ?? []);
  const indices = new Set([
    ...Object.keys(sources),
    ...Object.keys(constants),
    ...fileInputs,
  ]);
  const maxIndex = indices.size > 0 ? Math.max(...[...indices].map(Number)) : -1;

  const data: unknown[] = [];
  for (let i = 0; i <= maxIndex; i += 1) {
    const key = String(i);
    if (fileInputs.has(key)) {
      const value = sources[key] !== undefined
        ? resolveFieldValue(
            sources[key] as Parameters<typeof resolveFieldValue>[0],
            input,
          )
        : undefined;
      data.push(typeof value === "string" && value ? fileDataOf(value) : null);
      continue;
    }
    if (key in constants) {
      data.push(constants[key]);
      continue;
    }
    const source = sources[key];
    if (source === undefined) {
      data.push(null);
      continue;
    }
    const value = resolveFieldValue(
      source as Parameters<typeof resolveFieldValue>[0],
      input,
    );
    // `undefined` ⇒ not resolvable THIS call (e.g. one frame of a pair) — the
    // slot still exists, it just takes the upstream default (literal null).
    data.push(value === undefined ? null : value);
  }
  return data;
}

/** The one-line shape description for the log (never the body itself). */
function dataShape(data: unknown[]): string {
  const kinds = data.map((v) =>
    v === null || v === undefined
      ? "null"
      : typeof v === "string"
        ? "str"
        : typeof v === "number"
          ? "num"
          : typeof v === "boolean"
            ? "bool"
            : v && typeof v === "object" && "path" in (v as Record<string, unknown>)
              ? "file"
              : "obj",
  );
  return `data[${data.length}] { ${kinds.join(", ")} }`;
}

// ── Submit ──────────────────────────────────────────────────────────────────

async function submit(input: GenerateInput): Promise<SubmitOutcome> {
  const cfg = input.credentials;
  const binding = input.binding;
  const argMap = binding.argMap;
  if (!argMap) {
    throw new Error(
      `hf-gradio: the "${binding.modelId}" binding declares no argMap — a Gradio ` +
        `Space call cannot be built without its positional data[] map.`,
    );
  }
  const rawFn = binding.upstreamModelId;
  if (!rawFn || !rawFn.trim()) {
    throw new Error(
      `hf-gradio: the "${binding.modelId}" binding carries no upstream fn name — ` +
        `set upstreamModelId to the Space's endpoint (e.g. "/generate_image").`,
    );
  }
  const fn = normalizeFn(rawFn);
  const baseUrl = resolveSpaceBaseUrl(cfg, binding);
  if (!baseUrl) {
    throw new Error(
      `hf-gradio: the "${binding.modelId}" binding carries no Space base URL — ` +
        `set baseUrl to the Space origin (e.g. "https://<owner>-<space>.hf.space").`,
    );
  }

  const data = buildDataArray(input, argMap);
  const token = resolveSpaceToken(cfg, binding);

  appendJobLog(
    input.taskId,
    "submit",
    `[hf-gradio] ${fn} @ ${urlHost(baseUrl)} · ${dataShape(data)} · kind ${input.kind}`,
  );

  const url = `${baseUrl}/gradio_api/call${fn}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ data }),
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`hf-gradio submit failed (${res.status}): ${text.slice(0, 300)}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`hf-gradio submit returned non-JSON: ${text.slice(0, 200)}`);
  }
  const record = (payload ?? {}) as { event_id?: unknown };
  const eventId = typeof record.event_id === "string" ? record.event_id : "";
  if (!eventId) throw new Error("hf-gradio submit returned no event_id");

  const statusUrl = `${baseUrl}/gradio_api/call${fn}/${encodeURIComponent(eventId)}`;

  appendJobLog(input.taskId, "submit", `[hf-gradio] queued · event ${eventId} · status ${statusUrl}`);

  const providerMeta: ProviderMeta = {
    upstreamTaskId: eventId,
    family: "gradio",
    statusUrl,
    upstreamModelId: fn,
  };

  return { mode: "async", upstreamTaskId: eventId, providerMeta };
}

// ── Poll ────────────────────────────────────────────────────────────────────

/**
 * One SSE frame: the `event:` value and the joined `data:` payload.
 * (Gradio's `data:` may be split across lines on transport — join with "\n".)
 */
interface SseFrame {
  event: string;
  data: string;
}

function framesFrom(chunk: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = chunk;
  for (;;) {
    const idx = rest.indexOf("\n\n");
    if (idx < 0) break;
    const block = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    frames.push({ event, data: dataLines.join("\n") });
  }
  return { frames, rest };
}

/**
 * The first FileData-ish entry of a completed payload — a recursive scan,
 * because the payload shape is Space-dependent (`FileData` bare, `[FileData]`,
 * or `[VideoData]` with the file nested under `video`/`image`).
 */
function firstFileData(payload: unknown): { path?: string; url?: string } | null {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = firstFileData(item);
      if (found) return found;
    }
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  const path = obj.path;
  if (typeof path === "string" && path) return { path, url: typeof obj.url === "string" ? obj.url : undefined };
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      const found = firstFileData(value);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The ORIGIN-SECURITY model (plan §f / review blocker on 7177592):
 *
 * A file reference handed to the settle funnel — or fetched HERE with the
 * user's bearer token — must point at the Space we pinned (the statusUrl's
 * origin). An absolute URL on ANY other host is a foreign-protocol escape:
 *
 *  - PRIVATE path: the in-adapter byte fetch carries `Authorization: Bearer
 *    <hf_token>` — a foreign url in the payload would exfiltrate the token.
 *  - PUBLIC path: the URL rides `mediaUrls` into the settle funnel's
 *    headerless fetch (no host validation, follows redirects) — a foreign
 *    url would be adapter-introduced SSRF.
 *
 * So `fileUrlOf` validates every absolute candidate against `origin`:
 * http(s)-only, NO userinfo (`user:pass@` hosts ride on `origin` anyway, and
 * the URL-parser result is still rejected), pin-scheme-or-nothing. A
 * candidate that fails ANY of these is reported as a DISTINCT `foreign`
 * outcome (never silently dropped, never silently used) so the caller can
 * settle a loud error. A path-shaped reference (`/tmp/gradio/…`) builds its
 * URL on the pinned origin by construction.
 */
type FileUrlResolution =
  | { outcome: "resolved"; url: string }
  | { outcome: "foreign"; candidate: string }
  | { outcome: "missing" };

/** http(s), no userinfo, origin === pinned origin. Everything else is "no". */
function sameOriginSafe(candidate: string, origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (parsed.username || parsed.password) return false;
  return parsed.origin === origin;
}

function fileUrlOf(origin: string, entry: { path?: string; url?: string }): FileUrlResolution {
  let foreign: string | undefined;
  let relative: string | undefined;
  for (const raw of [entry?.url, entry?.path]) {
    const candidate = typeof raw === "string" ? raw.trim() : "";
    if (!candidate) continue;
    if (/^(https?:)?\/\//i.test(candidate)) {
      if (sameOriginSafe(candidate, origin)) {
        return { outcome: "resolved", url: candidate };
      }
      // Keep scanning — a later pin-safe path does NOT launder a foreign URL
      // into a resolved outcome; foreign wins when we reach the end.
      foreign ??= candidate;
      continue;
    }
    relative ??= candidate;
  }
  if (foreign) return { outcome: "foreign", candidate: foreign };
  if (relative) {
    // The path is the ABSOLUTE upstream file path (e.g. "/tmp/gradio/…") and
    // rides VERBATIM after "file=" — Gradio's wire form never strips it.
    return { outcome: "resolved", url: `${origin}/gradio_api/file=${relative}` };
  }
  return { outcome: "missing" };
}

/** The message of an upstream `event: error` frame. */
function errorDataMessage(data: string): string {
  try {
    const payload = JSON.parse(data) as unknown;
    if (typeof payload === "string") return payload;
    const record = payload as { message?: unknown; error?: unknown; detail?: unknown };
    for (const candidate of [record.message, record.error, record.detail]) {
      if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
  } catch {
    /* not JSON — use the raw text */
  }
  return data.trim() || "unknown Space error";
}

/**
 * One tick of the gradio poll loop — reads ONLY `meta.statusUrl` (the poll
 * contract: no binding, no re-resolve).
 *
 * The status endpoint answers with an SSE "invisible response": the frame we
 * wait for may be the FIRST one (images) or arrive after heartbeats (video).
 * The reader consumes incrementally and returns on the first terminal frame;
 * EOF without one keeps the task pending (the next tick re-opens by event id),
 * and a mid-stream abort propagates as a throw — a transient transport
 * failure the job loop retries with a fresh tick budget.
 */
async function pollWind(
  kind: "image" | "video",
  cfg: ProviderRuntimeConfig,
  meta: ProviderMeta | undefined,
): Promise<PollOutcome> {
  if (kind !== "image" && kind !== "video") {
    return { state: "error", error: `hf-gradio: unknown task kind ${String(kind)}.` };
  }
  const statusUrl = meta?.statusUrl ?? "";
  if (!statusUrl) {
    return { state: "error", error: "hf-gradio: the task carries no status URL." };
  }
  // The poll contract is binding-less — the token is the resolved config key
  // (the whole gradio family keeps ONE credentials row) with the HF_TOKEN env
  // as the last fallback.
  const token = resolveSpaceToken(cfg, undefined);

  const res = await fetch(statusUrl, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(POLL_TICK_TIMEOUT_MS),
    // A 30x from the pinned origin must NOT be followed: the Location target
    // would inherit this tick's Authorization header (and the next tick's)
    // without ever being pinned. redirect:"error" makes any redirect a
    // transient throw — the job loop retries, the Space self-heals or fails.
    redirect: "error",
  });
  if (!res.ok) {
    // A non-SSE status answer is a transport-level failure — transient: the
    // job loop retries (a Space restarting answers 502/503 mid-generation).
    throw new Error(`hf-gradio status fetch failed (${res.status})`);
  }
  if (!res.body) return { state: "pending" };

  const origin = new URL(statusUrl).origin;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = framesFrom(buffer);
      buffer = parsed.rest;
      for (const frame of parsed.frames) {
        if (frame.event === "complete") {
          let payload: unknown;
          try {
            payload = JSON.parse(frame.data);
          } catch {
            throw new Error(`hf-gradio complete frame carried non-JSON: ${frame.data.slice(0, 200)}`);
          }
          const entry = firstFileData(payload);
          if (!entry) {
            // A completed job with no file entry — settle empty rather than
            // hang (the upstream said complete).
            return { state: "error", error: "hf-gradio: the Space completed without a file payload." };
          }
          const resolution = fileUrlOf(origin, entry);
          if (resolution.outcome === "foreign") {
            return {
              state: "error",
              error:
                `hf-gradio: the Space returned a file URL on a foreign origin ` +
                `(${resolution.candidate} != ${origin}). No request was made.`,
            };
          }
          if (resolution.outcome === "missing") {
            return { state: "error", error: "hf-gradio: the Space completed without a resolvable file URL." };
          }
          const fileUrl = resolution.url;
          // Defense in depth: re-validate BEFORE any fetch ever carries the
          // bearer token (do not rely on fileUrlOf alone).
          if (!sameOriginSafe(fileUrl, origin)) {
            return {
              state: "error",
              error:
                `hf-gradio: the Space returned a file URL on a foreign origin ` +
                `(${fileUrl} != ${origin}). No request was made.`,
            };
          }
          if (!token) {
            // PUBLIC Space: the URL is fetchable by anyone — settle With it
            // and let the mirror own the bytes.
            return { state: "done", mediaUrls: [fileUrl] };
          }
          // TOKEN PRESENT ⇒ treat the Space as PRIVATE: the settle funnel's
          // mirror sends no Authorization header → the bytes are fetched HERE
          // (the openaiCompat video-buffers parity — "buffers, not URLs").
          // NEVER hand the (possibly token-gated) URL to the settle funnel.
          try {
            const fileRes = await fetch(fileUrl, {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(POLL_TICK_TIMEOUT_MS),
              redirect: "error",
            });
            if (!fileRes.ok) {
              // Not ready yet / hiccup — keep the task alive for the next tick.
              return { state: "pending" };
            }
            const declared = Number(fileRes.headers.get("content-length") ?? "0");
            if (declared > MAX_BUFFER_BYTES) {
              return { state: "error", error: `hf-gradio: the Space's file exceeds the ${MAX_BUFFER_BYTES / 1024 / 1024} MB buffer ceiling.` };
            }
            const raw = await fileRes.arrayBuffer();
            if (raw.byteLength > MAX_BUFFER_BYTES) {
              return { state: "error", error: `hf-gradio: the Space's file exceeds the ${MAX_BUFFER_BYTES / 1024 / 1024} MB buffer ceiling.` };
            }
            if (raw.byteLength === 0) return { state: "pending" };
            const buffer = Buffer.from(raw);
            const mimeType =
              fileRes.headers.get("content-type")?.split(";")[0]?.trim() ||
              (kind === "video" ? "video/mp4" : "image/png");
            return { state: "done", mediaUrls: [], buffers: [{ buffer, mimeType }] };
          } catch {
            // A byte-fetch failure is NOT a generation failure — the next
            // tick re-opens the stream and retries the fetch.
            return { state: "pending" };
          }
        }
        if (frame.event === "error") {
          return { state: "error", error: `hf-gradio: the Space failed: ${errorDataMessage(frame.data)}` };
        }
        // generating / heartbeat / process_starts / any other keepalive →
        // keep reading inside THIS response.
      }
    }
    // EOF without a terminal frame — the stream closed early; keep polling.
    return { state: "pending" };
  } finally {
    // Release the upstream stream when we return early (error/complete).
    try {
      await reader.cancel();
    } catch {
      /* the stream may already be closed */
    }
  }
}

async function poll(
  upstreamTaskId: string,
  kind: "image" | "video",
  cfg: ProviderRuntimeConfig,
  meta?: ProviderMeta,
): Promise<PollOutcome> {
  void upstreamTaskId; // the stream is identified by meta.statusUrl alone
  return pollWind(kind, cfg, meta);
}

// ── Upload ──────────────────────────────────────────────────────────────────

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
 * A node fetch / Blob-typing-safe copy of the bytes (Node `Buffer` is a POOLED
 * view — mirror of openaiCompat's `toBodyBytes`).
 */
function toBodyBytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(buffer.byteLength);
  out.set(buffer);
  return out;
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
 * The bytes of a staged local input: a data: URI, a stripped http(s) URL, or a
 * `/generated/…` path under MEDIA_DIR (mirror of openaiCompat's readLocalBytes
 * with `hf-gradio`-prefixed errors).
 */
async function readLocalBytes(
  raw: string,
  mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  if (raw.startsWith("data:")) {
    const m = /^data:([^;,]+)?((?:;[^;,]+)*),([\s\S]*)$/.exec(raw);
    if (!m) throw new Error("hf-gradio upload: malformed data: URI");
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
      throw new Error(`hf-gradio upload: source fetch failed (${res.status}): ${raw}`);
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

// ── Provider object ─────────────────────────────────────────────────────────

export const gradioProvider: GenerationProvider = {
  id: "hf-gradio",
  label: "HF Space (Gradio)",

  mediaStaging: "remote-url",

  capabilities: {
    syncSubmission: false, // the queued event_id always arrives via polling
    polling: true,
    mediaUpload: true, // the required uploadMedia hook of "remote-url"
    mediaStaging: "remote-url",
    video: true, // wan2-1-fast is a video Space
  },

  /**
   * Ready iff the binding resolves a Space base URL. The token is OPTIONAL
   * (public Spaces answer unauthenticated) — its only side effect is the
   * public/private result split in poll().
   */
  checkReadiness(
    cfg: ProviderRuntimeConfig,
    binding?: ModelProviderBinding,
  ): { ready: boolean; reason?: string } {
    if (!resolveSpaceBaseUrl(cfg, binding)) {
      return {
        ready: false,
        reason: "No Space base URL configured for this HF Space binding. Add one in Settings (e.g. https://<owner>-<space>.hf.space).",
      };
    }
    return { ready: true };
  },

  submit(input: GenerateInput): Promise<SubmitOutcome> {
    return submit(input);
  },

  poll(upstreamTaskId, kind, cfg, meta) {
    return poll(upstreamTaskId, kind, cfg, meta);
  },

  /**
   * Uploads one staged media item to the BINDING's Space (`POST 
   * /gradio_api/upload`, multipart field "files") and returns the uploaded
   * path — a "/tmp/gradio/…" string the mediaStager "remote-url" branch
   * stores verbatim in `StagedMedia.url` (it is NOT a public URL; only the
   * adapter ever turns it into a FileData dict).
   */
  async uploadMedia(
    localPathOrDataUrl: string,
    mimeType: string,
    cfg: ProviderRuntimeConfig,
    binding?: ModelProviderBinding,
  ): Promise<string> {
    const baseUrl = resolveSpaceBaseUrl(cfg, binding);
    if (!baseUrl) {
      throw new Error(
        `hf-gradio: the "${binding?.modelId ?? "unknown"}" binding carries no Space base URL — ` +
          `local media cannot be uploaded without it.`,
      );
    }
    const token = resolveSpaceToken(cfg, binding);
    const bytes = await readLocalBytes(localPathOrDataUrl, mimeType);

    const form = new FormData();
    form.append("files", new Blob([toBodyBytes(bytes.buffer)], { type: bytes.mimeType }), bytes.filename);

    const res = await fetch(`${baseUrl}/gradio_api/upload`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form, // fetch sets the multipart boundary itself
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`hf-gradio upload failed (${res.status}): ${text.slice(0, 300)}`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`hf-gradio upload returned non-JSON: ${text.slice(0, 200)}`);
    }
    const paths = Array.isArray(payload)
      ? payload.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : [];
    if (paths.length === 0) {
      throw new Error(`hf-gradio upload: the Space returned no uploaded path (${text.slice(0, 200)})`);
    }
    return paths[0];
  },
};

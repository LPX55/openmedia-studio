/**
 * `mcp` adapter — P7c (plan `docs/provider-mcp-spaces-plan.md` §b P7c, step 4).
 *
 * ONE adapter serves every MCP (Model Context Protocol) server backend. A
 * server rides it as a BINDING — never as a code branch:
 *
 *   binding.baseUrl          the streamable-HTTP MCP endpoint
 *                            (e.g. "https://<space>/gradio_api/mcp/" — the
 *                            trailing slash is required by Gradio, 307
 *                            without it, and `redirect:"error"` refuses to
 *                            follow it)
 *   binding.upstreamModelId  the TOOL NAME (`tools/call.params.name`) — NOT a
 *                            model string
 *   binding.argMap           the named-argument dialect: argument name →
 *                            normalized source / constant (see `McpArgMap`)
 *   binding.keyEnv           env var holding the bearer token (the stored DB
 *                            key wins; the token is OPTIONAL — public servers)
 *
 * THE WIRE SHAPE (spike-verified, `docs/provider-phase7-spike.md`):
 *
 *   initialize              POST <base> {"method":"initialize", …}
 *                           → 200, application/json OR text/event-stream
 *                             (Gradio/fastmcp always answer SSE even when JSON
 *                             was offered — branch on the RESPONSE
 *                             content-type, never on our Accept header)
 *                           → `result.protocolVersion` is the NEGOTIATED
 *                             version; `Mcp-Session-Id` is captured when the
 *                             server issues one
 *   notifications/initialized POST <base> {"method":"notifications/initialized"}
 *                           → 202, EMPTY body — never parsed
 *   tools/call              POST <base> {"method":"tools/call", …}
 *                           → 200, the tool result envelope
 *
 * PROTOCOL VERSION IS NEGOTIATED, NEVER A CONSTANT: every handshake advertises
 * `2025-06-18` as the floor; once the server answers, `result.protocolVersion`
 * is adopted for all LATER requests (a future SDK-2.x server upgrades
 * transparently). A server that rejects the floor answers 400 — the adapter
 * fails LOUDLY with the server's supported-version list (Gradio: mcp 1.x).
 *
 * SESSION: `Mcp-Session-Id` (when issued) is resent on every later request. A
 * 404 after the handshake means the server forgot the session ⇒ re-initialize
 * EXACTLY ONCE and retry the request once; a second 404 is loud (never a loop).
 *
 * RESULT DELIVERY — ONE blocking `tools/call` → `{mode:"sync"}`:
 *   the MCP path has no upstream task id, so `submit()` blocks (bounded by
 *   `MCP_REQUEST_TIMEOUT_MS` — an unbounded MCP call would outlive its job).
 *   The defensive parse order (P7c brief):
 *     1. `content[]` item `type:"image"` base64 → bounded Buffer (64 MB);
 *     2. `resource` / `resource_link` URI → `mediaUrls`;
 *     3. URL regex out of text content (Gradio emits a Python-repr blob with
 *        `{'path': …, 'url': 'https://<space>/gradio_api/file=…'}`);
 *     4. `isError:true` → TOOL error (HTTP 200 — not a protocol error);
 *     5. nothing found → loud "no media in tool result (content types: …)".
 *
 * ORIGIN PIN (httpSafe): every URL recovered from a tool result must pass
 * `sameOriginSafe(candidate, configured server origin)` BEFORE it can reach
 * `mediaUrls` (the settle funnel mirrors it with a headerless, redirect-
 * following fetch) or any in-adapter byte fetch. A foreign / userinfo /
 * non-http(s) URL is a LOUD, distinct error — never a silent drop, never a
 * foreign fetch, never the bearer token to another host.
 *
 * V1 IS IMAGES ONLY. An MCP VIDEO result needs the URL branch (a same-origin
 * file URL mirrored by the settle funnel byte-bounded) — an unbounded base64
 * buffer would inflate worker RAM twice. `kind:"video"` is refused with an
 * actionable error naming that requirement; `capabilities.video:false` also
 * makes the video route refuse the request before it gets here.
 *
 * STAGING: `data-url` (MCP image tools overwhelmingly accept data URLs /
 * public URLs as string args). A binding MAY declare `remote-url` only when it
 * names its own upload path (`binding.mediaUpload.url`) — `uploadMedia()`
 * below implements that path; a binding without one fails LOUDLY with the
 * openrouter-video wording ("no upload endpoint documented ⇒ a local file
 * fails loudly"), never a silent workaround.
 *
 * SERVER-ONLY (guest paths, node:fs, process.env) — never import from client
 * code.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { envFallbackKeyName, getProviderRuntimeConfig } from "../../guest/db";
import { MEDIA_DIR } from "../../guest/paths";
import { appendJobLog, urlHost } from "../../jobLog";
import type {
  CompatFieldSource,
  CompatMediaUpload,
  ModelProviderBinding,
} from "../bindings";
import type {
  GenerateInput,
  GenerationProvider,
  ProviderRuntimeConfig,
  SubmitOutcome,
} from "../types";
import { framesFrom, pinnedFetch, sameOriginSafe } from "./httpSafe";
import { resolveFieldValue } from "./sources";

/**
 * The protocol version the adapter ADVERTISES on every handshake. It is a
 * FLOOR, not a pin: the server's `result.protocolVersion` is adopted for all
 * later requests (plan rev-2: "Protocol version is NEGOTIATED, never a
 * hardcoded constant").
 */
export const MCP_PROTOCOL_FLOOR = "2025-06-18";

/**
 * Budget of ONE MCP request. The MCP path blocks inside `submit()`, so every
 * request (initialize, notification, tools/call) MUST be bounded — an
 * unbounded call is a bug (plan §b P7c / §d step 4).
 */
export const MCP_REQUEST_TIMEOUT_MS = 60_000;

/**
 * The ceiling of an in-adapter base64 image buffer (the gradio
 * `MAX_BUFFER_BYTES` pattern): the bytes ride `rawBuffers` into the settle
 * funnel, so a hostile/huge payload must be refused before it is allocated
 * twice.
 */
export const MAX_MCP_BUFFER_BYTES = 64 * 1024 * 1024;

/** The MCP client identity sent in `initialize.params.clientInfo`. */
const CLIENT_INFO = { name: "openmedia-studio", version: "1.0.0" } as const;

// ── The named-argument dialect ──────────────────────────────────────────────

/**
 * The DIALECT of an `mcp` binding — MCP arguments are NAMED, so this is a flat
 * map (the counterpart of `GradioArgMap`'s positional `data[]` map):
 *
 *  - `sources`   — argument name → normalized source (the SHARED
 *                  `CompatFieldSource` union, resolved by `./sources` — a
 *                  single-file slot for a media argument, e.g. "startFrame").
 *  - `constants` — argument name → static upstream value.
 *
 * P7a-3's dedicated `McpArgMap` field in `bindings.ts` is not in this commit's
 * write scope; the shape below is structurally identical to `GradioArgMap`'s
 * keyed members, and the adapter reads it from `binding.argMap` (a MCP
 * binding never carries positional `fileInputs` — that member is ignored).
 */
export interface McpArgMap {
  sources?: Record<string, CompatFieldSource>;
  constants?: Record<string, string | number | boolean>;
}

/** One `content[]` item of a tool result (only the members this adapter reads). */
type ContentItem = Record<string, unknown>;

/** One decoded media buffer (`SubmitOutcome.rawBuffers`). */
interface RawBuffer {
  buffer: Buffer;
  mimeType: string;
}

/**
 * The terminal interpretation of one `tools/call` result.
 *
 * `tool-error` is the `isError:true` case — a TOOL failure carried by an HTTP
 * 200 (not a JSON-RPC/protocol error). It is returned (not thrown) by
 * `interpretToolResult`; `submit()` converts it into the job-manager's settled
 * error channel (a `McpToolError` throw) so the job ends `error` with the
 * tool's message instead of a protocol/retry classification.
 */
export type McpToolOutcome =
  | { outcome: "media"; mediaUrls: string[]; rawBuffers: RawBuffer[] }
  | { outcome: "tool-error"; message: string }
  | { outcome: "no-media"; message: string };

/**
 * The `isError:true` failure marker. A distinct class so a caller (and the
 * smoke fixture) can tell a TOOL error from a transport/HTTP/protocol throw —
 * the job manager still settles it as an error, but it is never retried and
 * never reported as a protocol failure.
 */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolError";
  }
}

// ── Config resolvers ────────────────────────────────────────────────────────

/**
 * The MCP endpoint: the binding's pinned URL wins (a code-seeded server
 * carries its own), otherwise the provider config's `base_url` (a user-added
 * server configured in Settings). No server URL is hardcoded here.
 */
function resolveServerUrl(
  cfg: ProviderRuntimeConfig,
  binding: ModelProviderBinding | undefined,
): string | null {
  const raw = binding?.baseUrl ?? cfg.baseUrl ?? null;
  if (!raw || !raw.trim()) return null;
  return raw.trim();
}

/**
 * The bearer token: the stored DB key (resolved for the provider id by
 * `lib/guest/db.ts`) wins; otherwise the binding's `keyEnv` env var. The token
 * is OPTIONAL — public MCP servers answer unauthenticated (deepwiki is the
 * spike's live example). There is deliberately NO family-wide default env var:
 * a public server must not accidentally receive an unrelated token.
 */
function resolveToken(
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

/** Validate the configured endpoint: absolute, http(s), no userinfo. */
function validateServerUrl(raw: string): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: `"${raw}" is not a valid absolute URL` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `"${raw}" must be an http(s) URL` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: `"${raw}" must not carry userinfo credentials` };
  }
  return { ok: true };
}

// ── The named arguments object ──────────────────────────────────────────────

/** Constants first, then resolved sources — an unresolved source is NOT sent. */
function buildArguments(input: GenerateInput, argMap: McpArgMap): Record<string, unknown> {
  const args: Record<string, unknown> = { ...(argMap.constants ?? {}) };
  for (const [name, source] of Object.entries(argMap.sources ?? {})) {
    const value = resolveFieldValue(source, input);
    if (value !== undefined) args[name] = value;
  }
  return args;
}

// ── The JSON-RPC transport ──────────────────────────────────────────────────

/** Mutable per-submit session state (one handshake per blocking call). */
interface McpSession {
  baseUrl: string;
  origin: string;
  token: string | null;
  /** Advertised floor before the handshake, the negotiated value afterwards. */
  protocolVersion: string;
  sessionId: string | null;
  /** Guards the "re-initialize EXACTLY ONCE on a 404" rule. */
  reinitialized: boolean;
  nextId: number;
}

/** One JSON-RPC request/notification (a notification has no `id`). */
interface McpMessage {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}

/**
 * The request headers every call carries. `MCP-Protocol-Version` is the
 * advertised floor on the handshake and the NEGOTIATED version everywhere
 * else; `Mcp-Method`/`Mcp-Name` are MUST-sends on 2026-07-28 servers and
 * tolerated by 1.x servers (verified live), so they ride every request to keep
 * SDK-2.x servers from forking the dialect later.
 */
function rpcHeaders(
  session: McpSession,
  method: string,
  name?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // BOTH must be listed — the response may be SSE even for a single JSON
    // body (Gradio/fastmcp), which is why the reader branches on the RESPONSE
    // content-type, never on this header.
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": session.protocolVersion,
    "Mcp-Method": method,
  };
  if (name) headers["Mcp-Name"] = name;
  if (session.sessionId) headers["Mcp-Session-Id"] = session.sessionId;
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  return headers;
}

/** POST one JSON-RPC message — always through `pinnedFetch` (no redirects, bounded). */
function post(session: McpSession, message: McpMessage): Promise<Response> {
  const name =
    message.method === "tools/call" &&
    message.params &&
    typeof (message.params as { name?: unknown }).name === "string"
      ? ((message.params as { name: string }).name)
      : undefined;
  return pinnedFetch(session.baseUrl, {
    method: "POST",
    headers: rpcHeaders(session, message.method, name),
    body: JSON.stringify(message),
    timeoutMs: MCP_REQUEST_TIMEOUT_MS,
  });
}

/** Capture `Mcp-Session-Id` whenever a server issues one (case-insensitive). */
function captureSession(session: McpSession, res: Response): void {
  const sid = res.headers.get("mcp-session-id");
  if (typeof sid === "string" && sid.trim()) session.sessionId = sid.trim();
}

/** A short, body-capped text of an error response (never logged wholesale). */
async function safeBodyText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.trim().slice(0, 300) || "(empty body)";
  } catch {
    return "(unreadable body)";
  }
}

/** The JSON-RPC `error` message, if the payload carries one. */
function protocolErrorOf(payload: unknown): { code: number | string; message: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const record = error as { code?: unknown; message?: unknown };
  return {
    code: typeof record.code === "number" ? record.code : "unknown",
    message: typeof record.message === "string" && record.message.trim() ? record.message : "unknown error",
  };
}

/** Unwrap one JSON-RPC reply envelope into its `result` (protocol errors throw). */
function unwrapReply(payload: unknown, label: string): unknown {
  const protocolError = protocolErrorOf(payload);
  if (protocolError) {
    throw new Error(
      `mcp: ${label} failed (JSON-RPC ${protocolError.code}): ${protocolError.message}`,
    );
  }
  if (!payload || typeof payload !== "object" || !("result" in payload)) {
    throw new Error(`mcp: ${label} returned a JSON-RPC message without a result.`);
  }
  return (payload as { result?: unknown }).result;
}

/**
 * One SSE frame that carries a JSON-RPC REPLY (result/error). Heartbeats
 * (`data: null`), empty frames and server notifications are skipped — they are
 * keepalives, not completions.
 */
function replyPayloadOf(data: string): unknown | undefined {
  const trimmed = data.trim();
  if (!trimmed || trimmed === "null") return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return undefined; // a non-JSON keepalive (e.g. `data: ping`)
  }
  if (!payload || typeof payload !== "object") return undefined;
  if ("result" in payload || "error" in payload) return payload;
  return undefined;
}

/** Read an SSE reply stream until the first JSON-RPC reply frame. */
async function readSseReply(res: Response, label: string): Promise<unknown> {
  if (!res.body) {
    throw new Error(`mcp: ${label} answered text/event-stream without a body.`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE permits CRLF; framesFrom splits on "\n\n" only (shared helper, out
      // of this commit's write scope) — normalise here so a real server's
      // `event: message\r\ndata: …\r\n\r\n` capture parses byte-for-byte.
      buffer = buffer.replace(/\r\n/g, "\n");
      const parsed = framesFrom(buffer);
      buffer = parsed.rest;
      for (const frame of parsed.frames) {
        const payload = replyPayloadOf(frame.data);
        if (payload !== undefined) return unwrapReply(payload, label);
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* the stream may already be closed */
    }
  }
  // EOF without a reply is NOT a completion: heartbeats-only and truncated
  // streams must surface loudly, never as a silent success.
  throw new Error(
    `mcp: ${label} stream ended without a JSON-RPC response (heartbeats/EOF are not a completion).`,
  );
}

/**
 * Read one MCP HTTP response: branch on the RESPONSE content-type —
 * `text/event-stream` → SSE frames; anything else → a JSON body. Exported for
 * the offline smoke fixture (the recorded captures replay through this exact
 * reader).
 */
export async function readMcpReply(res: Response, label = "request"): Promise<unknown> {
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/event-stream")) {
    return readSseReply(res, label);
  }
  const text = await res.text();
  if (!text.trim()) {
    throw new Error(
      `mcp: ${label} returned an empty body (content-type ${contentType || "none"}).`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(
      `mcp: ${label} returned non-JSON (content-type ${contentType || "none"}): ${text.slice(0, 200)}`,
    );
  }
  return unwrapReply(payload, label);
}

/**
 * The 2025-06-18 handshake:
 *   initialize (advertise the floor) → adopt `result.protocolVersion` →
 *   capture `Mcp-Session-Id` → `notifications/initialized` (202 + EMPTY body,
 *   never parsed).
 */
async function handshake(session: McpSession, taskId: string): Promise<void> {
  // A handshake ALWAYS advertises the floor — the negotiated version from a
  // previous handshake must not leak into a fresh initialize (a re-init after
  // a 404 is a fresh negotiation).
  session.protocolVersion = MCP_PROTOCOL_FLOOR;

  const res = await post(session, {
    jsonrpc: "2.0",
    id: session.nextId++,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_FLOOR,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    },
  });
  captureSession(session, res);

  if (!res.ok) {
    const text = await safeBodyText(res);
    throw new Error(
      `mcp: initialize rejected (${res.status}) — the server refused protocol version ` +
        `"${MCP_PROTOCOL_FLOOR}" (the adapter's advertised floor). ` +
        `Server said: ${text}`,
    );
  }

  const result = (await readMcpReply(res, "initialize")) as
    | { protocolVersion?: unknown; serverInfo?: { name?: unknown } }
    | null;
  const negotiated =
    result && typeof result.protocolVersion === "string" && result.protocolVersion.trim()
      ? result.protocolVersion.trim()
      : MCP_PROTOCOL_FLOOR;
  session.protocolVersion = negotiated;
  const serverName =
    result?.serverInfo && typeof result.serverInfo.name === "string"
      ? result.serverInfo.name
      : "unknown";

  appendJobLog(
    taskId,
    "submit",
    `[mcp] initialize ok · ${serverName} · protocol ${negotiated} · ` +
      `session ${session.sessionId ? "issued" : "none"}`,
  );

  // notifications/initialized: 202 + EMPTY body. The body is DELIBERATELY not
  // read/parsed — a server may answer with a non-JSON marker and that must
  // never be mistaken for a reply.
  const notify = await post(session, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  captureSession(session, notify);
  if (notify.status < 200 || notify.status >= 300) {
    const text = await safeBodyText(notify);
    throw new Error(`mcp: notifications/initialized was rejected (${notify.status}): ${text}`);
  }
}

/**
 * POST a post-handshake request and read its reply.
 *
 * A 404 means the server no longer knows the session (or the tool) ⇒
 * re-initialize EXACTLY ONCE and retry once. Any other non-2xx is an HTTP
 * failure (never retried: the request reached the server).
 */
async function rpcCall(
  session: McpSession,
  message: McpMessage,
  taskId: string,
): Promise<unknown> {
  let res = await post(session, message);
  captureSession(session, res);

  if (res.status === 404) {
    if (session.reinitialized) {
      throw new Error(
        `mcp: ${message.method} still answers 404 after a single re-initialize — ` +
          `the session or the tool is gone (no further retry).`,
      );
    }
    session.reinitialized = true;
    session.sessionId = null;
    appendJobLog(
      taskId,
      "retry",
      `[mcp] 404 on ${message.method} — re-initializing the session once`,
    );
    await handshake(session, taskId);
    res = await post(session, message);
    captureSession(session, res);
    if (res.status === 404) {
      throw new Error(
        `mcp: ${message.method} still answers 404 after a single re-initialize — ` +
          `the session or the tool is gone (no further retry).`,
      );
    }
  }

  if (!res.ok) {
    const text = await safeBodyText(res);
    throw new Error(`mcp: ${message.method} failed (${res.status}): ${text}`);
  }
  return readMcpReply(res, message.method);
}

// ── Tool-result parsing (the four-case defensive contract) ──────────────────

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

/** A URL candidate out of free text (Python-repr blobs included). */
const RESULT_URL_RE = /https?:\/\/[^\s"'<>\\]+/gi;

/** Candidate URLs in a text blob, with trailing prose punctuation trimmed. */
function urlsInText(text: string): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(RESULT_URL_RE)) {
    const candidate = match[0].replace(/[),.;\]}]+$/, "");
    if (candidate) urls.push(candidate);
  }
  return urls;
}

/**
 * ORIGIN PIN — a URL recovered from a tool result may only ever point at the
 * configured server origin (http(s), no userinfo, same origin). Anything else
 * is a LOUD, distinct error: the settle funnel would fetch a `mediaUrl`
 * headerless and follow redirects, and an in-adapter fetch would carry the
 * bearer token — neither may reach a host we did not pin.
 */
function pinResultUrl(candidate: string, origin: string): string {
  if (sameOriginSafe(candidate, origin)) return candidate;
  let reason = "foreign-origin";
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      reason = "non-http(s)";
    } else if (parsed.username || parsed.password) {
      reason = "userinfo-carrying";
    }
  } catch {
    reason = "unparseable";
  }
  throw new Error(
    `mcp: the tool result carries a ${reason} URL (${candidate} != ${origin}). ` +
      `No request was made — a result URL may only point at the configured MCP server origin.`,
  );
}

/** The `resource` / `resource_link` URI of one content item (if any). */
function resourceUriOf(item: ContentItem): string | null {
  if (item.type === "resource") {
    const resource = item.resource as ContentItem | undefined;
    if (resource && typeof resource.uri === "string" && resource.uri.trim()) {
      return resource.uri.trim();
    }
  }
  if (item.type === "resource_link" && typeof item.uri === "string" && item.uri.trim()) {
    return item.uri.trim();
  }
  return null;
}

/** The text payload of one content item (if any). */
function textOf(item: ContentItem): string | null {
  return item.type === "text" && typeof item.text === "string" ? item.text : null;
}

/** Decode one base64 image item, bounded by the 64 MB ceiling. */
function imageBytesOf(item: ContentItem, index: number): RawBuffer {
  const data = item.data;
  if (typeof data !== "string" || !data.trim()) {
    throw new Error(`mcp: image content[${index}] carries no base64 data.`);
  }
  // A declared size is checked BEFORE allocation; the actual byteLength is
  // checked again after decoding (a server can lie).
  const declared =
    typeof item.size === "number"
      ? item.size
      : typeof item.byteLength === "number"
        ? item.byteLength
        : 0;
  if (declared > MAX_MCP_BUFFER_BYTES) {
    throw new Error(
      `mcp: the tool result's image content declares ${declared} bytes, over the ` +
        `${MAX_MCP_BUFFER_BYTES / 1024 / 1024} MB buffer ceiling — v1 settles bounded base64 buffers.`,
    );
  }
  // base64 length → byte estimate (no allocation yet).
  if (Math.floor((data.length * 3) / 4) > MAX_MCP_BUFFER_BYTES) {
    throw new Error(
      `mcp: the tool result's image content exceeds the ` +
        `${MAX_MCP_BUFFER_BYTES / 1024 / 1024} MB buffer ceiling — v1 settles bounded base64 buffers.`,
    );
  }
  const buffer = Buffer.from(data, "base64");
  if (buffer.byteLength > MAX_MCP_BUFFER_BYTES) {
    throw new Error(
      `mcp: the tool result's image content exceeds the ` +
        `${MAX_MCP_BUFFER_BYTES / 1024 / 1024} MB buffer ceiling — v1 settles bounded base64 buffers.`,
    );
  }
  const mimeType =
    typeof item.mimeType === "string" && item.mimeType.trim()
      ? item.mimeType.trim()
      : "image/png";
  return { buffer, mimeType };
}

/** The human message of an `isError:true` result. */
function toolErrorMessage(text: string): string {
  const message = text.trim() || "the tool returned isError without a message";
  return `mcp: tool error: ${message}`;
}

/**
 * Interpret one `tools/call` result (P7c brief's defensive order):
 * image → resource URI → text URL → isError → no-media.
 *
 * Pure (no network): exported so the offline smoke fixture can exercise the
 * exact parse the adapter uses. `origin` is the configured server origin; every
 * recovered URL is origin-pinned HERE, before it can reach `mediaUrls`.
 */
export function interpretToolResult(result: unknown, origin: string): McpToolOutcome {
  const record = (result ?? {}) as { content?: unknown; isError?: unknown };
  const content = Array.isArray(record.content) ? record.content : [];
  const items = content.filter(
    (item): item is ContentItem => !!item && typeof item === "object",
  );
  const contentTypes = items
    .map((item) => (typeof item.type === "string" && item.type.trim() ? item.type : "unknown"))
    .join(", ");

  // 1. image content[] → bounded buffers.
  const images = items.filter((item) => item.type === "image");
  if (images.length > 0) {
    return {
      outcome: "media",
      mediaUrls: [],
      rawBuffers: images.map((item, index) => imageBytesOf(item, index)),
    };
  }

  // 2. resource / resource_link URI → mediaUrls (origin-pinned).
  const resources = items
    .map((item) => resourceUriOf(item))
    .filter((uri): uri is string => !!uri);
  if (resources.length > 0) {
    return {
      outcome: "media",
      mediaUrls: resources.map((uri) => pinResultUrl(uri, origin)),
      rawBuffers: [],
    };
  }

  // 3. URL regex out of text content (Gradio's Python-repr blob). A foreign
  //    candidate is NEVER laundered: if no same-origin URL exists, the first
  //    candidate is reported as a loud, distinct error.
  const text = items
    .map((item) => textOf(item))
    .filter((value): value is string => value !== null)
    .join("\n");
  const candidates = urlsInText(text);
  if (candidates.length > 0) {
    for (const candidate of candidates) {
      if (sameOriginSafe(candidate, origin)) {
        return { outcome: "media", mediaUrls: [candidate], rawBuffers: [] };
      }
    }
    return { outcome: "media", mediaUrls: [pinResultUrl(candidates[0], origin)], rawBuffers: [] };
  }

  // 4. isError:true — a TOOL error carried by HTTP 200 (not a protocol error).
  if (record.isError === true) {
    return { outcome: "tool-error", message: toolErrorMessage(text) };
  }

  // 5. Nothing found — loud, never a silent empty success.
  return {
    outcome: "no-media",
    message: `mcp: no media in tool result (content types: ${contentTypes || "none"})`,
  };
}

// ── Upload (only reachable when a binding declares "remote-url") ─────────────

/** File extension for a MIME type ("bin" fallback). */
function extForMime(mime: string): string {
  const sub = mime.split("/")[1]?.split(";")[0]?.toLowerCase() ?? "";
  if (sub === "jpeg") return "jpg";
  for (const [ext, known] of Object.entries(MIME_BY_EXT)) {
    if (known === mime) return ext;
  }
  return "bin";
}

/** A node fetch / Blob-typing-safe copy of the bytes (Buffer is a pooled view). */
function toBodyBytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(buffer.byteLength);
  out.set(buffer);
  return out;
}

/**
 * The bytes of a staged local input: a data: URI, an http(s) URL, or a
 * `/generated/…` path under MEDIA_DIR (the openaiCompat/gradio shape).
 */
async function readLocalBytes(
  raw: string,
  mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
  if (raw.startsWith("data:")) {
    const match = /^data:([^;,]+)?((?:;[^;,]+)*),([\s\S]*)$/.exec(raw);
    if (!match) throw new Error("mcp upload: malformed data: URI");
    const mime = match[1] || mimeType || "application/octet-stream";
    const payload = match[3] ?? "";
    const buffer = /;base64/i.test(match[2] ?? "")
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    return { buffer, mimeType: mime, filename: `file.${extForMime(mime)}` };
  }

  if (/^https?:\/\//i.test(raw)) {
    const res = await pinnedFetch(raw, { timeoutMs: MCP_REQUEST_TIMEOUT_MS });
    if (!res.ok) {
      throw new Error(`mcp upload: source fetch failed (${res.status}): ${raw}`);
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

/** Pull the media URL out of an upload response (generic media-store shapes). */
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
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
  }
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (location && /^https?:\/\//i.test(location)) return location;
  throw new Error(`mcp upload: the response carried no media URL (${trimmed.slice(0, 200)})`);
}

/**
 * The key authenticating an upload: the binding's `mediaUpload.keyProviderId`
 * names ANOTHER provider's key (the cross-provider shape openaiCompat already
 * supports) — otherwise the MCP backend's own key applies.
 */
function resolveUploadKey(
  cfg: ProviderRuntimeConfig,
  binding: ModelProviderBinding | undefined,
): string | null {
  const spec = binding?.mediaUpload;
  const keyProviderId = spec?.keyProviderId;
  if (keyProviderId && keyProviderId !== cfg.providerId) {
    const other = getProviderRuntimeConfig(keyProviderId);
    if (other.apiKey && other.apiKey.trim()) return other.apiKey.trim();
    const envName = envFallbackKeyName(keyProviderId);
    const fromEnv = envName ? process.env[envName] : undefined;
    if (fromEnv && fromEnv.trim()) return fromEnv.trim();
    throw new Error(
      `mcp: the media-upload endpoint ${spec?.url} is authenticated with the ` +
        `"${keyProviderId}" key, but none is configured.`,
    );
  }
  return resolveToken(cfg, binding);
}

/** POST the bytes to the binding's own upload endpoint and return its URL. */
async function uploadToEndpoint(
  spec: CompatMediaUpload,
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
    for (const [key, value] of Object.entries(spec.fields ?? {})) form.append(key, value);
    body = form; // fetch sets the multipart boundary itself
  }

  const res = await pinnedFetch(spec.url, {
    method: "POST",
    headers,
    body,
    timeoutMs: MCP_REQUEST_TIMEOUT_MS,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`mcp upload failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return extractUploadUrl(text, res.headers.get("location"));
}

// ── Submit ──────────────────────────────────────────────────────────────────

async function submit(input: GenerateInput): Promise<SubmitOutcome> {
  // V1 IS IMAGES ONLY: an MCP video result needs the URL branch, not an
  // unbounded base64 buffer (plan §b P7c scope guard).
  if (input.kind === "video") {
    throw new Error(
      `mcp: video generation is not supported by the mcp family (v1 is images only). ` +
        `An MCP video result needs the URL branch — a same-origin file URL mirrored by the ` +
        `settle funnel byte-bounded — not an unbounded base64 buffer; route the model through ` +
        `an hf-gradio or openai-compat video binding instead.`,
    );
  }

  const cfg = input.credentials;
  const binding = input.binding;
  const baseUrl = resolveServerUrl(cfg, binding);
  if (!baseUrl) {
    throw new Error(
      `mcp: the "${binding.modelId}" binding carries no MCP server URL — ` +
        `set baseUrl (or the provider's base_url) to the server's streamable-HTTP endpoint.`,
    );
  }
  const validated = validateServerUrl(baseUrl);
  if (!validated.ok) {
    throw new Error(`mcp: the configured MCP server URL ${validated.reason}.`);
  }
  const tool = binding.upstreamModelId?.trim();
  if (!tool) {
    throw new Error(
      `mcp: the "${binding.modelId}" binding carries no tool name — ` +
        `set upstreamModelId to the MCP tool (tools/call.params.name).`,
    );
  }
  const argMap: McpArgMap | undefined = binding.argMap;
  if (!argMap) {
    throw new Error(
      `mcp: the "${binding.modelId}" binding declares no argMap — an MCP tools/call ` +
        `needs its NAMED argument map (tool = upstreamModelId).`,
    );
  }

  const origin = new URL(baseUrl).origin;
  const args = buildArguments(input, argMap);
  const session: McpSession = {
    baseUrl,
    origin,
    token: resolveToken(cfg, binding),
    protocolVersion: MCP_PROTOCOL_FLOOR,
    sessionId: null,
    reinitialized: false,
    nextId: 1,
  };

  appendJobLog(
    input.taskId,
    "submit",
    `[mcp] tools/call ${tool} @ ${urlHost(baseUrl) ?? "unknown"} · ` +
      `${Object.keys(args).length} arg(s) [${Object.keys(args).join(", ")}] · kind ${input.kind}`,
  );

  await handshake(session, input.taskId);

  const result = await rpcCall(
    session,
    {
      jsonrpc: "2.0",
      id: session.nextId++,
      method: "tools/call",
      params: { name: tool, arguments: args },
    },
    input.taskId,
  );

  const parsed = interpretToolResult(result, origin);
  if (parsed.outcome === "tool-error") {
    // The tool answered HTTP 200 with `isError:true` — a TOOL failure, not a
    // protocol error. `McpToolError` reaches the job manager's settled-error
    // channel (never a retry/protocol classification).
    throw new McpToolError(parsed.message);
  }
  if (parsed.outcome === "no-media") {
    throw new Error(parsed.message);
  }

  appendJobLog(
    input.taskId,
    "submit",
    `[mcp] tools/call ok · ${parsed.mediaUrls.length} url(s) · ${parsed.rawBuffers.length} buffer(s)`,
  );

  return {
    mode: "sync",
    mediaUrls: parsed.mediaUrls,
    rawBuffers: parsed.rawBuffers.length > 0 ? parsed.rawBuffers : undefined,
  };
}

// ── Provider object ─────────────────────────────────────────────────────────

export const mcpProvider: GenerationProvider = {
  id: "mcp",
  label: "MCP Server",

  /**
   * Backend ids this family adapter serves. Each backend keeps its OWN
   * provider id (its own `provider_configs` key/base URL and its own
   * `model_bindings` rows), exactly like the compat family's aliases.
   *
   * `mcp-server` is the generic id for a user-added server; the plan's
   * "aliases per server" (arbitrary user-created ids) rides P7a-0's
   * kind-keyed resolver — `aliases` are fixed at registration time, so this
   * adapter cannot enumerate user rows here.
   */
  aliases: ["mcp-server"],

  // MCP image tools overwhelmingly accept data URLs / public URLs as string
  // arguments. "remote-url" is opt-in per binding, and only when the binding
  // names its own upload endpoint (uploadMedia below).
  mediaStaging: "data-url",

  capabilities: {
    // ONE blocking tools/call → mode:"sync".
    syncSubmission: true,
    // No upstream task id exists — nothing to poll.
    polling: false,
    // uploadMedia() is implemented (reachable only under "remote-url").
    mediaUpload: true,
    mediaStaging: "data-url",
    // P7a-4: the server may be local (localhost:8080/mcp) or on the LAN, so a
    // binding may ask for private-host passthrough. A cloud MCP server loses
    // nothing: the AND in createStagingResolver keeps its own pinned rule.
    allowPrivateUrl: true,
    // V1 is images only; the video route refuses the request.
    video: false,
  },

  /**
   * Ready iff a parseable http(s) server URL resolves. The bearer token is
   * OPTIONAL (public servers answer unauthenticated) — its only effect is the
   * Authorization header. A binding without a tool name is not usable.
   */
  checkReadiness(
    cfg: ProviderRuntimeConfig,
    binding?: ModelProviderBinding,
  ): { ready: boolean; reason?: string } {
    const raw = resolveServerUrl(cfg, binding);
    if (!raw) {
      return {
        ready: false,
        reason:
          "No MCP server URL configured for this backend. Add one in Settings " +
          "(the server's streamable-HTTP endpoint, e.g. https://host/mcp).",
      };
    }
    const validated = validateServerUrl(raw);
    if (!validated.ok) {
      return { ready: false, reason: `The MCP server URL ${validated.reason}.` };
    }
    if (binding && (!binding.upstreamModelId || !binding.upstreamModelId.trim())) {
      return {
        ready: false,
        reason:
          `The "${binding.modelId}" binding carries no tool name — ` +
          `set upstreamModelId to the MCP tool to call.`,
      };
    }
    return { ready: true };
  },

  submit(input: GenerateInput): Promise<SubmitOutcome> {
    return submit(input);
  },

  /**
   * Upload one staged media item to the binding's OWN media endpoint (the
   * optional "remote-url" path). A binding that declares "remote-url" WITHOUT
   * an endpoint fails loudly — the openrouter-video rule: no upload endpoint
   * documented ⇒ a local file fails loudly (never a silent data-url fallback,
   * never a dropped reference).
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
        `mcp: the "${binding?.providerId ?? "unknown"}" backend stages media as ` +
          `"remote-url" but no upload endpoint is documented for this MCP server ` +
          `(mediaUpload.url missing) — a local file fails loudly. Use "data-url" staging ` +
          `or configure the server's own upload path.`,
      );
    }
    const apiKey = resolveUploadKey(cfg, binding);
    const bytes = await readLocalBytes(localPathOrDataUrl, mimeType);
    return uploadToEndpoint(spec, bytes, apiKey);
  },
};

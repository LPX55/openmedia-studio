#!/usr/bin/env node
/**
 * smoke-mcp — PERMANENT offline smoke fixture for the `mcp` provider family
 * (P7 plan rev-2 step 4; §b P7c / §e validation).
 *
 * WHAT IT CHECKS (fully offline — no network, no API key, no build step):
 *
 * The shared harness (assertions, Response-alike streaming + mid-frame splits,
 * SSE replay, signal-aware fetch stub) lives in ./smoke-lib.mjs; this fixture
 * keeps only the family-specific coverage and fixtures.
 *
 *   1. REGISTRY — the bootstrap boots, the "mcp" adapter is registered, and
 *      the generic "mcp-server" alias is an id-overridden view (each backend
 *      keeps its own provider id).
 *   2. HANDSHAKE — initialize advertises 2025-06-18 as the floor, the server's
 *      NEWER `result.protocolVersion` is adopted for all later requests,
 *      `notifications/initialized` answers 202 + a non-JSON body that is never
 *      parsed, `Mcp-Session-Id` is captured and replayed, and every request
 *      carries MCP-Protocol-Version + Mcp-Method (+ Mcp-Name on tools/call),
 *      Accept both content types, `redirect:"error"` and a bounded signal.
 *   3. SESSION 404 — a 404 after the handshake re-initializes EXACTLY ONCE and
 *      retries once; the fresh handshake advertises the floor again.
 *   4. RESULT PARSE — image base64 → bounded buffer (declared over-64 MB →
 *      loud), resource / resource_link URI → mediaUrls, Python-repr text blob
 *      → URL extracted, isError:true → tool error (HTTP 200, not a protocol
 *      error), nothing → loud "no media in tool result (content types: …)".
 *   5. ORIGIN PIN — a foreign-origin result URL is a loud, distinct error and
 *      NO request is made to that host.
 *   6. STREAM EDGES — heartbeat-only and EOF-without-complete are loud, never
 *      a silent success; a mid-frame chunk split reassembles.
 *   7. V1 SCOPE — kind "video" is refused with the URL-branch requirement.
 *   8. READINESS / STAGING / UPLOAD — base URL required + parseable, token
 *      optional, staging "data-url", and a "remote-url" binding without an
 *      upload endpoint fails with the documented wording.
 *   9. FIXTURES — the committed deepwiki captures (byte-exact spike bodies)
 *      replay through the adapter's reader: initialize, tools/list, and the
 *      REAL tools/call capture.
 *
 * Requirements: Node >= 22.18 (native TypeScript type-stripping — the repo has
 * no tsx/esbuild and this script adds no dependency). Same resolve-hook /
 * scratch-dir preamble as smoke-compat.mjs / smoke-gradio.mjs.
 *
 * Exit code: 0 = every assertion passed, 1 = at least one failed (each failure
 * is printed with a "✗" prefix).
 */
import { register } from "node:module";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  HARNESS_VERSION,
  eq,
  fakeResponse,
  failures,
  installFetchStub,
  ok,
  passed,
  section,
  sseEofNoComplete,
  sseFrames,
  sseHeartbeatOnly,
} from "./smoke-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Node prints a MODULE_TYPELESS_PACKAGE_JSON warning for every .ts file (the
// repo has no "type": "module"). Re-exec ONCE with that warning disabled so
// the fixture's output stays readable — the child's exit code is ours.
if (!process.execArgv.some((a) => a.startsWith("--disable-warning"))) {
  try {
    const { spawnSync } = await import("node:child_process");
    const child = spawnSync(
      process.execPath,
      [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        ...process.execArgv,
        fileURLToPath(import.meta.url),
        ...process.argv.slice(2),
      ],
      { stdio: "inherit" },
    );
    if (typeof child.status === "number") process.exit(child.status);
  } catch {
    /* fall through — the warning is cosmetic */
  }
}

// ── TS resolution hook ───────────────────────────────────────────────────────
// The repo's TypeScript uses extensionless relative imports (Next/bundler
// resolution) plus the "@/…" path alias; Node's ESM resolver needs both. A
// resolve hook (registered through node:module) bridges both — the SAME hook
// smoke-compat.mjs / smoke-gradio.mjs install.
const RESOLVE_HOOK = `
export async function resolve(specifier, context, nextResolve) {
  let spec = specifier;
  if (spec.startsWith("@/")) spec = ${JSON.stringify(ROOT)} + "/" + spec.slice(2);
  try {
    return await nextResolve(spec, context);
  } catch (err) {
    const candidates = (spec.startsWith(".") || spec.startsWith("/"))
      ? [spec + ".ts", spec + "/index.ts", spec + ".tsx"]
      : [spec + ".js"];
    for (const candidate of candidates) {
      try { return await nextResolve(candidate, context); } catch { /* next candidate */ }
    }
    throw err;
  }
}`;
register("data:text/javascript," + encodeURIComponent(RESOLVE_HOOK));

// The repo has no "type": "module" → Node warns about every .ts file. Silence
// just that warning (keep the others).
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w?.name === "MODULE_TYPELESS_PACKAGE_JSON") return;
  console.warn(`⚠ ${w?.name ?? "Warning"}: ${w?.message ?? String(w)}`);
});

// ── Isolated scratch dirs (inside the repo, gitignored, removed at the end) ──
const SMOKE_DIR = join(ROOT, "public", "generated", ".smoke-mcp");
// MUST be set before the repo modules are imported — lib/guest/paths.ts reads
// the env at import time.
process.env.HELIOS_MEDIA_DIR = SMOKE_DIR;
process.env.HELIOS_DATA_DIR = join(SMOKE_DIR, "data");

// ── Fixtures ─────────────────────────────────────────────────────────────────
const FIXTURES = join(ROOT, "docs", "fixtures", "phase7");
const INITIALIZE_FIXTURE = join(FIXTURES, "generic-mcp-initialize.txt");
const TOOLS_LIST_FIXTURE = join(FIXTURES, "generic-mcp-tools-list.txt");
const TOOLS_CALL_FIXTURE = join(FIXTURES, "deepwiki-tools-call.txt");

// ── Stubbed fetch (shared call log, signal-aware) ────────────────────────────
let stubbedResponse = () => fakeMcp({}, { status: 500, ok: false });
const { calls: capturedCalls, restore: restoreFetch } = installFetchStub(
  (url, init) => stubbedResponse(url, init),
);

const SERVER_URL = "https://mcp.example.com/mcp";
const SERVER_ORIGIN = "https://mcp.example.com";
const IMAGE_BYTES = Buffer.from("smoke-mcp-image-bytes");
const IMAGE_B64 = IMAGE_BYTES.toString("base64");

// ── Fixture / response helpers ───────────────────────────────────────────────

/**
 * The committed captures start with a header line (`HTTP 200 ct=… session=…`),
 * a blank line, then the raw SSE body — byte-exact, CRLF-framed. Strip the
 * header and feed the body to the adapter's reader (which normalises CRLF).
 */
function fixtureBody(raw) {
  const split = raw.indexOf("\n\n");
  if (split < 0) throw new Error("fixture has no header separator");
  return raw.slice(split + 2);
}

/** An SSE response carrying one JSON-RPC reply envelope. */
function sseResult(result, id = 1, opts = {}) {
  return strictResponse(
    sseFrames([{ event: "message", data: { jsonrpc: "2.0", id, result } }], opts),
  );
}

/**
 * The harness's `fakeResponse` answers "application/json" for ANY unknown
 * header (a legacy fallback). Real `Headers` return null for an absent header,
 * and the MCP session capture reads an OPTIONAL header — so absent must mean
 * absent here.
 */
function strictResponse(response) {
  const original = response.headers.get.bind(response.headers);
  response.headers.get = (name) => {
    const key = String(name).toLowerCase();
    if (key === "content-type" || key === "content-length" || key === "location") {
      return original(name);
    }
    return null;
  };
  return response;
}

/** `fakeResponse` with real-Headers absent-header semantics. */
function fakeMcp(payload, opts = {}) {
  return strictResponse(fakeResponse(payload, opts));
}

/** Overlay response headers on a fakeResponse (the harness has no header knob). */
function withHeaders(response, extra) {
  const original = response.headers.get.bind(response.headers);
  response.headers.get = (name) => {
    const key = String(name).toLowerCase();
    for (const [nameKey, value] of Object.entries(extra)) {
      if (nameKey.toLowerCase() === key) return value;
    }
    return original(name);
  };
  return response;
}

/** The parsed JSON-RPC body of one captured call (null for non-JSON). */
function messageOf(call) {
  try {
    return JSON.parse(call.init.body);
  } catch {
    return null;
  }
}

/** The captured calls of one JSON-RPC method. */
function callsOf(method) {
  return capturedCalls.filter((call) => messageOf(call)?.method === method);
}

/** Await a promise, returning the rejection (or null when it resolves). */
async function rejectionOf(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

async function main() {
  await mkdir(SMOKE_DIR, { recursive: true });

  // ── Imports (repo modules, loaded through the resolve hook) ───────────────
  const bootstrap = await import(pathToFileURL(join(ROOT, "lib/providers/bootstrap.ts")).href);
  const registryMod = await import(pathToFileURL(join(ROOT, "lib/providers/registry.ts")).href);
  const adaptersMod = await import(pathToFileURL(join(ROOT, "lib/providers/adapters/mcp.ts")).href);

  const { get } = registryMod;
  const {
    mcpProvider,
    interpretToolResult,
    readMcpReply,
    McpToolError,
    MCP_PROTOCOL_FLOOR,
    MCP_REQUEST_TIMEOUT_MS,
    MAX_MCP_BUFFER_BYTES,
  } = adaptersMod;

  ok(bootstrap !== undefined, "the provider bootstrap imports");
  ok(typeof HARNESS_VERSION === "string" && HARNESS_VERSION.length > 0, "the shared harness exposes its version");

  // ── 1. REGISTRY ─────────────────────────────────────────────────────────────
  section("registry — mcp + the generic mcp-server alias");
  const registered = get("mcp");
  ok(
    "the mcp adapter is registered by the bootstrap",
    !!registered && registered.id === "mcp" && registered === mcpProvider,
  );
  const aliasView = get("mcp-server");
  ok(
    "the mcp-server alias is registered as an id-overridden view (own provider id)",
    !!aliasView && aliasView.id === "mcp-server" && aliasView.submit === mcpProvider.submit,
  );
  eq(
    "capabilities: sync submission, no polling, upload hook, data-url staging, images only",
    [
      mcpProvider.capabilities?.syncSubmission,
      mcpProvider.capabilities?.polling,
      mcpProvider.capabilities?.mediaUpload,
      mcpProvider.capabilities?.mediaStaging,
      mcpProvider.capabilities?.video,
    ].join("/"),
    "true/false/true/data-url/false",
  );
  eq("the provider default staging is data-url", mcpProvider.mediaStaging, "data-url");
  eq("the advertised protocol floor is 2025-06-18", MCP_PROTOCOL_FLOOR, "2025-06-18");
  ok(
    "the blocking request timeout is bounded (finite, >0, <=60s)",
    Number.isFinite(MCP_REQUEST_TIMEOUT_MS) && MCP_REQUEST_TIMEOUT_MS > 0 && MCP_REQUEST_TIMEOUT_MS <= 60_000,
    String(MCP_REQUEST_TIMEOUT_MS),
  );

  // ── Shared binding / input ─────────────────────────────────────────────────
  const credentials = {
    providerId: "mcp",
    apiKey: "smoke-token",
    baseUrl: null,
    extra: {},
    keySource: "db",
  };
  const binding = {
    modelId: "smoke-mcp-model",
    providerId: "mcp",
    upstreamModelId: "generate_image",
    argMap: {
      sources: { prompt: "prompt", seed: "seed" },
      constants: { steps: 4 },
    },
  };
  const makeInput = (overrides = {}) => ({
    taskId: "smoke-mcp-task",
    kind: "image",
    model: { id: "smoke-mcp-model", apiId: "smoke-mcp-model", apiInput: {} },
    binding,
    prompt: "a lighthouse in a storm",
    params: { seed: 7 },
    media: {},
    credentials: { ...credentials, baseUrl: SERVER_URL },
    ...overrides,
  });

  // ── 2. HANDSHAKE + NEGOTIATION + SESSION ───────────────────────────────────
  section("handshake — floor advertised, newer version adopted, session replayed");
  stubbedResponse = (url, init) => {
    const message = JSON.parse(init.body);
    if (message.method === "initialize") {
      return withHeaders(
        sseResult({ protocolVersion: "2026-07-28", serverInfo: { name: "Smoke MCP" } }, message.id),
        { "mcp-session-id": "sess-42" },
      );
    }
    if (message.method === "notifications/initialized") {
      // A 202 whose body is NOT JSON: parsing it would throw.
      return fakeMcp("this is not json", { status: 202, contentType: "text/plain" });
    }
    if (message.method === "tools/call") {
      return sseResult(
        { content: [{ type: "image", data: IMAGE_B64, mimeType: "image/png" }] },
        message.id,
      );
    }
    return fakeMcp("unexpected method", { status: 500, ok: false, contentType: "text/plain" });
  };
  capturedCalls.length = 0;
  const outcome = await mcpProvider.submit(makeInput());

  eq(
    "the submit performs exactly initialize → notifications/initialized → tools/call",
    capturedCalls.map((call) => messageOf(call)?.method).join(","),
    "initialize,notifications/initialized,tools/call",
  );
  const initCall = callsOf("initialize")[0];
  const initMessage = messageOf(initCall);
  eq(
    "initialize advertises the 2025-06-18 floor",
    initMessage?.params?.protocolVersion,
    MCP_PROTOCOL_FLOOR,
  );
  eq(
    "initialize sends the client identity",
    initMessage?.params?.clientInfo?.name,
    "openmedia-studio",
  );
  eq(
    "initialize carries the floor in MCP-Protocol-Version",
    initCall?.init?.headers?.["MCP-Protocol-Version"],
    MCP_PROTOCOL_FLOOR,
  );
  ok(
    "every request lists BOTH accepted content types",
    capturedCalls.every(
      (call) => call.init?.headers?.Accept === "application/json, text/event-stream",
    ),
    JSON.stringify(capturedCalls.map((call) => call.init?.headers?.Accept)),
  );
  eq("initialize sends Mcp-Method", initCall?.init?.headers?.["Mcp-Method"], "initialize");
  ok(
    "the bearer token rides every request when configured",
    capturedCalls.every((call) => call.init?.headers?.Authorization === "Bearer smoke-token"),
    JSON.stringify(capturedCalls.map((call) => call.init?.headers?.Authorization)),
  );
  eq(
    "no session id is sent before one is issued",
    initCall?.init?.headers?.["Mcp-Session-Id"],
    undefined,
  );
  eq(
    "every request is redirect-refusing and signal-bounded (pinnedFetch contract)",
    capturedCalls.every(
      (call) => call.init?.redirect === "error" && typeof call.init?.signal === "object",
    ),
    true,
  );

  const notifyCall = callsOf("notifications/initialized")[0];
  eq(
    "notifications/initialized is a notification (no id) and the 202 body was NOT parsed",
    notifyCall ? "id" in messageOf(notifyCall) : "missing",
    false,
  );
  eq(
    "the negotiated NEWER version is adopted for later requests",
    notifyCall?.init?.headers?.["MCP-Protocol-Version"],
    "2026-07-28",
  );
  eq(
    "the notification sends Mcp-Method",
    notifyCall?.init?.headers?.["Mcp-Method"],
    "notifications/initialized",
  );
  eq(
    "Mcp-Session-Id is captured and replayed on the notification",
    notifyCall?.init?.headers?.["Mcp-Session-Id"],
    "sess-42",
  );

  const callCall = callsOf("tools/call")[0];
  const callMessage = messageOf(callCall);
  eq(
    "tools/call keeps the negotiated version + session",
    `${callCall?.init?.headers?.["MCP-Protocol-Version"]}/${callCall?.init?.headers?.["Mcp-Session-Id"]}`,
    "2026-07-28/sess-42",
  );
  eq("tools/call sends Mcp-Method", callCall?.init?.headers?.["Mcp-Method"], "tools/call");
  eq("tools/call sends Mcp-Name = the tool", callCall?.init?.headers?.["Mcp-Name"], "generate_image");
  eq("tools/call params.name is upstreamModelId", callMessage?.params?.name, "generate_image");
  eq(
    "the arguments object is constants + resolved sources",
    JSON.stringify(callMessage?.params?.arguments),
    JSON.stringify({ steps: 4, prompt: "a lighthouse in a storm", seed: 7 }),
  );
  eq("the outcome is sync", outcome.mode, "sync");
  eq("the image arrives as a raw buffer", outcome.rawBuffers?.[0]?.buffer.toString(), IMAGE_BYTES.toString());
  eq("the image MIME type is preserved", outcome.rawBuffers?.[0]?.mimeType, "image/png");
  eq("no URL is produced for base64 image content", JSON.stringify(outcome.mediaUrls), "[]");

  // A PUBLIC server (no token anywhere) must not receive an Authorization
  // header — the token is optional, not a family-wide default.
  stubbedResponse = (url, init) => {
    const message = JSON.parse(init.body);
    if (message.method === "initialize") {
      return sseResult({ protocolVersion: "2025-06-18", serverInfo: { name: "Public" } }, message.id);
    }
    if (message.method === "notifications/initialized") {
      return fakeMcp("", { status: 202, contentType: "text/plain" });
    }
    return sseResult({ content: [{ type: "image", data: IMAGE_B64, mimeType: "image/png" }] }, message.id);
  };
  capturedCalls.length = 0;
  await mcpProvider.submit(
    makeInput({
      credentials: { ...credentials, apiKey: null, keySource: "none", baseUrl: SERVER_URL },
    }),
  );
  ok(
    "a token-less public server receives NO Authorization header on any request",
    capturedCalls.length === 3 &&
      capturedCalls.every((call) => call.init?.headers?.Authorization === undefined),
    JSON.stringify(capturedCalls.map((call) => call.init?.headers?.Authorization)),
  );

  // The reader branches on the RESPONSE content-type: a plain JSON body (no
  // SSE framing) must parse on the same path.
  stubbedResponse = (url, init) => {
    const message = JSON.parse(init.body);
    if (message.method === "initialize") {
      return fakeMcp(
        {
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: "2025-06-18", serverInfo: { name: "JsonServer" } },
        },
        { contentType: "application/json" },
      );
    }
    if (message.method === "notifications/initialized") {
      return fakeMcp("", { status: 202, contentType: "text/plain" });
    }
    return fakeMcp(
      {
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "image", data: IMAGE_B64, mimeType: "image/png" }] },
      },
      { contentType: "application/json" },
    );
  };
  capturedCalls.length = 0;
  const jsonOutcome = await mcpProvider.submit(makeInput());
  eq(
    "an application/json response is parsed as JSON (the response content-type decides)",
    jsonOutcome.rawBuffers?.[0]?.buffer.toString(),
    IMAGE_BYTES.toString(),
  );
  eq("the JSON path performs the full handshake", capturedCalls.length, 3);

  // ── 3. 404 → EXACTLY ONE re-initialize ─────────────────────────────────────
  section("session 404 — exactly one re-initialize, then a loud stop");
  let initializeCount = 0;
  let toolsCallCount = 0;
  stubbedResponse = (url, init) => {
    const message = JSON.parse(init.body);
    if (message.method === "initialize") {
      initializeCount += 1;
      return sseResult({ protocolVersion: "2026-07-28", serverInfo: { name: "Flaky" } }, message.id);
    }
    if (message.method === "notifications/initialized") {
      return fakeMcp("", { status: 202, contentType: "text/plain" });
    }
    if (message.method === "tools/call") {
      toolsCallCount += 1;
      if (toolsCallCount === 1) {
        return fakeMcp("session expired", { status: 404, ok: false, contentType: "text/plain" });
      }
      return sseResult({ content: [{ type: "image", data: IMAGE_B64, mimeType: "image/png" }] }, message.id);
    }
    return fakeMcp("unexpected", { status: 500, ok: false });
  };
  capturedCalls.length = 0;
  const retried = await mcpProvider.submit(makeInput());
  eq("the 404 retry still settles synchronously", retried.mode, "sync");
  eq("the handshake runs twice (original + one re-initialize)", initializeCount, 2);
  eq("the notification is replayed after the re-initialize", callsOf("notifications/initialized").length, 2);
  eq("tools/call is retried exactly once", toolsCallCount, 2);
  eq(
    "the fresh handshake advertises the FLOOR again (not the prior negotiated version)",
    callsOf("initialize")[1]?.init?.headers?.["MCP-Protocol-Version"],
    MCP_PROTOCOL_FLOOR,
  );

  // A second 404 after the re-initialize is loud (never a loop).
  initializeCount = 0;
  toolsCallCount = 0;
  stubbedResponse = (url, init) => {
    const message = JSON.parse(init.body);
    if (message.method === "initialize") {
      initializeCount += 1;
      return sseResult({ protocolVersion: "2025-06-18" }, message.id);
    }
    if (message.method === "notifications/initialized") {
      return fakeMcp("", { status: 202, contentType: "text/plain" });
    }
    toolsCallCount += 1;
    return fakeMcp("still gone", { status: 404, ok: false, contentType: "text/plain" });
  };
  capturedCalls.length = 0;
  const double404 = await rejectionOf(mcpProvider.submit(makeInput()));
  ok(
    "a second 404 after the single re-initialize fails loudly without another handshake",
    !!double404 && initializeCount === 2 && toolsCallCount === 2 &&
      double404.message.includes("no further retry"),
    double404?.message,
  );

  // ── 4. RESULT PARSE — the defensive cases ──────────────────────────────────
  section("tool-result parse — image / resource / text URL / isError / nothing");
  const imageOutcome = interpretToolResult(
    { content: [{ type: "image", data: IMAGE_B64, mimeType: "image/png" }] },
    SERVER_ORIGIN,
  );
  eq("image content selects the media outcome", imageOutcome.outcome, "media");
  eq("image content decodes to the exact bytes", imageOutcome.rawBuffers?.[0]?.buffer.toString(), IMAGE_BYTES.toString());

  const oversized = await rejectionOf(
    Promise.resolve().then(() =>
      interpretToolResult(
        { content: [{ type: "image", data: IMAGE_B64, size: MAX_MCP_BUFFER_BYTES + 1 }] },
        SERVER_ORIGIN,
      ),
    ),
  );
  ok(
    "a declared image size over the 64 MB ceiling fails loudly before decoding",
    !!oversized && oversized.message.includes("64 MB") && oversized.message.includes("ceiling"),
    oversized?.message,
  );

  const resourceLink = interpretToolResult(
    {
      content: [
        {
          type: "resource_link",
          name: "out.png",
          uri: `${SERVER_ORIGIN}/gradio_api/file=/tmp/gradio/out.png`,
        },
      ],
    },
    SERVER_ORIGIN,
  );
  eq(
    "a resource_link URI becomes a media URL",
    resourceLink.outcome + ":" + (resourceLink.mediaUrls?.[0] ?? ""),
    `media:${SERVER_ORIGIN}/gradio_api/file=/tmp/gradio/out.png`,
  );

  const resource = interpretToolResult(
    { content: [{ type: "resource", resource: { uri: `${SERVER_ORIGIN}/files/out.png` } }] },
    SERVER_ORIGIN,
  );
  eq(
    "a resource URI becomes a media URL",
    resource.outcome + ":" + (resource.mediaUrls?.[0] ?? ""),
    `media:${SERVER_ORIGIN}/files/out.png`,
  );

  const pythonRepr = interpretToolResult(
    {
      content: [
        {
          type: "text",
          text:
            "Generated: {'path': '/tmp/gradio/abc.png', 'url': " +
            `'${SERVER_ORIGIN}/gradio_api/file=/tmp/gradio/abc.png'}`,
        },
      ],
    },
    SERVER_ORIGIN,
  );
  eq(
    "a Python-repr text blob yields its same-origin URL",
    pythonRepr.outcome + ":" + (pythonRepr.mediaUrls?.[0] ?? ""),
    `media:${SERVER_ORIGIN}/gradio_api/file=/tmp/gradio/abc.png`,
  );

  const toolError = interpretToolResult(
    { content: [{ type: "text", text: "Tool failed: repository not found" }], isError: true },
    SERVER_ORIGIN,
  );
  eq("isError:true selects the tool-error outcome (no throw)", toolError.outcome, "tool-error");
  ok(
    "the tool-error message carries the server's text",
    toolError.message?.includes("Tool failed: repository not found"),
    toolError.message,
  );

  const nothing = interpretToolResult({ content: [{ type: "text", text: "hello" }] }, SERVER_ORIGIN);
  eq("no media selects the loud no-media outcome", nothing.outcome, "no-media");
  eq(
    "the no-media message names the content types",
    nothing.message,
    "mcp: no media in tool result (content types: text)",
  );
  const emptyResult = interpretToolResult({ content: [] }, SERVER_ORIGIN);
  eq(
    "an empty result names 'none' as the content type",
    emptyResult.message,
    "mcp: no media in tool result (content types: none)",
  );

  // isError through submit: HTTP 200, a McpToolError (settled job error), NOT
  // a protocol/JSON-RPC throw.
  let toolStatus = 0;
  stubbedResponse = (url, init) => {
    const message = JSON.parse(init.body);
    if (message.method === "initialize") {
      return sseResult({ protocolVersion: "2025-06-18" }, message.id);
    }
    if (message.method === "notifications/initialized") {
      return fakeMcp("", { status: 202, contentType: "text/plain" });
    }
    toolStatus = 200;
    return sseResult(
      { content: [{ type: "text", text: "Tool failed: repository not found" }], isError: true },
      message.id,
    );
  };
  capturedCalls.length = 0;
  const isErrorSubmit = await rejectionOf(mcpProvider.submit(makeInput()));
  ok(
    "submit turns isError:true into a settled McpToolError (HTTP 200, not a protocol error)",
    isErrorSubmit instanceof McpToolError &&
      isErrorSubmit.name === "McpToolError" &&
      isErrorSubmit.message.includes("repository not found") &&
      !isErrorSubmit.message.includes("JSON-RPC"),
    `${isErrorSubmit?.name}: ${isErrorSubmit?.message}`,
  );
  eq("the tool result arrived with HTTP 200 (the protocol did not fail)", toolStatus, 200);

  // ── 5. ORIGIN PIN ──────────────────────────────────────────────────────────
  section("origin pin — a foreign result URL is loud and never fetched");
  const foreignUrl = "https://evil.example/steal.png";
  const foreign = await rejectionOf(
    Promise.resolve().then(() =>
      interpretToolResult(
        { content: [{ type: "text", text: `Result: ${foreignUrl}` }] },
        SERVER_ORIGIN,
      ),
    ),
  );
  ok(
    "a foreign-origin URL is a distinct loud error naming both origins",
    !!foreign && foreign.message.includes("foreign-origin") &&
      foreign.message.includes(foreignUrl) && foreign.message.includes(SERVER_ORIGIN),
    foreign?.message,
  );

  stubbedResponse = (url, init) => {
    const message = JSON.parse(init.body);
    if (message.method === "initialize") {
      return sseResult({ protocolVersion: "2025-06-18" }, message.id);
    }
    if (message.method === "notifications/initialized") {
      return fakeMcp("", { status: 202, contentType: "text/plain" });
    }
    return sseResult(
      { content: [{ type: "text", text: `Result: ${foreignUrl}` }] },
      message.id,
    );
  };
  capturedCalls.length = 0;
  const foreignSubmit = await rejectionOf(mcpProvider.submit(makeInput()));
  ok(
    "submit refuses the foreign URL",
    !!foreignSubmit && foreignSubmit.message.includes("foreign-origin"),
    foreignSubmit?.message,
  );
  ok(
    "NO request is ever made to the foreign host",
    capturedCalls.every((call) => !call.url.includes("evil.example")),
    JSON.stringify(capturedCalls.map((call) => call.url)),
  );

  // ── 6. STREAM EDGES ────────────────────────────────────────────────────────
  section("stream edges — heartbeats / EOF are loud; mid-frame splits reassemble");
  const heartbeatReply = await rejectionOf(readMcpReply(sseHeartbeatOnly(), "tools/call"));
  ok(
    "a heartbeat-only stream is not a completion",
    !!heartbeatReply && heartbeatReply.message.includes("without a JSON-RPC response"),
    heartbeatReply?.message,
  );
  const eofReply = await rejectionOf(readMcpReply(sseEofNoComplete(), "tools/call"));
  ok(
    "an EOF without a reply is not a silent success",
    !!eofReply && eofReply.message.includes("without a JSON-RPC response"),
    eofReply?.message,
  );

  stubbedResponse = (url, init) => {
    const message = JSON.parse(init.body);
    if (message.method === "initialize") {
      return sseResult({ protocolVersion: "2025-06-18" }, message.id);
    }
    if (message.method === "notifications/initialized") {
      return fakeMcp("", { status: 202, contentType: "text/plain" });
    }
    return sseHeartbeatOnly();
  };
  capturedCalls.length = 0;
  const heartbeatSubmit = await rejectionOf(mcpProvider.submit(makeInput()));
  ok(
    "a heartbeat-only tools/call rejects instead of settling a silent success",
    !!heartbeatSubmit && heartbeatSubmit.message.includes("without a JSON-RPC response"),
    heartbeatSubmit?.message,
  );

  stubbedResponse = (url, init) => {
    const message = JSON.parse(init.body);
    if (message.method === "initialize") {
      return sseResult({ protocolVersion: "2025-06-18" }, message.id);
    }
    if (message.method === "notifications/initialized") {
      return fakeMcp("", { status: 202, contentType: "text/plain" });
    }
    return sseEofNoComplete();
  };
  capturedCalls.length = 0;
  const eofSubmit = await rejectionOf(mcpProvider.submit(makeInput()));
  ok(
    "an EOF-without-complete tools/call rejects instead of settling a silent success",
    !!eofSubmit && eofSubmit.message.includes("without a JSON-RPC response"),
    eofSubmit?.message,
  );

  stubbedResponse = (url, init) => {
    const message = JSON.parse(init.body);
    if (message.method === "initialize") {
      return sseResult({ protocolVersion: "2025-06-18" }, message.id);
    }
    if (message.method === "notifications/initialized") {
      return fakeMcp("", { status: 202, contentType: "text/plain" });
    }
    return sseResult(
      { content: [{ type: "image", data: IMAGE_B64, mimeType: "image/png" }] },
      message.id,
      { splitEveryNBytes: 5 },
    );
  };
  capturedCalls.length = 0;
  const split = await mcpProvider.submit(makeInput());
  eq(
    "a response split mid-frame (every 5 bytes) reassembles to the exact bytes",
    split.rawBuffers?.[0]?.buffer.toString(),
    IMAGE_BYTES.toString(),
  );

  // ── 7. V1 SCOPE — video refused ────────────────────────────────────────────
  section("v1 scope — video is refused with the URL-branch requirement");
  capturedCalls.length = 0;
  const videoRefusal = await rejectionOf(mcpProvider.submit(makeInput({ kind: "video" })));
  ok(
    "kind video is refused loudly and names the URL branch",
    !!videoRefusal && videoRefusal.message.includes("video") &&
      videoRefusal.message.includes("URL branch"),
    videoRefusal?.message,
  );
  eq("the refusal happens before any request", capturedCalls.length, 0);

  // ── 8. VERSION-MISMATCH 400 ────────────────────────────────────────────────
  section("version mismatch — a 400 is a loud negotiation failure");
  stubbedResponse = () =>
    fakeMcp("Supported versions: 2024-11-05, 2025-03-26, 2025-06-18", {
      status: 400,
      ok: false,
      contentType: "text/plain",
    });
  capturedCalls.length = 0;
  const mismatch = await rejectionOf(mcpProvider.submit(makeInput()));
  ok(
    "a 400 initialize fails loudly with the status, floor and server's list",
    !!mismatch && mismatch.message.includes("400") &&
      mismatch.message.includes(MCP_PROTOCOL_FLOOR) &&
      mismatch.message.includes("Supported versions"),
    mismatch?.message,
  );
  eq("no notification is sent after a rejected initialize", capturedCalls.length, 1);

  // ── 9. READINESS / STAGING / UPLOAD ────────────────────────────────────────
  section("readiness — base URL required + parseable, token optional");
  const noBase = mcpProvider.checkReadiness(
    { ...credentials, baseUrl: null },
    { ...binding, baseUrl: undefined },
  );
  eq("no baseUrl ⇒ not ready", noBase.ready, false);
  ok(
    "the readiness reason names the missing server URL",
    typeof noBase.reason === "string" && noBase.reason.includes("server URL"),
    noBase.reason,
  );
  const ftpBase = mcpProvider.checkReadiness({ ...credentials, baseUrl: "ftp://mcp.example.com/mcp" }, binding);
  eq("a non-http(s) baseUrl ⇒ not ready", ftpBase.ready, false);
  ok(
    "the readiness reason names the http(s) requirement",
    typeof ftpBase.reason === "string" && ftpBase.reason.includes("http(s)"),
    ftpBase.reason,
  );
  const badBase = mcpProvider.checkReadiness({ ...credentials, baseUrl: "not a url" }, binding);
  eq("an unparseable baseUrl ⇒ not ready", badBase.ready, false);
  ok(
    "the readiness reason names the absolute-URL requirement",
    typeof badBase.reason === "string" && badBase.reason.includes("absolute URL"),
    badBase.reason,
  );
  const userinfoBase = mcpProvider.checkReadiness(
    { ...credentials, baseUrl: "https://user:pass@mcp.example.com/mcp" },
    binding,
  );
  eq("a userinfo-carrying baseUrl ⇒ not ready", userinfoBase.ready, false);
  const publicReady = mcpProvider.checkReadiness(
    { ...credentials, apiKey: null, keySource: "none", baseUrl: SERVER_URL },
    binding,
  );
  eq("a public server with NO token is ready", publicReady.ready, true);
  const noTool = mcpProvider.checkReadiness(
    { ...credentials, baseUrl: SERVER_URL },
    { ...binding, upstreamModelId: "" },
  );
  eq("a binding without a tool name ⇒ not ready", noTool.ready, false);
  ok(
    "the readiness reason names the tool name",
    typeof noTool.reason === "string" && noTool.reason.includes("tool name"),
    noTool.reason,
  );

  section("upload — remote-url requires the binding's own endpoint");
  const noUpload = await rejectionOf(
    mcpProvider.uploadMedia("data:image/png;base64," + IMAGE_B64, "image/png", credentials, binding),
  );
  ok(
    "a remote-url binding without an upload endpoint fails with the documented wording",
    !!noUpload && noUpload.message.includes("no upload endpoint is documented") &&
      noUpload.message.includes("fails loudly"),
    noUpload?.message,
  );

  stubbedResponse = () => fakeMcp({ url: "https://upload.example/out.png" });
  capturedCalls.length = 0;
  const uploadedUrl = await mcpProvider.uploadMedia(
    "data:image/png;base64," + IMAGE_B64,
    "image/png",
    credentials,
    { ...binding, mediaUpload: { url: "https://upload.example/files" } },
  );
  eq("the upload returns the media store's URL", uploadedUrl, "https://upload.example/out.png");
  eq(
    "the upload posts the bytes as multipart field 'file'",
    capturedCalls[0]?.init?.body?.get?.("file")?.size,
    IMAGE_BYTES.length,
  );
  eq(
    "the upload carries the backend token and refuses redirects",
    `${capturedCalls[0]?.init?.headers?.Authorization}/${capturedCalls[0]?.init?.redirect}`,
    "Bearer smoke-token/error",
  );

  // ── 10. FIXTURES (byte-exact real captures) ────────────────────────────────
  section("fixtures — the real deepwiki captures replay through the adapter reader");
  const initRaw = await readFile(INITIALIZE_FIXTURE, "utf8");
  const initBody = fixtureBody(initRaw);
  ok(
    "the initialize capture is CRLF-framed SSE (the reader normalises it)",
    initBody.startsWith("event: message\r\ndata: "),
    initBody.slice(0, 40),
  );
  const initReply = await readMcpReply(
    fakeMcp(initBody, { contentType: "text/event-stream" }),
    "initialize",
  );
  eq("the captured initialize negotiates 2025-06-18", initReply?.protocolVersion, "2025-06-18");
  eq("the captured initialize names the server", initReply?.serverInfo?.name, "DeepWiki");

  const listRaw = await readFile(TOOLS_LIST_FIXTURE, "utf8");
  const listReply = await readMcpReply(
    fakeMcp(fixtureBody(listRaw), { contentType: "text/event-stream" }),
    "tools/list",
  );
  eq("the captured tools/list carries three tools", listReply?.tools?.length, 3);
  eq(
    "the captured tools/list names are the wire names (never reconstructed)",
    listReply?.tools?.map((tool) => tool.name).join(","),
    "ask_wiki_question,read_wiki_contents,read_wiki_structure",
  );
  eq(
    "the captured tools/list inputSchema is standard JSON Schema",
    listReply?.tools?.[0]?.inputSchema?.type,
    "object",
  );
  eq(
    "the captured ask_wiki_question schema requires repoName + question",
    listReply?.tools?.[0]?.inputSchema?.required?.join(","),
    "repoName,question",
  );

  const callRaw = await readFile(TOOLS_CALL_FIXTURE, "utf8");
  const callReply = await readMcpReply(
    fakeMcp(fixtureBody(callRaw), { contentType: "text/event-stream" }),
    "tools/call",
  );
  eq("the REAL tools/call capture is a text-only success", callReply?.isError, false);
  eq("the REAL tools/call capture carries text content", callReply?.content?.[0]?.type, "text");
  const callInterpretation = interpretToolResult(callReply, "https://mcp.deepwiki.com");
  ok(
    "the REAL tools/call capture settles loudly as no-media (content types: text)",
    callInterpretation.outcome === "no-media" &&
      callInterpretation.message.includes("no media in tool result (content types: text)"),
    JSON.stringify(callInterpretation),
  );
}

try {
  await main();
} catch (err) {
  failures.push(`fixture crashed: ${err?.stack ?? err?.message ?? String(err)}`);
} finally {
  restoreFetch();
  await rm(SMOKE_DIR, { recursive: true, force: true });
}

console.log("");
if (failures.length) {
  console.log(`✗ ${failures.length} assertion(s) failed (${passed} passed):`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ smoke-mcp: ${passed} assertions passed.`);
process.exit(0);

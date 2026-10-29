#!/usr/bin/env node
/**
 * smoke-gradio — PERMANENT offline smoke fixture for the `hf-gradio` provider
 * family (P7 plan rev-2 step 3; §b P7b / §e validation).
 *
 * WHAT IT CHECKS (fully offline — no network, no API key, no build step):
 *
 * The shared harness (assertions, Response-alike streaming + mid-frame splits,
 * SSE replay, signal-aware fetch stub) lives in ./smoke-lib.mjs; this fixture
 * keeps only the family-specific coverage and fixtures.
 *
 *   1. REGISTRY — the bootstrap boots and the "hf-gradio" adapter is
 *      registered; its code-seeded bindings resolve for both Space models.
 *   2. ARGMAP vs RECORDED SIGNATURE — the committed /gradio_api/info fixture
 *      (byte-exact spike capture) pins the positional order the argMap maps.
 *   3. SUBMIT — `POST /gradio_api/call/{fn}` with the exact positional data[],
 *      the fn channel, the Authorization header (token) and the async outcome
 *      (event_id → providerMeta.statusUrl); the no-token variant sends NO
 *      Authorization; a missing base URL fails LOUDLY.
 *   4. UPLOAD — `POST /gradio_api/upload` (multipart field "files") returns
 *      the Space's uploaded path (the data[] FileData source).
 *   5. POLL — the SSE "invisible response": complete → the public URL path
 *      (no token) vs the private BUFFERS path (token present — mediaUrls stays
 *      EMPTY, the settle funnel is never asked to mirror a private URL);
 *      generating / heartbeat-only / EOF-without-complete → pending;
 *      mid-frame chunk splits reassemble; error frames settle error.
 *   6. TIMEOUTS — the per-tick read budget sits in [20s, 30s] and a mid-stream
 *      abort rejects with AbortError (the transient the job loop retries).
 *
 * Requirements: Node >= 22.18 (native TypeScript type-stripping — the repo has
 * no tsx/esbuild and this script adds no dependency). Same resolve-hook /
 * scratch-dir preamble as smoke-compat.mjs.
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
// smoke-compat.mjs installs (P7a-0 pins this fixture as the resolve hook's
// permanent consumer, plan §a).
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
const SMOKE_DIR = join(ROOT, "public", "generated", ".smoke-gradio");
// MUST be set before the repo modules are imported — lib/guest/paths.ts reads
// the env at import time.
process.env.HELIOS_MEDIA_DIR = SMOKE_DIR;
process.env.HELIOS_DATA_DIR = join(SMOKE_DIR, "data");

// ── Fixtures ─────────────────────────────────────────────────────────────────
// The committed /gradio_api/info captures (byte-exact spike bodies) are the
// SOURCE OF TRUTH for the positional data[] order the bindings map.
const Z_INFO_FIXTURE = join(ROOT, "docs", "fixtures", "phase7", "z-image-turbo-info.json");
const WAN_INFO_FIXTURE = join(ROOT, "docs", "fixtures", "phase7", "wan2-1-fast-info.json");

// ── Stubbed fetch (shared call log, signal-aware) ────────────────────────────
let stubbedResponse = () => fakeResponse({ data: [] });
const { calls: capturedCalls, restore: restoreFetch } = installFetchStub(
  (url, init) => stubbedResponse(url, init),
);

// Set in main() before any token-less fixture runs; restored in the finally.
let savedHfToken;

const CALL_URL_BASE = "https://mrfakename-z-image-turbo.hf.space";

/** A Form junction: FieldData dict carrying an uploaded Space path. */
function fileData(path) {
  return { path, meta: { _type: "gradio.FileData" } };
}

async function main() {
  await mkdir(SMOKE_DIR, { recursive: true });

  // The token-less fixtures assume NO token resolves anywhere — pin the env
  // off (the adapter's poll fallback consults HF_TOKEN directly) and restore
  // it on exit.
  savedHfToken = process.env.HF_TOKEN;
  delete process.env.HF_TOKEN;

  // ── Imports (repo modules, loaded through the resolve hook) ───────────────
  const bootstrap = await import(pathToFileURL(join(ROOT, "lib/providers/bootstrap.ts")).href);
  const bindingsMod = await import(pathToFileURL(join(ROOT, "lib/providers/bindings.ts")).href);
  const registryMod = await import(pathToFileURL(join(ROOT, "lib/providers/registry.ts")).href);
  const adaptersMod = await import(pathToFileURL(join(ROOT, "lib/providers/adapters/gradio.ts")).href);

  const { BUILT_IN_BINDINGS } = bindingsMod;
  const { get, resolveForModel } = registryMod;
  const { gradioProvider, POLL_TICK_TIMEOUT_MS } = adaptersMod;

  ok(bootstrap !== undefined, "the provider bootstrap imports");
  ok(typeof HARNESS_VERSION === "string" && HARNESS_VERSION.length > 0, "the shared harness exposes its version");

  // ── 1. REGISTRY ─────────────────────────────────────────────────────────────
  section("registry & code-seeded bindings");
  const registered = get("hf-gradio");
  ok(
    "the hf-gradio adapter is registered by the bootstrap",
    !!registered && registered.id === "hf-gradio" && registered === gradioProvider,
  );
  eq("the adapter declares the async-queue polarity", `${registered.mediaStaging}/${registered.capabilities?.syncSubmission}/${registered.capabilities?.polling}/${registered.capabilities?.mediaUpload}`, "remote-url/false/true/true");

  const zResolved = resolveForModel("z-image-turbo", "hf-gradio", []);
  eq(
    "the z-image-turbo Space binding resolves to the /generate_image fn channel",
    zResolved.binding.upstreamModelId + " @ " + zResolved.binding.baseUrl,
    "/generate_image @ https://mrfakename-z-image-turbo.hf.space",
  );
  const wanResolved = resolveForModel("wan2-1-fast", "hf-gradio", []);
  eq(
    "the wan2-1-fast Space binding resolves to the /generate_video fn channel",
    wanResolved.binding.upstreamModelId + " @ " + wanResolved.binding.baseUrl,
    "/generate_video @ https://multimodalart-wan2-1-fast.hf.space",
  );
  eq(
    "both Space bindings stage media as remote-url",
    zResolved.binding.mediaStaging + "/" + wanResolved.binding.mediaStaging,
    "remote-url/remote-url",
  );
  ok(
    "the seeded gradio family counts exactly 2 bindings",
    BUILT_IN_BINDINGS.filter((b) => b.providerId === "hf-gradio").length === 2,
  );

  // ── 2. ARGMAP vs the RECORDED positional order ─────────────────────────────
  section("argMap ⇔ recorded /gradio_api/info order (byte-exact spike bodies)");
  const zInfo = JSON.parse(await readFile(Z_INFO_FIXTURE, "utf8"));
  const zParams = zInfo.named_endpoints["/generate_image"].parameters;
  eq(
    "the recorded Z-Image signature declares 6 data slots",
    zParams.length,
    6,
  );
  eq(
    "the recorded Z-Image order is prompt,height,width,steps,seed,randomize",
    zParams.map((p) => p.parameter_name).join(","),
    "prompt,height,width,num_inference_steps,seed,randomize_seed",
  );
  eq(
    "the z-image-turbo argMap maps prompt→0 and seed→4",
    `${zResolved.binding.argMap.sources["0"]},${zResolved.binding.argMap.sources["4"]}`,
    "prompt,seed",
  );
  eq(
    "the z-image-turbo argMap pins the constants at 1,2,3,5",
    [zResolved.binding.argMap.constants["1"], zResolved.binding.argMap.constants["2"], zResolved.binding.argMap.constants["3"], zResolved.binding.argMap.constants["5"]].join("/"),
    "1024/1024/9/true",
  );

  const wanInfo = JSON.parse(await readFile(WAN_INFO_FIXTURE, "utf8"));
  const wanParams = wanInfo.named_endpoints["/generate_video"].parameters;
  eq(
    "the recorded wan2-1-fast signature declares 10 data slots",
    wanParams.length,
    10,
  );
  eq(
    "the recorded wan2-1-fast order puts input_image at 0 and seed at 8",
    `${wanParams[0].parameter_name},${wanParams[8].parameter_name}`,
    "input_image,seed",
  );
  ok(
    "the wan2-1-fast argMap marks slot 0 as a file slot",
    wanResolved.binding.argMap.fileInputs.includes("0"),
  );
  eq(
    "the wan2-1-fast argMap pins height at 2 (512) and width at 3 (896)",
    `${wanResolved.binding.argMap.constants["2"]},${wanResolved.binding.argMap.constants["3"]}`,
    "512,896",
  );

  // ── Shared minimal inputs ───────────────────────────────────────────────────
  const credentials = {
    providerId: "hf-gradio",
    apiKey: null,
    baseUrl: null,
    extra: {},
    keySource: "none",
  };
  const zModel = { id: "z-image-turbo", apiId: "z-image-turbo", apiInput: {} };
  const wanModel = { id: "wan2-1-fast", apiId: "wan2-1-fast", apiInput: {} };
  const baseInput = {
    taskId: "smoke-gradio-task",
    kind: "image",
    model: zModel,
    binding: zResolved.binding,
    prompt: "a lighthouse in a storm",
    params: { seed: 1234 },
    media: {},
    credentials,
  };

  // ── 3. SUBMIT ───────────────────────────────────────────────────────────────
  section("submit — positional data[], fn channel, event_id");
  stubbedResponse = (url, init) => {
    if (url.endsWith("/gradio_api/call/generate_image") && init?.method === "POST") {
      return fakeResponse({ event_id: "evt-9f7a" });
    }
    return fakeResponse({ }, { status: 404, ok: false });
  };
  capturedCalls.length = 0;
  const submitted = await gradioProvider.submit({
    ...baseInput,
    credentials: { ...credentials, apiKey: "hf-smoke-token", keySource: "db" },
  });
  const submitCall = capturedCalls.find((c) => c.url.includes("/gradio_api/call/generate_image"));
  ok("the submit POSTed the Space call URL", !!submitCall, JSON.stringify(capturedCalls.map((c) => c.url)));
  eq(
    "the submit body is the exact positional data[] shape",
    JSON.stringify(submitCall?.init?.body ? JSON.parse(submitCall.init.body) : null),
    JSON.stringify({ data: ["a lighthouse in a storm", 1024, 1024, 9, 1234, true] }),
  );
  eq(
    "the submit carries the Bearer token when one is configured",
    submitCall?.init?.headers?.Authorization,
    "Bearer hf-smoke-token",
  );
  eq(
    "the submit resolves async with the upstream event id",
    submitted.mode + ":" + submitted.upstreamTaskId,
    "async:evt-9f7a",
  );
  ok(
    "the outcome carries the providerMeta the poll loop needs",
    submitted.providerMeta?.family === "gradio" &&
      submitted.providerMeta?.statusUrl === `${CALL_URL_BASE}/gradio_api/call/generate_image/evt-9f7a` &&
      submitted.providerMeta?.upstreamModelId === "/generate_image",
    JSON.stringify(submitted.providerMeta),
  );

  // The no-token variant: NO Authorization header reaches the Space.
  capturedCalls.length = 0;
  await gradioProvider.submit(baseInput);
  const anonCall = capturedCalls.find((c) => c.url.includes("/gradio_api/call/"));
  eq("a token-less submit sends no Authorization header", anonCall?.init?.headers?.Authorization, undefined);

  // A missing base URL is a LOUD failure (never a silent relative fetch).
  capturedCalls.length = 0;
  let missingBaseError = "";
  try {
    await gradioProvider.submit({
      ...baseInput,
      binding: { ...baseInput.binding, baseUrl: undefined },
      credentials,
    });
  } catch (err) {
    missingBaseError = err?.message ?? String(err);
  }
  ok(
    "an argMap call without a Space base URL fails loudly",
    missingBaseError.includes("base URL") && capturedCalls.length === 0,
    missingBaseError,
  );

  // ── 4. WAN submit (staged startFrame → FileData slot) ──────────────────────
  section("wan2-1-fast submit — the startFrame slot wraps into FileData");
  // A STAGED start-frame: mediaStager stored the Space's own uploaded path
  // verbatim (the "remote-url" upload result — /tmp/gradio/…).
  const stagedFrame = {
    originalUrl: "/generated/smoke-start.png",
    kind: "image",
    strategy: "remote-url",
    url: "/tmp/gradio/b183f4/smoke-start.png",
    filePath: join(SMOKE_DIR, "smoke-start.png"),
    mimeType: "image/png",
  };
  stubbedResponse = (url, init) => {
    if (url.endsWith("/gradio_api/call/generate_video") && init?.method === "POST") {
      return fakeResponse({ event_id: "evt-wan-1" });
    }
    return fakeResponse({}, { status: 404, ok: false });
  };
  capturedCalls.length = 0;
  const wanSubmitted = await gradioProvider.submit({
    taskId: "smoke-gradio-task",
    kind: "video",
    model: wanModel,
    binding: wanResolved.binding,
    prompt: "the sea breathes",
    params: { seed: 7 },
    media: { startFrame: stagedFrame },
    credentials,
  });
  const wanCall = capturedCalls.find((c) => c.url.includes("/gradio_api/call/generate_video"));
  ok("the wan submit POSTed its Space call URL", !!wanCall, JSON.stringify(capturedCalls.map((c) => c.url)));
  eq(
    "the wan data[] carries the FileData dict at slot 0 and nulls for unmapped indices",
    JSON.stringify(wanCall?.init?.body ? JSON.parse(wanCall.init.body) : null),
    JSON.stringify({
      data: [
        fileData("/tmp/gradio/b183f4/smoke-start.png"),
        "the sea breathes",
        512,
        896,
        "",
        null, // duration_seconds — upstream default (picker lands with P7a-1)
        1,
        4,
        7,
        true,
      ],
    }),
  );
  eq(
    "the wan submit resolves async with its own event id",
    wanSubmitted.mode + ":" + wanSubmitted.upstreamTaskId,
    "async:evt-wan-1",
  );
  ok(
    "submit never uploads on its own (staging owns the upload leg)",
    !capturedCalls.some((c) => c.url.includes("/gradio_api/upload")),
  );
  // A PUBLIC staged reference rides through as a FileData path too — no upload.
  capturedCalls.length = 0;
  await gradioProvider.submit({
    taskId: "smoke-gradio-task",
    kind: "video",
    model: wanModel,
    binding: wanResolved.binding,
    prompt: "the sea breathes",
    params: { seed: 7 },
    media: {
      startFrame: { ...stagedFrame, url: "https://pics.example/frame.png", strategy: "data-url" },
    },
    credentials,
  });
  const publicRefCall = capturedCalls.find((c) => c.url.includes("/gradio_api/call/"));
  eq(
    "a public staged URL rides as a FileData path, not a bare string",
    publicRefCall?.init?.body ? JSON.parse(publicRefCall.init.body).data[0] : null,
    fileData("https://pics.example/frame.png"),
  );

  // ── 5. UPLOAD ───────────────────────────────────────────────────────────────
  section("upload — multipart round-trip to /gradio_api/upload");
  const PNG_BYTES = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  stubbedResponse = (url) => {
    if (url === `${CALL_URL_BASE}/gradio_api/upload`) {
      return fakeResponse(["/tmp/gradio/b183f4/smoke-ref.png"]);
    }
    return fakeResponse({}, { status: 404, ok: false });
  };
  capturedCalls.length = 0;
  const uploadRes = await gradioProvider.uploadMedia(
    `data:image/png;base64,${PNG_BYTES.toString("base64")}`,
    "image/png",
    { ...credentials, apiKey: "hf-smoke-token" },
    zResolved.binding,
  );
  eq("the upload resolves to the Space's own uploaded path", uploadRes, "/tmp/gradio/b183f4/smoke-ref.png");
  const uploadCall = capturedCalls.find((c) => c.url.includes("/gradio_api/upload"));
  ok("the uploaded body rides multipart", uploadCall?.init?.body instanceof FormData, String(uploadCall?.init?.body));
  const fileField = uploadCall?.init?.body?.get("files");
  ok("the multipart field is \"files\" (the Gradio wire form)", !!fileField, String(uploadFieldOf(uploadCall)));
  ok(
    "the uploaded bytes carry the source mime",
    typeof fileField === "object" && fileField?.type === "image/png",
    String(fileField?.type),
  );
  // An empty upload answer is a LOUD failure — a silently dropped reference is
  // worse than a surfaced error (the staging contract).
  stubbedResponse = () => fakeResponse([]);
  let uploadError = "";
  try {
    await gradioProvider.uploadMedia(
      `data:image/png;base64,${PNG_BYTES.toString("base64")}`,
      "image/png",
      credentials,
      zResolved.binding,
    );
  } catch (err) {
    uploadError = err?.message ?? String(err);
  }
  ok(
    "an upload response without a path fails loudly",
    uploadError.includes("no uploaded path"),
    uploadError,
  );

  // ── 6. POLL — public Space (no token) ───────────────────────────────────────
  section("poll — public Space → mediaUrls (the settle funnel mirrors)");
  const metaZ = {
    family: "gradio",
    statusUrl: `${CALL_URL_BASE}/gradio_api/call/generate_image/evt-9f7a`,
    upstreamTaskId: "evt-9f7a",
    upstreamModelId: "/generate_image",
  };
  const PUBLIC_FILE_URL = `${CALL_URL_BASE}/gradio_api/file=/tmp/gradio/out.png`;
  const completeSse = () =>
    sseFrames([
      { event: "heartbeat", data: null },
      { event: "complete", data: [{ path: "/tmp/gradio/out.png", url: PUBLIC_FILE_URL }] },
    ]);
  stubbedResponse = (url, init) => {
    if (url === metaZ.statusUrl && init?.method === undefined) return completeSse();
    return fakeResponse({}, { status: 404, ok: false });
  };
  capturedCalls.length = 0;
  const publicOutcome = await gradioProvider.poll("evt-9f7a", "image", credentials, metaZ);
  eq(
    "a public complete settles done with the file URL",
    publicOutcome.state + ":" + JSON.stringify(publicOutcome.mediaUrls ?? null),
    "done:" + JSON.stringify([PUBLIC_FILE_URL]),
  );
  const statusCall = capturedCalls.find((c) => c.url === metaZ.statusUrl);
  eq(
    "the poll GET re-opens the stream by event id",
    statusCall?.url,
    metaZ.statusUrl,
  );
  eq("a token-less poll sends no Authorization header", statusCall?.init?.headers?.Authorization, undefined);

  // ── 7. POLL — private Space (token) → buffers, NEVER a mirrored URL ────────
  section("poll — private Space → done.buffers with an EMPTY mediaUrls");
  const VIDEO_BYTES = Buffer.from("fake-mp4-atoms-for-smoke");
  stubbedResponse = (url) => {
    if (url === metaZ.statusUrl) {
      return sseFrames([{ event: "complete", data: { video: { path: "/tmp/gradio/out.mp4" } } }]);
    }
    if (url === `${CALL_URL_BASE}/gradio_api/file=/tmp/gradio/out.mp4`) {
      return fakeResponse({}, { bytes: VIDEO_BYTES, contentType: "video/mp4" });
    }
    return fakeResponse({}, { status: 404, ok: false });
  };
  capturedCalls.length = 0;
  const privateOutcome = await gradioProvider.poll(
    "evt-9f7a",
    "video",
    { ...credentials, apiKey: "hf-smoke-token" },
    metaZ,
  );
  eq(
    "the private path settles done with the raw video buffer",
    privateOutcome.state + ":" + Buffer.from(privateOutcome.buffers?.[0]?.buffer ?? []).toString("utf8"),
    "done" + ":" + VIDEO_BYTES.toString("utf8"),
  );
  eq(
    "the private mime rides through to the buffer",
    privateOutcome.buffers?.[0]?.mimeType,
    "video/mp4",
  );
  eq(
    "the settle funnel is NEVER asked to mirror a private URL",
    JSON.stringify(privateOutcome.mediaUrls ?? null),
    "[]",
  );
  const fileCall = capturedCalls.find((c) => c.url.includes("/gradio_api/file="));
  eq(
    "the in-adapter byte fetch carries the bearer token",
    fileCall?.init?.headers?.Authorization,
    "Bearer hf-smoke-token",
  );
  // A short video whose file URL is token-gated could never be mirrored by
  // the settle funnel's headerless fetch — that is WHY the bytes are inlined.

  // ── 7b. POLL — the ORIGIN PIN (plan §f, review blocker on 7177592) ─────────
  section("poll — a file URL on a foreign origin is a LOUD error, never a target");
  const FOREIGN_URL = "https://attacker.example/x.png";

  // PUBLIC variant: no token — the foreign URL must never reach mediaUrls.
  stubbedResponse = (url) => {
    if (url === metaZ.statusUrl) {
      return sseFrames([{ event: "complete", data: [{ path: "/tmp/gradio/out.png", url: FOREIGN_URL }] }]);
    }
    return fakeResponse({}, { status: 404, ok: false });
  };
  capturedCalls.length = 0;
  const foreignPublic = await gradioProvider.poll("evt-9f7a", "image", credentials, metaZ);
  ok(
    "a complete frame with a foreign-origin url settles error (public path)",
    foreignPublic.state === "error" &&
      foreignPublic.error?.includes("foreign origin") &&
      foreignPublic.error?.includes(FOREIGN_URL),
    JSON.stringify(foreignPublic),
  );
  ok(
    "no request was ever made to the foreign origin (public path)",
    !capturedCalls.some((c) => c.url.includes("attacker.example")),
    JSON.stringify(capturedCalls.map((c) => c.url)),
  );
  eq(
    "the settle funnel is NEVER handed a foreign host (mediaUrls stays empty)",
    JSON.stringify(foreignPublic.mediaUrls ?? null),
    "null",
  );

  // PRIVATE variant: token present — assert on capturedCalls, not just the
  // outcome: the bearer token must never ride ANY foreign host.
  capturedCalls.length = 0;
  const foreignPrivate = await gradioProvider.poll(
    "evt-9f7a",
    "image",
    { ...credentials, apiKey: "hf-smoke-token" },
    metaZ,
  );
  ok(
    "a complete frame with a foreign-origin url settles error (private path)",
    foreignPrivate.state === "error" && foreignPrivate.error?.includes(FOREIGN_URL),
    JSON.stringify(foreignPrivate),
  );
  ok(
    "the bearer token was never sent to the foreign host (no call, no exfil)",
    !capturedCalls.some((c) => c.url.includes("attacker.example")),
    JSON.stringify(capturedCalls.map((c) => c.url)),
  );
  ok(
    "every Authorization-bearing call rides the pinned origin only",
    capturedCalls
      .filter((c) => String(c.init?.headers?.Authorization ?? "").startsWith("Bearer"))
      .every((c) => new URL(c.url).origin === new URL(metaZ.statusUrl).origin),
    JSON.stringify(capturedCalls.map((c) => c.url)),
  );

  // A 302 on the status endpoint: redirect:"error" pins it (transient throw,
  // no follow-up to the Location target).
  stubbedResponse = (url) => {
    if (url === metaZ.statusUrl) {
      return new Response("", {
        status: 302,
        statusText: "Found",
        headers: { location: "https://attacker.example/stream" },
      });
    }
    return fakeResponse({}, { status: 404, ok: false });
  };
  capturedCalls.length = 0;
  let redirectError = "";
  try {
    await gradioProvider.poll("evt-9f7a", "image", { ...credentials, apiKey: "hf-smoke-token" }, metaZ);
  } catch (err) {
    redirectError = err?.message ?? String(err);
  }
  ok(
    "a 302 status endpoint is NOT followed to its Location",
    redirectError.includes("(302)") &&
      !capturedCalls.some((c) => c.url.includes("attacker.example")),
    JSON.stringify({ redirectError, calls: capturedCalls.map((c) => c.url) }),
  );
  eq(
    "the status fetch passes redirect:\"error\" to the pinned origin",
    capturedCalls[0]?.init?.redirect,
    "error",
  );

  // ── 8. POLL — pending variants ─────────────────────────────────────────────
  section("poll — keepalive shapes stay pending");
  stubbedResponse = () =>
    sseFrames([{ event: "generating", data: null }, { event: "generating", data: null }]);
  eq(
    "a generating stream keeps the task pending",
    (await gradioProvider.poll("evt-9f7a", "image", credentials, metaZ)).state,
    "pending",
  );
  stubbedResponse = () => sseHeartbeatOnly();
  eq(
    "a heartbeat-only stream keeps the task pending",
    (await gradioProvider.poll("evt-9f7a", "image", credentials, metaZ)).state,
    "pending",
  );
  stubbedResponse = () => sseEofNoComplete();
  eq(
    "an EOF without a terminal frame keeps the task pending",
    (await gradioProvider.poll("evt-9f7a", "image", credentials, metaZ)).state,
    "pending",
  );

  section("poll — mid-frame chunk split reassembles before parsing");
  stubbedResponse = () => completeSse({ splitEveryNBytes: 7 });
  const splitOutcome = await gradioProvider.poll("evt-9f7a", "image", credentials, metaZ);
  eq(
    "a complete frame cut mid-chunk still resolves the file URL",
    splitOutcome.state + ":" + JSON.stringify(splitOutcome.mediaUrls ?? null),
    "done:" + JSON.stringify([PUBLIC_FILE_URL]),
  );

  // ── 9. POLL — error frame ───────────────────────────────────────────────────
  section("poll — the Space's error frame settles error");
  stubbedResponse = () =>
    sseFrames([{ event: "generating", data: null }, { event: "error", data: "ZeroGPU quota exceeded" }]);
  const errorOutcome = await gradioProvider.poll("evt-9f7a", "image", credentials, metaZ);
  ok(
    "the error frame carries the upstream message",
    errorOutcome.state === "error" && errorOutcome.error?.includes("ZeroGPU quota exceeded"),
    JSON.stringify(errorOutcome),
  );

  // ── 10. POLL — non-ok HTTP → transient throw ────────────────────────────────
  section("poll — non-ok status HTTP is a transient throw");
  stubbedResponse = () => fakeResponse({ detail: "restarting" }, { status: 502, ok: false });
  let statusErrorName = "";
  let statusErrorMessage = "";
  try {
    await gradioProvider.poll("evt-9f7a", "image", credentials, metaZ);
  } catch (err) {
    statusErrorName = err?.name ?? "Error";
    statusErrorMessage = err?.message ?? String(err);
  }
  ok(
    "a 502 status stream throws (the job loop retries, never settles)",
    statusErrorName === "Error" && statusErrorMessage.includes("(502)"),
    statusErrorMessage,
  );

  // ── 11. TIMEOUTS ────────────────────────────────────────────────────────────
  section("timeout contract — per-tick read budget");
  eq(
    "the exported read budget sits in [20s, 30s]",
    POLL_TICK_TIMEOUT_MS >= 20_000 && POLL_TICK_TIMEOUT_MS <= 30_000,
    true,
  );
  // An abort DURING the stream — the timeout signal the adapter handed to
  // fetch is exercised via the stub's init.signal. (AbortSignal.timeout()
  // exposes no controller, so the smoke fires the SAME "abort" event the
  // budget's timeout would fire — the listener path is what's under test.)
  let hangAborted = false;
  stubbedResponse = () =>
    sseFrames(
      Array.from({ length: 40 }, () => ({ event: "heartbeat", data: null })),
      { chunkDelayMs: 100 }, // a slow keepalive stream — the abort lands first
    );
  capturedCalls.length = 0;
  const hangPromise = gradioProvider.poll("evt-9f7a", "image", credentials, metaZ).then(
    (outcome) => ({ rejected: false, outcome }),
    (err) => ({ rejected: true, err }),
  );
  for (let i = 0; i < 50 && capturedCalls.length === 0; i += 1) {
    await sleepMs(20);
  }
  const hangSignal = capturedCalls[0]?.init?.signal;
  if (hangSignal) {
    fireAbortEvent(hangSignal);
    hangAborted = true;
  } else {
    hangAborted = false;
  }
  const hangResult = await hangPromise;
  ok(
    "a mid-stream abort surfaces as an AbortError to the poll loop",
    hangAborted && hangResult.rejected && hangResult.err?.name === "AbortError",
    JSON.stringify({ hangAborted, rejected: hangResult.rejected, name: hangResult.err?.name }),
  );

  // ── 12. READINESS ───────────────────────────────────────────────────────────
  section("readiness — base URL required, the HF token optional");
  const noBase = gradioProvider.checkReadiness(
    { ...credentials, baseUrl: null },
    { ...zResolved.binding, baseUrl: undefined },
  );
  eq("no baseUrl ⇒ not ready", noBase.ready, false);
  ok(
    "the readiness reason names the missing base URL",
    typeof noBase.reason === "string" && noBase.reason.includes("base URL"),
    noBase.reason,
  );
  const withBase = gradioProvider.checkReadiness(
    { ...credentials, baseUrl: CALL_URL_BASE },
    zResolved.binding,
  );
  eq("a Space base URL with NO key is still ready (public Space)", withBase.ready, true);
  eq("the readiness carries no reason for a ready Space", withBase.reason ?? null, null);
}

/** The Blob/File entry of the stubbed multipart body, described for messages. */
function uploadFieldOf(call) {
  const field = call?.init?.body?.get?.("files");
  if (!field) return "";
  return `${field.type ?? "unknown"} · ${field.size ?? "?"} bytes`;
}

/** AbortSignal.timeout() exposes NO controller — fire the same event the
 * deadline would fire, hitting the same stub listener. */
function fireAbortEvent(signal) {
  try {
    signal.dispatchEvent(new Event("abort", { bubbles: false, cancelable: false }));
  } catch {
    /* the signal was already aborted */
  }
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

try {
  await main();
} catch (err) {
  failures.push(`fixture crashed: ${err?.stack ?? err?.message ?? String(err)}`);
} finally {
  restoreFetch();
  if (savedHfToken === undefined) delete process.env.HF_TOKEN;
  else process.env.HF_TOKEN = savedHfToken;
  await rm(SMOKE_DIR, { recursive: true, force: true });
}

console.log("");
if (failures.length) {
  console.log(`✗ ${failures.length} assertion(s) failed (${passed} passed):`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ smoke-gradio: ${passed} assertions passed.`);
process.exit(0);

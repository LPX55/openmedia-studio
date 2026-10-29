#!/usr/bin/env node
/**
 * smoke-compat — PERMANENT offline smoke fixture for the openai-compat provider
 * family (Deepwork P6 step 2; compat-plan §e step 2 / §f validation).
 *
 * WHAT IT CHECKS (fully offline — no network, no API key, no build step):
 *
 * The shared harness (assertions, Response-alike streaming + mid-frame splits,
 * SSE replay, signal-aware fetch stub) lives in ./smoke-lib.mjs; this fixture
 * keeps only the provider-specific coverage and fixtures.
 *
 *   1. REGISTRY — the bootstrap boots and the "openrouter" BACKEND alias of the
 *      openai-compat family is registered (id stays the backend id).
 *   2. BINDINGS — the static OpenRouter image bindings resolve: upstream ids,
 *      base URL, endpoint path, key env, dialect fields, value maps, ref caps,
 *      and the per-model provider union.
 *   3. REQUEST BODY — the adapter builds the OpenRouter request with a STUBBED
 *      fetch: URL (`https://openrouter.ai/api/v1/images`), auth header, and the
 *      dialect body (`model` / `prompt` / `aspect_ratio` / `resolution` /
 *      `input_references`) — plus the "undeclared field is not sent" rule and
 *      the upstream reference cap.
 *   4. RESPONSE MAPPING — `b64_json` → raw buffer, `url` → media url, 401 →
 *      the invalid-key error.
 *   5. STAGING — `stageInputMedia` picks the strategy per OPERATION for a
 *      local fixture file (data-url for the compat family, multipart-buffer for
 *      the Azure edits operation).
 *   6. READINESS — `checkReadiness` gates on key + base URL (db key, keyEnv
 *      fallback, missing key, missing base URL).
 *   7. PARAM PRESETS — the seeded presets (ids + family, valid JSON, no
 *      duplicates on re-open), the resolution order
 *      (preset params ← binding.paramMap ← custom override) and the loud
 *      failure on an unknown preset id.
 *   8. SETTINGS ENDPOINT — `GET /api/settings/providers` reports the
 *      "openrouter" entry (label, key source, base URL, readiness), the
 *      per-model provider union and the preset list; `PUT` accepts a
 *      `presetId` and rejects an unknown one.
 *   9. POLLINATIONS (the family's second backend) — the "pollinations" alias
 *      is registered, the 11 image bindings carry the spike's exact upstream
 *      ids / base URL / key env / media store, the request body speaks the
 *      Pollinations dialect (width/height/seed/image), the media upload
 *      posts to the binding's media store and the "remote-url" staging
 *      routes a local reference through it, and the settings endpoint
 *      reports the backend.
 *  10. JOB TRAIL + BOUNDED RETRY — the per-job trail is capped (last 50
 *      entries) and survives a status write, the redaction strips keys /
 *      data: payloads / URL userinfo, a NETWORK failure (DNS) is retried
 *      exactly ONCE, and an HTTP 5xx is NOT retried at all.
 *  11. THE RUN-LOG READ API — `GET /api/jobs/[taskId]/log` answers 200 with
 *      the trail of a known job and with a clear empty shape for an unknown
 *      one (never a 500).
 *  12. THE VIDEO LANE (the family's async leg) — the OpenRouter video
 *      bindings resolve (upstream ids, endpoint path, staging), the request
 *      body speaks the video dialect (`duration` / `resolution` /
 *      `aspect_ratio` / `seed` / `generate_audio` / `frame_images` /
 *      `input_references`), the "auto" ratio is dropped, the duration is
 *      re-clamped to the model's own limits, the submit is ASYNC (`202` +
 *      `polling_url` → an absolute status URL), and the poll maps all six
 *      statuses (pending / in_progress / completed / failed / cancelled /
 *      expired) — the finished video arriving as raw BYTES.
 *
 * HOW TO RUN
 *
 *   node scripts/providers/smoke-compat.mjs        # or: pnpm smoke:providers
 *
 * Requirements: Node >= 22.18 (native TypeScript type-stripping — the repo has
 * no tsx/esbuild and this script adds no dependency) and nothing else. The
 * script maps the repo's extensionless imports + the "@/…" alias itself, so
 * there is NO build step and NO import of the client bundle.
 *
 * The LIVE step (one real OpenRouter image call) is OPT-IN and skipped by
 * default — it needs `OPENROUTER_API_KEY` AND `HELIOS_SMOKE_LIVE=1`.
 *
 * Exit code: 0 = every assertion passed, 1 = at least one failed (each failure
 * is printed with a "✗" prefix).
 */
import { register } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  quiet,
  section,
  sseFrames,
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
// resolve hook (registered in a worker thread by `module.register`) retries
// with ".ts" and maps the alias — no dependencies, no build step.
const RESOLVE_HOOK = `
const ROOT = ${JSON.stringify(ROOT)};
export async function resolve(specifier, context, nextResolve) {
  let spec = specifier;
  if (spec.startsWith("@/")) spec = ROOT + "/" + spec.slice(2);
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
const SMOKE_DIR = join(ROOT, "public", "generated", ".smoke-compat");
// MUST be set before the repo modules are imported — lib/guest/paths.ts reads
// the env at import time.
process.env.HELIOS_MEDIA_DIR = SMOKE_DIR;
process.env.HELIOS_DATA_DIR = join(SMOKE_DIR, "data");

// ── Shared harness ───────────────────────────────────────────────────────────
// Assertions, the fake Response (streaming / splits / SSE replay) and the
// signal-aware fetch stub live in ./smoke-lib.mjs.

// ── Fixtures ─────────────────────────────────────────────────────────────────
// 1×1 PNG — a real (tiny) image, so the staging path exercises real bytes.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const REF_URL = "https://example.com/reference-a.png";

// ── Stubbed fetch (shared call log, signal-aware) ────────────────────────────
let stubbedResponse = () => fakeResponse({ data: [] });
const { calls: capturedCalls, restore: restoreFetch } = installFetchStub(
  (url, init) => stubbedResponse(url, init),
);
// The installed stub — a coverage section can put it back after swapping
// globalThis.fetch without re-installing (which would rebind the call log).
const installedFetch = globalThis.fetch;

/** Drain a ReadableStream body into a utf8 string (harness self-test helper). */
async function readStreamText(stream) {
  const reader = stream.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  await mkdir(SMOKE_DIR, { recursive: true });

  // ── Imports (repo modules, loaded through the resolve hook) ───────────────
  const bootstrap = await import(pathToFileURL(join(ROOT, "lib/providers/bootstrap.ts")).href);
  const bindingsMod = await import(pathToFileURL(join(ROOT, "lib/providers/bindings.ts")).href);
  const typesMod = await import(pathToFileURL(join(ROOT, "lib/providers/types.ts")).href);
  const stagerMod = await import(pathToFileURL(join(ROOT, "lib/providers/mediaStager.ts")).href);
  const modelConfig = await import(pathToFileURL(join(ROOT, "lib/modelConfig.ts")).href);

  const {
    BUILT_IN_BINDINGS,
    getAvailableProvidersForModel,
    getOpenRouterBinding,
    getPollinationsBinding,
    getDefaultBinding,
    OPENROUTER_BASE_URL,
    OPENROUTER_KEY_ENV,
    OPENROUTER_IMAGE_PATH,
    OPENROUTER_VIDEO_PATH,
    POLLINATIONS_BASE_URL,
    POLLINATIONS_KEY_ENV,
    POLLINATIONS_MEDIA_UPLOAD_URL,
  } = bindingsMod;

  // ── Harness capabilities (infrastructure self-test, NOT provider coverage) ─
  section("harness capabilities (self-test)");
  ok(
    "the shared harness exposes its version",
    typeof HARNESS_VERSION === "string" && HARNESS_VERSION.length > 0,
  );
  eq(
    "fakeResponse.json() parses the payload",
    await fakeResponse({ selfTest: true }).json(),
    { selfTest: true },
  );
  const chunkedResponse = fakeResponse("chunked-payload", {
    chunks: ["chun", "ked-", "payload"],
  });
  eq(
    "body chunks reassemble through getReader()",
    await readStreamText(chunkedResponse.body),
    "chunked-payload",
  );
  ok("bodyUsed flips once the body is read", chunkedResponse.bodyUsed === true);

  const wireFrames = [
    { data: { hello: "world" } },
    { event: "complete", data: null },
  ];
  const expectedWire = "event: message\ndata: {\"hello\":\"world\"}\n\nevent: complete\ndata: null\n\n";
  const splitResponse = sseFrames(wireFrames, { splitEveryNBytes: 7 });
  eq(
    "mid-frame SSE splits reassemble to the same bytestring",
    await readStreamText(splitResponse.body),
    expectedWire,
  );

  const earlyAbort = new AbortController();
  stubbedResponse = () =>
    fakeResponse("early-abort", { chunks: ["early-", "abort"], chunkDelayMs: 50 });
  const earlyOutcome = globalThis
    .fetch("http://self-test/early-abort", { signal: earlyAbort.signal })
    .then(() => null, (err) => err);
  setTimeout(() => earlyAbort.abort(), 5);
  const earlyError = await earlyOutcome;
  eq(
    "an aborted-early signal rejects the fetch with AbortError",
    earlyError?.name,
    "AbortError",
  );

  const lateAbort = new AbortController();
  stubbedResponse = () =>
    fakeResponse("late-abort", { chunks: ["late-", "abort"], chunkDelayMs: 50 });
  const streamedResponse = await globalThis.fetch("http://self-test/late-abort", {
    signal: lateAbort.signal,
  });
  const streamedReader = streamedResponse.body.getReader();
  lateAbort.abort();
  let abortReadError = null;
  try {
    for (;;) {
      const { done } = await streamedReader.read();
      if (done) break;
    }
  } catch (err) {
    abortReadError = err;
  }
  eq(
    "the body reader surfaces the abort while in-flight",
    abortReadError?.name,
    "AbortError",
  );
  stubbedResponse = () => fakeResponse({ data: [] });

  // ── 1. Registry ────────────────────────────────────────────────────────────
  section("registry");
  const orProvider = bootstrap.get("openrouter");
  const familyProvider = bootstrap.get("openai-compat");
  ok("openrouter backend alias is registered", !!orProvider);
  eq("openrouter alias keeps the BACKEND id", orProvider?.id, "openrouter");
  eq("openrouter family adapter is registered", familyProvider?.id, "openai-compat");
  eq("family adapter declares the openrouter alias", [...(familyProvider?.aliases ?? [])], ["openrouter", "pollinations"]);
  eq("openrouter staging default", orProvider?.mediaStaging, "data-url");
  eq("openrouter submits synchronously (the image leg)", orProvider?.capabilities?.syncSubmission, true);
  eq("the family implements polling (the async video leg)", orProvider?.capabilities?.polling, true);
  eq("the family serves video", orProvider?.capabilities?.video, true);
  // The family DOES implement the upload hook (a backend that stages media as
  // "remote-url" needs it — see the Pollinations section below). OpenRouter
  // stages as "data-url", so the hook never runs for it.
  eq("the family implements the media-upload hook", familyProvider?.capabilities?.mediaUpload, true);
  ok("openrouter exposes checkReadiness", typeof orProvider?.checkReadiness === "function");
  ok("openrouter exposes submit", typeof orProvider?.submit === "function");

  // ── 2. Bindings ───────────────────────────────────────────────────────────
  section("static OpenRouter bindings");
  const orBindings = BUILT_IN_BINDINGS.filter(
    (b) => b.providerId === "openrouter" && b.pathOverride === OPENROUTER_IMAGE_PATH,
  );
  eq("19 OpenRouter image bindings are code-defined", orBindings.length, 19);
  const representative = getOpenRouterBinding();
  ok("a representative OpenRouter binding resolves", !!representative);
  eq("the representative binding is an OpenRouter one", representative?.providerId, "openrouter");
  eq("the representative binding carries the base URL", representative?.baseUrl, OPENROUTER_BASE_URL);
  eq("the representative binding carries the key env", representative?.keyEnv, OPENROUTER_KEY_ENV);
  const nb2 = orBindings.find((b) => b.modelId === "nano-banana-2");
  ok("nano-banana-2 has an OpenRouter binding", !!nb2);
  eq("nano-banana-2 upstream id", nb2?.upstreamModelId, "google/gemini-nano-banana-2.1");
  eq("nano-banana-2 base URL", nb2?.baseUrl, OPENROUTER_BASE_URL);
  eq("nano-banana-2 endpoint path", nb2?.pathOverride, "/images");
  eq("nano-banana-2 key env", nb2?.keyEnv, OPENROUTER_KEY_ENV);
  eq("nano-banana-2 reference cap", nb2?.paramMap?.maxReferences, 14);
  eq("nano-banana-2 aspect_ratio field", nb2?.paramMap?.fields?.aspect_ratio, "aspectRatio");
  eq("nano-banana-2 resolution field", nb2?.paramMap?.fields?.resolution, "tier");
  eq("nano-banana-2 input_references field", nb2?.paramMap?.fields?.input_references, "references");
  eq("nano-banana-2 resolution value map", nb2?.paramMap?.valueMaps?.resolution, { "1k": "1K", "2k": "2K", "4k": "4K" });
  const gpt2Or = orBindings.find((b) => b.modelId === "gpt-image-2");
  eq("gpt-image-2 quality value map (auto/low/medium/high)", gpt2Or?.paramMap?.valueMaps?.quality, { "1k": "low", "2k": "medium", "4k": "high" });
  ok("provider union of nano-banana-2 includes openrouter", getAvailableProvidersForModel("nano-banana-2").includes("openrouter"));
  ok("provider union of gpt-image-2 keeps azure/codex/openrouter", ["azure", "codex", "openrouter"].every((id) => getAvailableProvidersForModel("gpt-image-2").includes(id)));

  // ── 3./4. Request body + response mapping (stubbed fetch) ─────────────────
  section("request body (stubbed fetch)");
  const model = modelConfig.IMAGE_MODELS.find((m) => m.id === "nano-banana-2");
  ok("nano-banana-2 is in the image catalog", !!model);
  const credentials = {
    providerId: "openrouter",
    apiKey: "sk-or-smoke-key",
    baseUrl: null,
    extra: {},
    keySource: "db",
  };
  const stagedReference = {
    originalUrl: REF_URL,
    kind: "image",
    strategy: "data-url",
    url: REF_URL,
    mimeType: "image/png",
  };
  const baseInput = {
    taskId: "smoke-task-1",
    kind: "image",
    model,
    binding: nb2,
    prompt: "a red bicycle on a wet street at night",
    params: { aspectRatio: "16:9", quality: "2k" },
    media: { references: [stagedReference] },
    credentials,
  };

  capturedCalls.length = 0;
  stubbedResponse = () => fakeResponse({ data: [{ b64_json: PNG_BYTES.toString("base64") }] });
  const b64Outcome = await quiet(() => orProvider.submit(baseInput));
  eq("exactly one upstream request", capturedCalls.length, 1);
  const call = capturedCalls[0] ?? { url: "", init: {} };
  eq("request URL (base + OpenRouter path)", call.url, `${OPENROUTER_BASE_URL}/images`);
  eq("request method", call.init?.method, "POST");
  eq("authorization header", call.init?.headers?.Authorization, "Bearer sk-or-smoke-key");
  eq("content type header", call.init?.headers?.["Content-Type"], "application/json");
  const body = JSON.parse(String(call.init?.body ?? "{}"));
  eq("body model (upstream id)", body.model, "google/gemini-nano-banana-2.1");
  eq("body prompt", body.prompt, baseInput.prompt);
  eq("body aspect_ratio", body.aspect_ratio, "16:9");
  eq("body resolution (tier mapped to the upstream enum)", body.resolution, "2K");
  eq("body input_references", body.input_references, [{ type: "image_url", image_url: { url: REF_URL } }]);
  ok("undeclared field `seed` is NOT sent", body.seed === undefined);
  ok("undeclared field `size` is NOT sent", body.size === undefined);
  ok("undeclared field `output_format` is NOT sent", body.output_format === undefined);
  eq("submit resolves synchronously", b64Outcome.mode, "sync");
  eq("b64_json → one raw buffer", b64Outcome.rawBuffers?.length, 1);
  ok("b64_json → the exact bytes", Buffer.compare(b64Outcome.rawBuffers?.[0]?.buffer ?? Buffer.alloc(0), PNG_BYTES) === 0);
  eq("buffer mime type (default png)", b64Outcome.rawBuffers?.[0]?.mimeType, "image/png");

  section("reference cap + url mapping");
  capturedCalls.length = 0;
  const manyRefs = Array.from({ length: 20 }, (_, i) => ({
    originalUrl: `https://example.com/ref-${i}.png`,
    kind: "image",
    strategy: "data-url",
    url: `https://example.com/ref-${i}.png`,
  }));
  stubbedResponse = () => fakeResponse({ data: [{ b64_json: PNG_BYTES.toString("base64") }] });
  await quiet(() => orProvider.submit({ ...baseInput, media: { references: manyRefs } }));
  const cappedBody = JSON.parse(String(capturedCalls[0]?.init?.body ?? "{}"));
  eq("upstream reference cap applied (14)", cappedBody.input_references?.length, 14);
  eq("the cap keeps the FIRST references", cappedBody.input_references?.[0], { type: "image_url", image_url: { url: "https://example.com/ref-0.png" } });

  capturedCalls.length = 0;
  stubbedResponse = () => fakeResponse({ data: [{ url: "https://cdn.example.com/out.png" }] });
  const urlOutcome = await quiet(() => orProvider.submit(baseInput));
  eq("url → media url", urlOutcome.mediaUrls, ["https://cdn.example.com/out.png"]);
  eq("url → no raw buffers", urlOutcome.rawBuffers?.length ?? 0, 0);

  capturedCalls.length = 0;
  stubbedResponse = () => fakeResponse({ error: "invalid key" }, { ok: false, status: 401 });
  let authError = null;
  try {
    await quiet(() => orProvider.submit(baseInput));
  } catch (err) {
    authError = err;
  }
  ok("401 → the adapter throws", !!authError);
  ok("401 → the message points at the key", /API key/i.test(authError?.message ?? ""), authError?.message);

  // ── 5. Staging (op selection) ─────────────────────────────────────────────
  section("media staging (operation selection)");
  const fixturePath = join(SMOKE_DIR, "ref.png");
  await writeFile(fixturePath, PNG_BYTES);
  const localRef = "/generated/ref.png";
  eq("OR binding resolves to data-url for image-generate", typesMod.resolveMediaStagingStrategy("image-generate", nb2, orProvider.mediaStaging), "data-url");
  eq("OR binding resolves to data-url for image-edit", typesMod.resolveMediaStagingStrategy("image-edit", nb2, orProvider.mediaStaging), "data-url");
  const staged = await stagerMod.stageInputMedia(
    { references: [localRef] },
    stagerMod.createStagingResolver("image-generate", nb2, orProvider),
    credentials,
  );
  eq("one staged reference", staged.references?.length, 1);
  eq("staged strategy", staged.references?.[0]?.strategy, "data-url");
  eq("staged mime type", staged.references?.[0]?.mimeType, "image/png");
  ok("local file → data: URL", String(staged.references?.[0]?.url ?? "").startsWith("data:image/png;base64,"));
  const decoded = Buffer.from(String(staged.references?.[0]?.url ?? "").split(",")[1] ?? "", "base64");
  ok("staged data URL carries the fixture bytes", Buffer.compare(decoded, PNG_BYTES) === 0);
  eq("staged originalUrl is never rewritten", staged.references?.[0]?.originalUrl, localRef);

  // Per-operation override wins over the provider default (Azure edits).
  const azureBinding = BUILT_IN_BINDINGS.find((b) => b.providerId === "azure");
  const azureProvider = bootstrap.get("azure");
  ok("azure binding exists", !!azureBinding);
  eq("azure image-generate → data-url", typesMod.resolveMediaStagingStrategy("image-generate", azureBinding, azureProvider.mediaStaging), "data-url");
  eq("azure image-edit → multipart-buffer", typesMod.resolveMediaStagingStrategy("image-edit", azureBinding, azureProvider.mediaStaging), "multipart-buffer");
  const stagedEdit = await stagerMod.stageInputMedia(
    { references: [localRef] },
    stagerMod.createStagingResolver("image-edit", azureBinding, azureProvider),
    credentials,
  );
  ok("multipart-buffer staging yields a buffer", Buffer.isBuffer(stagedEdit.references?.[0]?.buffer));
  ok("multipart-buffer staging carries the fixture bytes", Buffer.compare(stagedEdit.references?.[0]?.buffer ?? Buffer.alloc(0), PNG_BYTES) === 0);
  ok("multipart-buffer staging has no data URL", stagedEdit.references?.[0]?.url === undefined);

  // ── 6. Readiness gates ────────────────────────────────────────────────────
  section("readiness gates");
  const noKey = { providerId: "openrouter", apiKey: null, baseUrl: null, extra: {}, keySource: "none" };
  const withKey = { ...noKey, apiKey: "sk-or-smoke-key", keySource: "db" };
  const savedEnv = process.env[OPENROUTER_KEY_ENV];
  delete process.env[OPENROUTER_KEY_ENV];
  const noKeyResult = orProvider.checkReadiness(noKey, nb2);
  ok("no key → not ready", noKeyResult.ready === false);
  ok("no key → the reason names the API key", /API key/i.test(noKeyResult.reason ?? ""), noKeyResult.reason);
  ok("db key → ready", orProvider.checkReadiness(withKey, nb2).ready === true);
  process.env[OPENROUTER_KEY_ENV] = "sk-or-env-key";
  const envResult = orProvider.checkReadiness(noKey, nb2);
  ok("keyEnv fallback → ready", envResult.ready === true, envResult.reason);
  if (savedEnv === undefined) delete process.env[OPENROUTER_KEY_ENV];
  else process.env[OPENROUTER_KEY_ENV] = savedEnv;
  const noBase = orProvider.checkReadiness(withKey, { ...nb2, baseUrl: undefined });
  ok("key but no base URL → not ready", noBase.ready === false);
  ok("no base URL → the reason names the base URL", /base URL/i.test(noBase.reason ?? ""), noBase.reason);

  // ── 7. Param presets (compat-plan §c) ─────────────────────────────────────
  section("param presets");
  const guestDb = await import(pathToFileURL(join(ROOT, "lib/guest/db.ts")).href);
  const registryMod = await import(pathToFileURL(join(ROOT, "lib/providers/registry.ts")).href);
  const presetsMod = await import(pathToFileURL(join(ROOT, "lib/providers/presets.ts")).href);

  const seeded = guestDb.getParamPresets();
  eq("4 param presets are seeded", seeded.length, 4);
  eq(
    "the seeded preset ids",
    seeded.map((p) => p.presetId),
    ["image-edit", "openrouter-dialect", "pollinations-sync", "standard-image"],
  );
  eq("the openrouter-dialect preset family", seeded.find((p) => p.presetId === "openrouter-dialect")?.family, "openrouter");
  eq("the standard-image preset family", seeded.find((p) => p.presetId === "standard-image")?.family, "standard");
  const polPreset = seeded.find((p) => p.presetId === "pollinations-sync");
  eq("the pollinations-sync preset family", polPreset?.family, "pollinations");
  eq("the pollinations-sync preset maps the pixel width", polPreset?.params?.fields?.width, "width");
  eq("the pollinations-sync preset maps the pixel height", polPreset?.params?.fields?.height, "height");
  eq("the pollinations-sync preset maps the references", polPreset?.params?.fields?.image, "references");
  ok("the pollinations-sync preset does NOT map the 'WxH' size", polPreset?.params?.fields?.size === undefined);
  ok("a seeded preset carries its params", Object.keys(seeded.find((p) => p.presetId === "standard-image")?.params ?? {}).length > 0);
  ok("the preset ids are unique", new Set(seeded.map((p) => p.presetId)).size === seeded.length);

  // A malformed seed/row must fail loudly, never silently.
  let parseError = null;
  try {
    presetsMod.parseParamPresetParams("broken", "{ not json");
  } catch (err) {
    parseError = err;
  }
  ok("malformed preset JSON throws", !!parseError);
  let unknownKeyError = null;
  try {
    presetsMod.parseParamPresetParams("typo", JSON.stringify({ fieldz: { prompt: "prompt" } }));
  } catch (err) {
    unknownKeyError = err;
  }
  ok("an unknown preset key throws (typo guard)", /unknown param key/.test(unknownKeyError?.message ?? ""));

  // Re-opening the DB must not duplicate the seeded rows (idempotent seeding).
  const freshSqlite = await import(pathToFileURL(join(ROOT, "lib/guest/sqlite.ts")).href + "?reopen=1");
  const reopened = freshSqlite.db().prepare("SELECT preset_id, COUNT(*) AS c FROM param_presets GROUP BY preset_id").all();
  eq("re-opening the DB keeps one row per preset", reopened.length, 4);
  ok("re-opening the DB does not duplicate the seeds", reopened.every((r) => r.c === 1), JSON.stringify(reopened));

  // Resolution order: preset params ← binding.paramMap ← custom override.
  // The layers must be checked on CONFLICTING keys — a per-key merge of
  // disjoint keys looks the same in any order.
  const presetRow = {
    modelId: "nano-banana-2",
    providerId: "openrouter",
    binding: {
      upstreamModelId: "google/gemini-nano-banana-2.1",
      preset: "standard-image",
      paramMap: { fields: { custom_body_key: "seed" } },
    },
  };
  const resolved = registryMod.resolveForModel("nano-banana-2", "openrouter", [presetRow]);
  eq("the resolved binding carries the preset id", resolved.binding.presetId, "standard-image");
  ok("the resolved binding has no preset error", !resolved.binding.presetError);
  eq("the preset contributes its fields", resolved.binding.paramMap.fields.size, "size");
  eq("the binding's own fields win over the preset", resolved.binding.paramMap.fields.aspect_ratio, "aspectRatio");
  eq("the custom override wins over both", resolved.binding.paramMap.fields.custom_body_key, "seed");
  eq(
    "the binding's value map wins over the preset's",
    resolved.binding.paramMap.valueMaps.resolution,
    { "1k": "1K", "2k": "2K", "4k": "4K" },
  );

  // Conflict on the SAME key — the binding's mapping must win over the preset's
  // (the standard-image preset maps `quality` → "quality"; the gpt-image-2
  // OpenRouter binding maps it → "tier").
  const gpt2Resolved = registryMod.resolveForModel("gpt-image-2", "openrouter", [
    {
      modelId: "gpt-image-2",
      providerId: "openrouter",
      binding: { upstreamModelId: "openai/gpt-image-2", preset: "standard-image" },
    },
  ]);
  eq(
    "on a conflicting key the binding's mapping wins over the preset's",
    gpt2Resolved.binding.paramMap.fields.quality,
    "tier",
  );
  eq(
    "the preset still contributes the keys the binding does not declare",
    gpt2Resolved.binding.paramMap.fields.size,
    "size",
  );

  // Conflict on the SAME key — the custom override wins over BOTH.
  const overrideResolved = registryMod.resolveForModel("nano-banana-2", "openrouter", [
    {
      modelId: "nano-banana-2",
      providerId: "openrouter",
      binding: {
        upstreamModelId: "google/gemini-nano-banana-2.1",
        preset: "standard-image",
        paramMap: { fields: { size: "resolution" } },
      },
    },
  ]);
  eq(
    "on a conflicting key the custom override wins over the preset",
    overrideResolved.binding.paramMap.fields.size,
    "resolution",
  );

  // The merge helper itself — later layers win, records merge per key.
  eq(
    "mergeParamMaps: the last layer wins on a conflict",
    presetsMod.mergeParamMaps({ fields: { a: "prompt" } }, { fields: { a: "quality" } }),
    { fields: { a: "quality" } },
  );
  eq(
    "mergeParamMaps: records merge per key",
    presetsMod.mergeParamMaps({ fields: { a: "prompt", b: "seed" } }, { fields: { b: "quality" } }),
    { fields: { a: "prompt", b: "quality" } },
  );

  // A binding WITHOUT a preset behaves exactly as before (no preset layer).
  const plain = registryMod.resolveForModel("nano-banana-2", "openrouter", []);
  eq("no preset → the binding's own paramMap is untouched", plain.binding.paramMap, nb2.paramMap);
  ok("no preset → no preset id on the binding", plain.binding.presetId === undefined);

  // An unknown preset id must fail loudly (never a silent fallback).
  const badPreset = registryMod.resolveForModel("nano-banana-2", "openrouter", [
    {
      modelId: "nano-banana-2",
      providerId: "openrouter",
      binding: { upstreamModelId: "google/gemini-nano-banana-2.1", preset: "does-not-exist" },
    },
  ]);
  ok("an unknown preset id is reported on the binding", /Unknown param preset/.test(badPreset.binding.presetError ?? ""));
  ok("the reported error names the preset", /does-not-exist/.test(badPreset.binding.presetError ?? ""));
  let presetFailure = null;
  try {
    await quiet(() => orProvider.submit({ ...baseInput, binding: badPreset.binding }));
  } catch (err) {
    presetFailure = err;
  }
  ok("an unknown preset id fails the submit (settled job error)", !!presetFailure);
  ok("the failure message is the clear one", /does-not-exist/.test(presetFailure?.message ?? ""));

  // ── 8. Settings endpoint ──────────────────────────────────────────────────
  section("GET /api/settings/providers");
  // The key comes from the env fallback (the compat family's per-backend
  // `keyEnv`) — the DB row path is the same code path with `keySource: "db"`.
  const savedRouteKey = process.env[OPENROUTER_KEY_ENV];
  process.env[OPENROUTER_KEY_ENV] = "sk-or-env-key";
  const route = await import(pathToFileURL(join(ROOT, "app/api/settings/providers/route.ts")).href);
  const res = await route.GET();
  if (savedRouteKey === undefined) delete process.env[OPENROUTER_KEY_ENV];
  else process.env[OPENROUTER_KEY_ENV] = savedRouteKey;
  eq("GET returns 200", res.status, 200);
  const payload = await res.json();
  const orEntry = payload.providers?.openrouter;
  ok("the response carries an openrouter entry", !!orEntry);
  eq("openrouter label", orEntry?.label, "OpenRouter");
  eq("openrouter base URL", orEntry?.baseUrl, OPENROUTER_BASE_URL);
  eq("openrouter key source (env fallback)", orEntry?.keySource, "env");
  eq("openrouter hasKey (env fallback)", orEntry?.hasKey, true);
  eq("openrouter ready (key present)", orEntry?.ready, true);
  ok("bindingsByModel unions openrouter for nano-banana-2", (payload.bindingsByModel?.["nano-banana-2"] ?? []).includes("openrouter"));
  ok("bindingsByModel unions openrouter for gpt-image-2", (payload.bindingsByModel?.["gpt-image-2"] ?? []).includes("openrouter"));

  // The preset list — the picker's data source (ids + family, no secrets).
  ok("the response carries the preset list", Array.isArray(payload.presets));
  eq("the response lists 4 presets", payload.presets?.length, 4);
  ok(
    "the preset list carries ids + family",
    (payload.presets ?? []).every((p) => typeof p.id === "string" && typeof p.family === "string"),
  );
  ok("the response carries no api keys", !JSON.stringify(payload).includes("sk-or-env-key"));

  // PUT accepts the preset id; an unknown one is rejected (400).
  const putOk = await route.PUT({
    json: async () => ({ providerId: "openai-compat", presetId: "standard-image" }),
  });
  eq("PUT with a known presetId returns 200", putOk.status, 200);
  const putBad = await route.PUT({
    json: async () => ({ providerId: "openai-compat", presetId: "nope" }),
  });
  eq("PUT with an unknown presetId returns 400", putBad.status, 400);
  const afterPut = await (await route.GET()).json();
  eq("the provider reports its preset", afterPut.providers?.["openai-compat"]?.presetId, "standard-image");

  // ── 9. Pollinations (the family's second backend) ─────────────────────────
  section("Pollinations sync leg");
  const polProvider = bootstrap.get("pollinations");
  ok("pollinations backend alias is registered", !!polProvider);
  eq("pollinations alias keeps the BACKEND id", polProvider?.id, "pollinations");
  eq("pollinations submits synchronously", polProvider?.capabilities?.syncSubmission, true);
  eq("the family's poll implementation is shared", polProvider?.capabilities?.polling, true);
  eq("pollinations implements the media-upload hook", polProvider?.capabilities?.mediaUpload, true);
  ok("pollinations exposes uploadMedia", typeof polProvider?.uploadMedia === "function");

  const polBindings = BUILT_IN_BINDINGS.filter((b) => b.providerId === "pollinations");
  eq("11 Pollinations image bindings are code-defined", polBindings.length, 11);
  const polRepresentative = getPollinationsBinding();
  ok("a representative Pollinations binding resolves", !!polRepresentative);
  eq("the representative binding is a Pollinations one", polRepresentative?.providerId, "pollinations");
  eq("the representative binding carries the base URL", polRepresentative?.baseUrl, POLLINATIONS_BASE_URL);
  eq("the representative binding carries the key env", polRepresentative?.keyEnv, POLLINATIONS_KEY_ENV);
  eq("the representative binding stages as remote-url", polRepresentative?.mediaStaging, "remote-url");
  eq("the representative binding names the media store", polRepresentative?.mediaUpload?.url, POLLINATIONS_MEDIA_UPLOAD_URL);

  // The exact upstream ids of the binding-availability spike (2026-10-20).
  const POL_UPSTREAM = {
    "google-nano-banana": "google/gemini-2.5-flash-image",
    "nano-banana-2": "google/gemini-3.1-flash-image",
    "nano-banana-pro": "google/gemini-3-pro-image",
    "nano-banana-2-lite": "google/gemini-3.1-flash-lite-image",
    "z-image": "tongyi-mai/z-image-turbo",
    "seedream-5-lite": "bytedance/seedream-5.0-lite",
    "seedream-5-pro": "bytedance/seedream-5.0-pro",
    "grok-imagine-image": "x-ai/grok-imagine-image",
    "gpt-image-2": "openai/gpt-image-2",
    "gpt-image-2-5-flare": "openai/gpt-image-2.5-flare",
    "gpt-image-2-5-sunburst": "openai/gpt-image-2.5-sunburst",
  };
  for (const [modelId, upstreamId] of Object.entries(POL_UPSTREAM)) {
    const b = polBindings.find((x) => x.modelId === modelId);
    ok(`${modelId} has a Pollinations binding`, !!b);
    eq(`${modelId} upstream id (spike)`, b?.upstreamModelId, upstreamId);
    eq(`${modelId} base URL`, b?.baseUrl, POLLINATIONS_BASE_URL);
    eq(`${modelId} endpoint path`, b?.pathOverride, "/v1/images/generations");
    eq(`${modelId} key env`, b?.keyEnv, POLLINATIONS_KEY_ENV);
    eq(`${modelId} stages as remote-url`, b?.mediaStaging, "remote-url");
    eq(`${modelId} names the media store`, b?.mediaUpload?.url, POLLINATIONS_MEDIA_UPLOAD_URL);
  }
  const polZImage = polBindings.find((b) => b.modelId === "z-image");
  eq("z-image is text-only upstream (no reference field)", polZImage?.paramMap?.fields?.image, undefined);
  eq("z-image declares a zero reference cap", polZImage?.paramMap?.maxReferences, 0);
  const polGrok = polBindings.find((b) => b.modelId === "grok-imagine-image");
  eq("grok-imagine-image keeps Pollinations' 5-ref cap", polGrok?.paramMap?.maxReferences, 5);
  ok("provider union of z-image includes pollinations", getAvailableProvidersForModel("z-image").includes("pollinations"));
  ok("provider union of nano-banana-2 keeps openrouter + pollinations", ["openrouter", "pollinations"].every((id) => getAvailableProvidersForModel("nano-banana-2").includes(id)));

  // ── Request body (stubbed fetch) ──────────────────────────────────────────
  section("Pollinations request body (stubbed fetch)");
  const polModel = modelConfig.IMAGE_MODELS.find((m) => m.id === "nano-banana-2");
  ok("nano-banana-2 is in the image catalog", !!polModel);
  const polBinding = polBindings.find((b) => b.modelId === "nano-banana-2");
  const polCredentials = {
    providerId: "pollinations",
    apiKey: "sk-pol-smoke-key",
    baseUrl: null,
    extra: {},
    keySource: "db",
  };
  const POL_REF_URL = "https://media.pollinations.ai/media/ref-a.png";
  const polInput = {
    taskId: "smoke-task-pol-1",
    kind: "image",
    model: polModel,
    binding: polBinding,
    prompt: "a lighthouse in a storm",
    params: { aspectRatio: "16:9", quality: "2k", customWidth: 1024, customHeight: 768, seed: 42 },
    media: {
      references: [
        {
          originalUrl: POL_REF_URL,
          kind: "image",
          strategy: "remote-url",
          url: POL_REF_URL,
          mimeType: "image/png",
        },
      ],
    },
    credentials: polCredentials,
  };

  capturedCalls.length = 0;
  stubbedResponse = () => fakeResponse({ data: [{ b64_json: PNG_BYTES.toString("base64") }] });
  const polOutcome = await quiet(() => polProvider.submit(polInput));
  eq("exactly one upstream request", capturedCalls.length, 1);
  const polCall = capturedCalls[0] ?? { url: "", init: {} };
  eq("request URL (base + the OpenAI-compatible path)", polCall.url, `${POLLINATIONS_BASE_URL}/v1/images/generations`);
  eq("request method", polCall.init?.method, "POST");
  eq("authorization header", polCall.init?.headers?.Authorization, "Bearer sk-pol-smoke-key");
  const polBody = JSON.parse(String(polCall.init?.body ?? "{}"));
  eq("body model (upstream id)", polBody.model, "google/gemini-3.1-flash-image");
  eq("body prompt", polBody.prompt, polInput.prompt);
  eq("body width (from customWidth)", polBody.width, 1024);
  eq("body height (from customHeight)", polBody.height, 768);
  eq("body seed", polBody.seed, 42);
  eq("body image (the staged reference urls)", polBody.image, [POL_REF_URL]);
  ok("the aspect ratio is NOT sent (Pollinations has no aspect field)", polBody.aspect_ratio === undefined);
  ok("the quality tier is NOT sent (Pollinations has no quality field)", polBody.quality === undefined);
  ok("the 'WxH' size field is NOT sent", polBody.size === undefined);
  eq("submit resolves synchronously", polOutcome.mode, "sync");
  eq("b64_json → one raw buffer", polOutcome.rawBuffers?.length, 1);

  // The reference cap of the binding applies to the image array too.
  capturedCalls.length = 0;
  const manyPolRefs = Array.from({ length: 20 }, (_, i) => ({
    originalUrl: `https://media.pollinations.ai/media/ref-${i}.png`,
    kind: "image",
    strategy: "remote-url",
    url: `https://media.pollinations.ai/media/ref-${i}.png`,
  }));
  await quiet(() => polProvider.submit({ ...polInput, media: { references: manyPolRefs } }));
  const cappedPolBody = JSON.parse(String(capturedCalls[0]?.init?.body ?? "{}"));
  eq("upstream reference cap applied (14)", cappedPolBody.image?.length, 14);

  // ── Media upload (the "remote-url" strategy) ──────────────────────────────
  section("Pollinations media upload (remote-url staging)");
  const uploadFixture = join(SMOKE_DIR, "ref-upload.png");
  await writeFile(uploadFixture, PNG_BYTES);
  capturedCalls.length = 0;
  stubbedResponse = () => fakeResponse({ url: "https://media.pollinations.ai/media/uploaded-1.png" });
  const uploadedUrl = await quiet(() =>
    polProvider.uploadMedia("/generated/ref-upload.png", "image/png", polCredentials, polBinding),
  );
  eq("the upload posts to the binding's media store", capturedCalls[0]?.url, POLLINATIONS_MEDIA_UPLOAD_URL);
  eq("the upload method", capturedCalls[0]?.init?.method, "POST");
  eq("the upload carries the key", capturedCalls[0]?.init?.headers?.Authorization, "Bearer sk-pol-smoke-key");
  const uploadForm = capturedCalls[0]?.init?.body;
  ok("the upload body is multipart", typeof FormData !== "undefined" && uploadForm instanceof FormData);
  const uploadedPart = uploadForm?.get?.("file");
  ok("the upload carries the file part", !!uploadedPart);
  eq("the uploaded bytes are the fixture", uploadedPart?.size, PNG_BYTES.length);
  eq("the upload returns the stored url", uploadedUrl, "https://media.pollinations.ai/media/uploaded-1.png");

  // A binding without an upload endpoint must fail LOUDLY (never silently
  // drop the reference).
  let uploadError = null;
  try {
    await quiet(() =>
      polProvider.uploadMedia("/generated/ref-upload.png", "image/png", polCredentials, {
        ...polBinding,
        mediaUpload: undefined,
      }),
    );
  } catch (err) {
    uploadError = err;
  }
  ok("a binding without an upload endpoint throws", !!uploadError);
  ok("the error names the missing endpoint", /media-upload endpoint/.test(uploadError?.message ?? ""), uploadError?.message);

  // The stager routes a local reference through the upload hook.
  capturedCalls.length = 0;
  stubbedResponse = () => fakeResponse({ url: "https://media.pollinations.ai/media/uploaded-2.png" });
  eq(
    "the Pollinations binding resolves to remote-url",
    typesMod.resolveMediaStagingStrategy("image-edit", polBinding, polProvider.mediaStaging),
    "remote-url",
  );
  const polStaged = await stagerMod.stageInputMedia(
    { references: ["/generated/ref-upload.png"] },
    stagerMod.createStagingResolver("image-edit", polBinding, polProvider),
    polCredentials,
  );
  eq("the local reference was uploaded", capturedCalls.length, 1);
  eq("the upload went to the media store", capturedCalls[0]?.url, POLLINATIONS_MEDIA_UPLOAD_URL);
  eq("the staged reference carries the uploaded url", polStaged.references?.[0]?.url, "https://media.pollinations.ai/media/uploaded-2.png");
  eq("the staged strategy", polStaged.references?.[0]?.strategy, "remote-url");
  eq("the staged originalUrl is never rewritten", polStaged.references?.[0]?.originalUrl, "/generated/ref-upload.png");

  // ── Settings endpoint (the Pollinations backend) ──────────────────────────
  section("GET /api/settings/providers (pollinations)");
  const savedPolKey = process.env[POLLINATIONS_KEY_ENV];
  process.env[POLLINATIONS_KEY_ENV] = "sk-pol-env-key";
  const polPayload = await (await route.GET()).json();
  if (savedPolKey === undefined) delete process.env[POLLINATIONS_KEY_ENV];
  else process.env[POLLINATIONS_KEY_ENV] = savedPolKey;
  const polEntry = polPayload.providers?.pollinations;
  ok("the response carries a pollinations entry", !!polEntry);
  eq("pollinations label", polEntry?.label, "Pollinations");
  eq("pollinations base URL", polEntry?.baseUrl, POLLINATIONS_BASE_URL);
  eq("pollinations key source (env fallback)", polEntry?.keySource, "env");
  eq("pollinations hasKey (env fallback)", polEntry?.hasKey, true);
  eq("pollinations ready (key present)", polEntry?.ready, true);
  ok("bindingsByModel unions pollinations for z-image", (polPayload.bindingsByModel?.["z-image"] ?? []).includes("pollinations"));
  ok("bindingsByModel unions pollinations for nano-banana-2", (polPayload.bindingsByModel?.["nano-banana-2"] ?? []).includes("pollinations"));
  ok("the response carries no pollinations api key", !JSON.stringify(polPayload).includes("sk-pol-env-key"));

  // ── Client surface (source-level: the client bundle pulls React/zustand) ──
  section("client surface (source-level)");
  const clientProviders = await readFile(join(ROOT, "lib/providers.ts"), "utf8");
  ok("client PROVIDERS lists openrouter", /id:\s*"openrouter"/.test(clientProviders));
  ok("client PROVIDERS labels it OpenRouter", /id:\s*"openrouter",\s*label:\s*"OpenRouter"/.test(clientProviders));
  ok("client PROVIDERS lists pollinations", /id:\s*"pollinations"/.test(clientProviders));
  ok("client PROVIDERS labels it Pollinations", /id:\s*"pollinations",\s*label:\s*"Pollinations"/.test(clientProviders));
  const clientIcon = await readFile(join(ROOT, "components/ui/ProviderIcon.tsx"), "utf8");
  ok("ProviderBrandIcon has an openrouter mark", /id === "openrouter"/.test(clientIcon));
  ok("ProviderBrandIcon has a pollinations mark", /id === "pollinations"/.test(clientIcon));
  ok("no client PROVIDERS.find() non-null assertion is left", !/PROVIDERS\.find\([^)]*\)!/.test(await readFile(join(ROOT, "components/SettingsModal.tsx"), "utf8")));

  // ── 10. Job trail + bounded retry (stubbed fetch) ─────────────────────────
  section("job trail + bounded retry");
  const jobLogMod = await import(pathToFileURL(join(ROOT, "lib/jobLog.ts")).href);
  const jobStoreMod = await import(pathToFileURL(join(ROOT, "lib/jobStore.ts")).href);

  // The trail is append-only and CAPPED (the last 50 entries survive).
  const capId = "smoke-trail-cap";
  for (let i = 0; i < 60; i += 1) {
    jobStoreMod.jobStore.appendTrail(capId, { t: Date.now() + i, phase: "poll", detail: `entry ${i}` });
  }
  const capped = jobStoreMod.jobStore.getTrail(capId);
  eq("the trail is capped at 50 entries", capped.length, 50);
  eq("the trail keeps the NEWEST entry", capped[capped.length - 1]?.detail, "entry 59");
  eq("the trail drops the oldest entries", capped[0]?.detail, "entry 10");

  // The trail survives the status write the settle funnel does.
  jobStoreMod.jobStore.set(capId, { status: "done", imageUrl: "/generated/x.png" });
  eq("the trail survives a status write", jobStoreMod.jobStore.getTrail(capId).length, 50);
  eq("the status write keeps the record's status", jobStoreMod.jobStore.get(capId)?.status, "done");

  // Redaction — no key, no data: payload, no URL userinfo, no long blob.
  const secret = "sk-or-super-secret-key";
  const redacted = jobLogMod.redactLogText(
    `key=${secret} payload=data:image/png;base64,AAAABBBBCCCCDDDD host=https://${secret}@example.com/x`,
  );
  ok("the api key is redacted", !redacted.includes(secret), redacted);
  ok("the data: payload is redacted", !redacted.includes("base64,AAAABBBBCCCCDDDD"), redacted);
  ok("the url userinfo is redacted", !redacted.includes(`${secret}@`), redacted);
  eq("the host survives the redaction", jobLogMod.urlHost("https://api.openrouter.ai/api/v1/images"), "api.openrouter.ai");
  eq("a url with a key yields only its host", jobLogMod.urlHost(`https://${secret}@api.openrouter.ai/x`), "api.openrouter.ai");

  // A NETWORK-level failure (DNS) is retried exactly ONCE.
  const retryId = "smoke-retry-once";
  let netCalls = 0;
  globalThis.fetch = async () => {
    netCalls += 1;
    const err = new TypeError("fetch failed");
    err.cause = { code: "ENOTFOUND" };
    throw err;
  };
  let netError = null;
  try {
    await quiet(() => orProvider.submit({ ...baseInput, taskId: retryId }));
  } catch (err) {
    netError = err;
  }
  eq("a network failure is retried exactly once (2 attempts)", netCalls, 2);
  ok("the network failure surfaces as an error", !!netError);
  const retryTrail = jobStoreMod.jobStore.getTrail(retryId);
  ok("the trail records the retry", retryTrail.some((e) => e.phase === "retry"));
  ok("the trail records the attempt", retryTrail.some((e) => e.phase === "submit" && /attempt 1/.test(e.detail)));
  ok("the trail never carries the api key", !JSON.stringify(retryTrail).includes("sk-or-smoke-key"));
  ok("the trail never carries the full request body", !JSON.stringify(retryTrail).includes(baseInput.prompt));

  // An HTTP 5xx is NOT retried — the request reached the server.
  let httpCalls = 0;
  globalThis.fetch = async () => {
    httpCalls += 1;
    return fakeResponse({ error: "boom" }, { ok: false, status: 500 });
  };
  let httpError = null;
  try {
    await quiet(() => orProvider.submit({ ...baseInput, taskId: "smoke-no-retry-500" }));
  } catch (err) {
    httpError = err;
  }
  eq("an HTTP 5xx is NOT retried (1 attempt)", httpCalls, 1);
  ok("the HTTP error surfaces", !!httpError);

  // Restore the fixture's stub for the (optional) live step.
  globalThis.fetch = installedFetch;

  // ── 11. The run-log read API ───────────────────────────────────────────────
  section("GET /api/jobs/[taskId]/log");
  const logRoute = await import(pathToFileURL(join(ROOT, "app/api/jobs/[taskId]/log/route.ts")).href);
  const apiTaskId = "smoke-log-task";
  jobStoreMod.jobStore.set(apiTaskId, { status: "pending", type: "image", providerId: "openrouter" });
  jobStoreMod.jobStore.appendTrail(apiTaskId, { t: Date.now(), phase: "submit", detail: "task pre-minted" });

  const knownRes = await logRoute.GET(new Request("http://local/api/jobs/x/log"), {
    params: Promise.resolve({ taskId: apiTaskId }),
  });
  eq("the log route answers 200", knownRes.status, 200);
  const knownPayload = await knownRes.json();
  eq("the log route echoes the taskId", knownPayload.taskId, apiTaskId);
  eq("the log route reports the status", knownPayload.status, "pending");
  eq("the log route reports the provider", knownPayload.providerId, "openrouter");
  eq("the log route returns the trail", knownPayload.trail?.length, 1);
  eq("the trail entry keeps its phase", knownPayload.trail?.[0]?.phase, "submit");

  // An unknown id must NOT 500 — it answers with a clear empty shape.
  const unknownRes = await logRoute.GET(new Request("http://local/api/jobs/x/log"), {
    params: Promise.resolve({ taskId: "smoke-unknown-task" }),
  });
  eq("an unknown task answers 200 (never 500)", unknownRes.status, 200);
  const unknownPayload = await unknownRes.json();
  eq("an unknown task reports not_found", unknownPayload.status, "not_found");
  eq("an unknown task has an empty trail", unknownPayload.trail?.length, 0);
  eq("an unknown task has no provider", unknownPayload.providerId, null);

  // ── 12. The VIDEO lane (the family's async leg) ───────────────────────────
  section("OpenRouter video bindings");
  const OR_VIDEO_UPSTREAM = {
    "veo3_lite": ["google/veo-3.1-lite"],
    "grok-imagine-1-5-preview": ["x-ai/grok-imagine-video-1.5", "x-ai/grok-imagine-video-1.5-lite"],
    "kling-3.0": ["kwaiv/kling-3.0-pro", "kwaiv/kling-3.0-std"],
    "seedance-2-fast": ["bytedance/seedance-2.0-fast"],
    "seedance-2-mini": ["bytedance/seedance-2.0-mini"],
    "minimax-h3": ["minimax/hailuo-3", "minimax/hailuo-3-max"],
    "wan-2.6": ["alibaba/wan-2.6"],
    "flux-video-edit": ["black-forest-labs/flux-video-edit"],
    "flux-video-upscale": ["black-forest-labs/flux-video-upscale"],
  };
  const orVideoBindings = BUILT_IN_BINDINGS.filter(
    (b) => b.providerId === "openrouter" && b.pathOverride === OPENROUTER_VIDEO_PATH,
  );
  eq("12 OpenRouter video bindings are code-defined", orVideoBindings.length, 12);
  for (const [modelId, ids] of Object.entries(OR_VIDEO_UPSTREAM)) {
    const bound = orVideoBindings
      .filter((b) => b.modelId === modelId)
      .map((b) => b.upstreamModelId)
      .sort();
    eq(`${modelId} upstream id(s)`, bound, [...ids].sort());
  }
  for (const b of orVideoBindings) {
    eq(`${b.upstreamModelId} base URL`, b.baseUrl, OPENROUTER_BASE_URL);
    eq(`${b.upstreamModelId} endpoint path`, b.pathOverride, OPENROUTER_VIDEO_PATH);
    eq(`${b.upstreamModelId} key env`, b.keyEnv, OPENROUTER_KEY_ENV);
    eq(`${b.upstreamModelId} stages as remote-url`, b.mediaStaging, "remote-url");
    eq(`${b.upstreamModelId} is not the kie family`, b.family, "standard");
  }

  // The catalog entries added by the sweep — their Kie binding auto-derives.
  for (const id of ["wan-2.6", "flux-video-edit", "flux-video-upscale"]) {
    ok(`${id} is in the video catalog`, !!modelConfig.VIDEO_MODELS.find((m) => m.id === id));
    let defaultBinding = null;
    try {
      defaultBinding = getDefaultBinding(id);
    } catch {
      defaultBinding = null;
    }
    ok(`${id} resolves a default (kie) binding`, !!defaultBinding, "getDefaultBinding threw");
    eq(`${id} default binding is kie`, defaultBinding?.providerId, "kie");
    ok(`${id} provider union includes openrouter`, getAvailableProvidersForModel(id).includes("openrouter"));
  }
  const wanResolved = registryMod.resolveForModel("wan-2.6", "openrouter", []);
  eq("resolveForModel picks the OpenRouter video binding", wanResolved.binding.upstreamModelId, "alibaba/wan-2.6");
  eq("resolveForModel keeps the video endpoint path", wanResolved.binding.pathOverride, OPENROUTER_VIDEO_PATH);

  section("OpenRouter video request body (stubbed fetch)");
  const videoCredentials = {
    providerId: "openrouter",
    apiKey: "sk-or-smoke-key",
    baseUrl: null,
    extra: {},
    keySource: "db",
  };
  const remoteMedia = (url, kind) => ({ originalUrl: url, kind, strategy: "remote-url", url });
  const videoModel = modelConfig.VIDEO_MODELS.find((m) => m.id === "seedance-2-mini");
  ok("seedance-2-mini is in the video catalog", !!videoModel);
  const videoBinding = orVideoBindings.find((b) => b.modelId === "seedance-2-mini");
  const videoInput = {
    taskId: "smoke-video-1",
    kind: "video",
    model: videoModel,
    binding: videoBinding,
    prompt: "a paper boat on a rainy street",
    params: { aspectRatio: "16:9", duration: 6, resolution: "720p", sound: false, seed: 42 },
    media: {
      startFrame: remoteMedia("https://example.com/first.png", "image"),
      endFrame: remoteMedia("https://example.com/last.png", "image"),
      references: [remoteMedia("https://example.com/ref.png", "image")],
      audioRefs: [remoteMedia("https://example.com/voice.mp3", "audio")],
    },
    credentials: videoCredentials,
  };

  capturedCalls.length = 0;
  stubbedResponse = () =>
    fakeResponse({ id: "gen-vid-abc", polling_url: "/api/v1/videos/gen-vid-abc", status: "pending" }, { status: 202 });
  const videoOutcome = await quiet(() => orProvider.submit(videoInput));
  eq("the video submit hits the /videos endpoint", capturedCalls[0]?.url, `${OPENROUTER_BASE_URL}/videos`);
  eq("the video submit is a POST", capturedCalls[0]?.init?.method, "POST");
  eq("the video submit carries the key", capturedCalls[0]?.init?.headers?.Authorization, "Bearer sk-or-smoke-key");
  const vBody = JSON.parse(String(capturedCalls[0]?.init?.body ?? "{}"));
  eq("video body model (upstream id)", vBody.model, "bytedance/seedance-2.0-mini");
  eq("video body prompt", vBody.prompt, videoInput.prompt);
  eq("video body duration", vBody.duration, 6);
  eq("video body resolution", vBody.resolution, "720p");
  eq("video body aspect_ratio", vBody.aspect_ratio, "16:9");
  eq("video body seed", vBody.seed, 42);
  eq(
    "video body frame_images (first + last frame)",
    vBody.frame_images,
    [
      { type: "image_url", image_url: { url: "https://example.com/first.png" }, frame_type: "first_frame" },
      { type: "image_url", image_url: { url: "https://example.com/last.png" }, frame_type: "last_frame" },
    ],
  );
  eq(
    "video body input_references (image + audio)",
    vBody.input_references,
    [
      { type: "image_url", image_url: { url: "https://example.com/ref.png" } },
      { type: "audio_url", audio_url: { url: "https://example.com/voice.mp3" } },
    ],
  );
  // seedance declares generate_audio per-model (sound:false retries a clip the
  // upstream audio-copyright policy rejected; a83481e, verified live) — the
  // catalog's sound toggle must ride the body.
  eq("generate_audio rides the declared field (sound:false video-only clip)", vBody.generate_audio, false);
  ok(
    "the video body carries no unexpected field",
    Object.keys(vBody).every((k) =>
      ["model", "prompt", "duration", "resolution", "aspect_ratio", "seed", "generate_audio", "frame_images", "input_references"].includes(k),
    ),
    JSON.stringify(Object.keys(vBody)),
  );
  eq("the video submit is async", videoOutcome.mode, "async");
  eq("the upstream task id", videoOutcome.upstreamTaskId, "gen-vid-abc");
  eq(
    "the relative polling_url is resolved to an absolute status URL",
    videoOutcome.providerMeta?.statusUrl,
    "https://openrouter.ai/api/v1/videos/gen-vid-abc",
  );
  eq("the provider meta keeps the upstream model", videoOutcome.providerMeta?.upstreamModelId, "bytedance/seedance-2.0-mini");

  // The "auto" ratio is not in the upstream enum — it is dropped, never sent.
  capturedCalls.length = 0;
  await quiet(() =>
    orProvider.submit({ ...videoInput, params: { ...videoInput.params, aspectRatio: "auto" } }),
  );
  const autoBody = JSON.parse(String(capturedCalls[0]?.init?.body ?? "{}"));
  ok("the \"auto\" aspect ratio is dropped", autoBody.aspect_ratio === undefined, JSON.stringify(autoBody));

  section("OpenRouter video caps (clamp / drop / default)");
  // The duration is re-clamped to the model's own limits (the catalog offers 4).
  const minimaxBinding = orVideoBindings.find((b) => b.upstreamModelId === "minimax/hailuo-3");
  const minimaxModel = modelConfig.VIDEO_MODELS.find((m) => m.id === "minimax-h3");
  capturedCalls.length = 0;
  await quiet(() =>
    orProvider.submit({
      ...videoInput,
      binding: minimaxBinding,
      model: minimaxModel,
      params: { aspectRatio: "9:16", duration: 4, resolution: "768P", sound: false },
    }),
  );
  const mmBody = JSON.parse(String(capturedCalls[0]?.init?.body ?? "{}"));
  eq("the duration is re-clamped to the model's minimum", mmBody.duration, 5);
  eq("the catalog's 768P maps to the upstream enum", mmBody.resolution, "768p");

  // The catalog's 2K tier is not in the upstream enum — dropped.
  capturedCalls.length = 0;
  await quiet(() =>
    orProvider.submit({
      ...videoInput,
      binding: minimaxBinding,
      model: minimaxModel,
      params: { aspectRatio: "9:16", duration: 8, resolution: "2K", sound: false },
    }),
  );
  const mm2Body = JSON.parse(String(capturedCalls[0]?.init?.body ?? "{}"));
  ok("the unsupported 2K tier is dropped", mm2Body.resolution === undefined, JSON.stringify(mm2Body));

  // The Veo catalog entry has NO duration picker → the binding's own default.
  const veoBinding = orVideoBindings.find((b) => b.upstreamModelId === "google/veo-3.1-lite");
  const veoModel = modelConfig.VIDEO_MODELS.find((m) => m.id === "veo3_lite");
  capturedCalls.length = 0;
  await quiet(() =>
    orProvider.submit({
      ...videoInput,
      binding: veoBinding,
      model: veoModel,
      params: { aspectRatio: "16:9", duration: 0, resolution: "720p", sound: false },
    }),
  );
  const veoBody = JSON.parse(String(capturedCalls[0]?.init?.body ?? "{}"));
  eq("a model without a duration picker sends the binding's default", veoBody.duration, 6);
  eq("the audio flag rides the audio-capable model", veoBody.generate_audio, false);

  // The catalog's 4k tier is not in the upstream enum — dropped.
  capturedCalls.length = 0;
  await quiet(() =>
    orProvider.submit({
      ...videoInput,
      binding: veoBinding,
      model: veoModel,
      params: { aspectRatio: "16:9", duration: 4, resolution: "4k", sound: false },
    }),
  );
  const veo4kBody = JSON.parse(String(capturedCalls[0]?.init?.body ?? "{}"));
  ok("the unsupported 4k tier is dropped", veo4kBody.resolution === undefined, JSON.stringify(veo4kBody));

  // Kling models the quality as a MODE — the resolution is pinned by the binding.
  const klingBinding = orVideoBindings.find((b) => b.upstreamModelId === "kwaiv/kling-3.0-pro");
  const klingModel = modelConfig.VIDEO_MODELS.find((m) => m.id === "kling-3.0");
  capturedCalls.length = 0;
  await quiet(() =>
    orProvider.submit({
      ...videoInput,
      binding: klingBinding,
      model: klingModel,
      params: { aspectRatio: "16:9", duration: 5, resolution: "480p", sound: false, mode: "pro" },
    }),
  );
  const klingBody = JSON.parse(String(capturedCalls[0]?.init?.body ?? "{}"));
  eq("the binding pins the resolution the upstream has", klingBody.resolution, "720p");
  ok("the catalog's mode never rides the body", klingBody.mode === undefined, JSON.stringify(klingBody));

  // Grok 1.5 takes a FIRST FRAME only — the staged reference rides as the frame.
  const grokBinding = orVideoBindings.find((b) => b.upstreamModelId === "x-ai/grok-imagine-video-1.5");
  const grokModel = modelConfig.VIDEO_MODELS.find((m) => m.id === "grok-imagine-1-5-preview");
  capturedCalls.length = 0;
  await quiet(() =>
    orProvider.submit({
      ...videoInput,
      binding: grokBinding,
      model: grokModel,
      media: { references: [remoteMedia("https://example.com/ref.png", "image")] },
      params: { aspectRatio: "16:9", duration: 8, resolution: "480p", sound: false },
    }),
  );
  const grokBody = JSON.parse(String(capturedCalls[0]?.init?.body ?? "{}"));
  eq(
    "the reference rides as the first frame",
    grokBody.frame_images,
    [{ type: "image_url", image_url: { url: "https://example.com/ref.png" }, frame_type: "first_frame" }],
  );
  ok("the reference is not sent twice", grokBody.input_references === undefined, JSON.stringify(grokBody));

  section("OpenRouter video polling");
  const pollMeta = {
    upstreamTaskId: "gen-vid-abc",
    family: "standard",
    statusUrl: "https://openrouter.ai/api/v1/videos/gen-vid-abc",
    upstreamModelId: "bytedance/seedance-2.0-mini",
  };
  capturedCalls.length = 0;
  for (const status of ["pending", "in_progress"]) {
    stubbedResponse = () => fakeResponse({ id: "gen-vid-abc", status });
    const outcome = await orProvider.poll("gen-vid-abc", "video", videoCredentials, pollMeta);
    eq(`${status} → pending`, outcome.state, "pending");
  }
  eq("the poll hits the status URL", capturedCalls[0]?.url, "https://openrouter.ai/api/v1/videos/gen-vid-abc");
  eq("the poll carries the key", capturedCalls[0]?.init?.headers?.Authorization, "Bearer sk-or-smoke-key");

  // Completed → the bytes are fetched from the (authenticated) content endpoint.
  const MP4_BYTES = Buffer.from("00000018667479706d70343200000000", "hex");
  capturedCalls.length = 0;
  stubbedResponse = (url) =>
    String(url).includes("/content")
      ? fakeResponse(null, { bytes: MP4_BYTES, contentType: "video/mp4" })
      : fakeResponse({
          id: "gen-vid-abc",
          status: "completed",
          urls: ["https://cdn.example.com/signed.mp4"],
          unsigned_urls: ["https://openrouter.ai/api/v1/videos/gen-vid-abc/content?index=0"],
        });
  const doneOutcome = await orProvider.poll("gen-vid-abc", "video", videoCredentials, pollMeta);
  eq("completed → done", doneOutcome.state, "done");
  eq("the finished video is one raw buffer", doneOutcome.buffers?.length, 1);
  eq("the buffer carries the exact bytes", Buffer.compare(doneOutcome.buffers?.[0]?.buffer ?? Buffer.alloc(0), MP4_BYTES), 0);
  eq("the buffer mime type", doneOutcome.buffers?.[0]?.mimeType, "video/mp4");
  ok(
    "the content endpoint is fetched with ?index=0",
    capturedCalls.some((c) => c.url.endsWith("/content?index=0")),
    JSON.stringify(capturedCalls.map((c) => c.url)),
  );
  ok(
    "the content endpoint carries the key",
    capturedCalls.filter((c) => c.url.includes("/content")).every((c) => c.init?.headers?.Authorization === "Bearer sk-or-smoke-key"),
  );

  // A finished task without a reachable content endpoint keeps its URLs.
  capturedCalls.length = 0;
  stubbedResponse = (url) =>
    String(url).includes("/content")
      ? fakeResponse("nope", { ok: false, status: 404 })
      : fakeResponse({
          id: "gen-vid-abc",
          status: "completed",
          urls: ["https://cdn.example.com/signed.mp4"],
          unsigned_urls: ["https://openrouter.ai/api/v1/videos/gen-vid-abc/content?index=0"],
        });
  const videoUrlOutcome = await orProvider.poll("gen-vid-abc", "video", videoCredentials, pollMeta);
  eq("completed (no bytes) → done", videoUrlOutcome.state, "done");
  eq(
    "the fallback returns the upstream urls",
    videoUrlOutcome.mediaUrls,
    ["https://openrouter.ai/api/v1/videos/gen-vid-abc/content?index=0"],
  );

  // The three terminal-failure statuses.
  for (const status of ["failed", "cancelled", "expired"]) {
    stubbedResponse = () => fakeResponse({ id: "gen-vid-abc", status, error: { code: 400, message: "boom" } });
    const outcome = await orProvider.poll("gen-vid-abc", "video", videoCredentials, pollMeta);
    eq(`${status} → error`, outcome.state, "error");
    eq(`${status} carries the job's error string`, outcome.error, "boom");
  }

  // The image leg never polls.
  const imagePoll = await orProvider.poll("smoke-task-1", "image", videoCredentials, pollMeta);
  eq("the image leg refuses to poll", imagePoll.state, "error");

  // ── 13. The route (provider resolution → stage → submitJob → { taskId }) ───
  section("POST /api/generate-video (openrouter)");
  const videoRoute = await import(pathToFileURL(join(ROOT, "app/api/generate-video/route.ts")).href);
  const savedRouteVideoKey = process.env[OPENROUTER_KEY_ENV];
  process.env[OPENROUTER_KEY_ENV] = "sk-or-env-key";
  capturedCalls.length = 0;
  stubbedResponse = () =>
    fakeResponse({ id: "gen-vid-route", polling_url: "/api/v1/videos/gen-vid-route", status: "pending" }, { status: 202 });
  const routeRes = await videoRoute.POST(
    new Request("http://local/api/generate-video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "wan-2.6",
        providerId: "openrouter",
        prompt: "a lighthouse in a storm",
        duration: 5,
        aspect_ratio: "16:9",
      }),
    }),
  );
  if (savedRouteVideoKey === undefined) delete process.env[OPENROUTER_KEY_ENV];
  else process.env[OPENROUTER_KEY_ENV] = savedRouteVideoKey;
  eq("the video route answers 200", routeRes.status, 200);
  const routePayload = await routeRes.json();
  ok("the video route returns a taskId", typeof routePayload.taskId === "string" && routePayload.taskId.length > 0);
  // The upstream submit runs in the background — the route answers first.
  for (let i = 0; i < 50 && !capturedCalls.some((c) => c.url.includes("/videos")); i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const routeCall = capturedCalls.find((c) => c.url.includes("/videos"));
  ok(
    "the route drove the OpenRouter video endpoint",
    !!routeCall,
    JSON.stringify(capturedCalls.map((c) => c.url)),
  );
  eq("the route's upstream URL", routeCall?.url, `${OPENROUTER_BASE_URL}/videos`);
  const routeBody = JSON.parse(String(routeCall?.init?.body ?? "{}"));
  eq("the route's upstream model", routeBody.model, "alibaba/wan-2.6");
  eq("the route's duration", routeBody.duration, 5);
  eq("the route's aspect ratio", routeBody.aspect_ratio, "16:9");
  eq("the route's prompt", routeBody.prompt, "a lighthouse in a storm");

  // ── Live step (opt-in) ────────────────────────────────────────────────────
  section("live step");
  const liveKey = process.env.OPENROUTER_API_KEY;
  if (!liveKey) {
    console.log("  SKIP — no OPENROUTER_API_KEY in the environment (offline fixture stays green).");
  } else if (process.env.HELIOS_SMOKE_LIVE !== "1") {
    console.log("  SKIP — OPENROUTER_API_KEY is set; set HELIOS_SMOKE_LIVE=1 to run the live call.");
  } else {
    restoreFetch();
    capturedCalls.length = 0;
    try {
      const liveOutcome = await orProvider.submit({
        ...baseInput,
        params: { aspectRatio: "1:1" },
        media: {},
        credentials: { ...credentials, apiKey: liveKey, keySource: "env" },
      });
      const gotMedia = (liveOutcome.mediaUrls?.length ?? 0) + (liveOutcome.rawBuffers?.length ?? 0);
      ok("live OpenRouter call returned media", gotMedia > 0);
    } catch (err) {
      ok("live OpenRouter call returned media", false, err?.message ?? String(err));
    }
  }
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
console.log(`✓ smoke-compat: ${passed} assertions passed.`);
process.exit(0);

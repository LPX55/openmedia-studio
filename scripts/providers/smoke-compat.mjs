#!/usr/bin/env node
/**
 * smoke-compat — PERMANENT offline smoke fixture for the openai-compat provider
 * family (Deepwork P6 step 2; compat-plan §e step 2 / §f validation).
 *
 * WHAT IT CHECKS (fully offline — no network, no API key, no build step):
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
 *   7. SETTINGS ENDPOINT — `GET /api/settings/providers` reports the
 *      "openrouter" entry (label, key source, base URL, readiness) and the
 *      per-model provider union.
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

// ── Tiny assertion harness ───────────────────────────────────────────────────
let passed = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) {
    passed++;
    return true;
  }
  failures.push(detail ? `${name} — ${detail}` : name);
  return false;
}

function eq(name, actual, expected) {
  const same = Object.is(actual, expected) ||
    JSON.stringify(actual) === JSON.stringify(expected);
  return ok(
    name,
    same,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function section(title) {
  console.log(`\n▸ ${title}`);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
// 1×1 PNG — a real (tiny) image, so the staging path exercises real bytes.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const REF_URL = "https://example.com/reference-a.png";

/** Minimal `Response`-alike for the stubbed fetch. */
function fakeResponse(payload, { ok = true, status = 200 } = {}) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    ok,
    status,
    text: async () => text,
    headers: { get: () => "application/json" },
  };
}

const realFetch = globalThis.fetch;
const capturedCalls = [];
let stubbedResponse = () => fakeResponse({ data: [] });
globalThis.fetch = async (url, init) => {
  capturedCalls.push({ url: String(url), init });
  return stubbedResponse();
};

/** Swallow the adapter's request log unless HELIOS_SMOKE_VERBOSE=1. */
function quiet(fn) {
  const original = console.log;
  if (process.env.HELIOS_SMOKE_VERBOSE === "1") return fn();
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = original;
  }
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
    OPENROUTER_BASE_URL,
    OPENROUTER_KEY_ENV,
  } = bindingsMod;

  // ── 1. Registry ────────────────────────────────────────────────────────────
  section("registry");
  const orProvider = bootstrap.get("openrouter");
  const familyProvider = bootstrap.get("openai-compat");
  ok("openrouter backend alias is registered", !!orProvider);
  eq("openrouter alias keeps the BACKEND id", orProvider?.id, "openrouter");
  eq("openrouter family adapter is registered", familyProvider?.id, "openai-compat");
  eq("family adapter declares the openrouter alias", [...(familyProvider?.aliases ?? [])], ["openrouter"]);
  eq("openrouter staging default", orProvider?.mediaStaging, "data-url");
  eq("openrouter submits synchronously", orProvider?.capabilities?.syncSubmission, true);
  eq("openrouter has no polling", orProvider?.capabilities?.polling, false);
  eq("openrouter has no media upload", orProvider?.capabilities?.mediaUpload, false);
  ok("openrouter exposes checkReadiness", typeof orProvider?.checkReadiness === "function");
  ok("openrouter exposes submit", typeof orProvider?.submit === "function");

  // ── 2. Bindings ───────────────────────────────────────────────────────────
  section("static OpenRouter bindings");
  const orBindings = BUILT_IN_BINDINGS.filter((b) => b.providerId === "openrouter");
  eq("10 OpenRouter image bindings are code-defined", orBindings.length, 10);
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
  eq("body input_references", body.input_references, [REF_URL]);
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
  eq("the cap keeps the FIRST references", cappedBody.input_references?.[0], "https://example.com/ref-0.png");

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

  // ── 7. Settings endpoint ──────────────────────────────────────────────────
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

  // ── Client surface (source-level: the client bundle pulls React/zustand) ──
  section("client surface (source-level)");
  const clientProviders = await readFile(join(ROOT, "lib/providers.ts"), "utf8");
  ok("client PROVIDERS lists openrouter", /id:\s*"openrouter"/.test(clientProviders));
  ok("client PROVIDERS labels it OpenRouter", /id:\s*"openrouter",\s*label:\s*"OpenRouter"/.test(clientProviders));
  const clientIcon = await readFile(join(ROOT, "components/ui/ProviderIcon.tsx"), "utf8");
  ok("ProviderBrandIcon has an openrouter mark", /id === "openrouter"/.test(clientIcon));
  ok("no client PROVIDERS.find() non-null assertion is left", !/PROVIDERS\.find\([^)]*\)!/.test(await readFile(join(ROOT, "components/SettingsModal.tsx"), "utf8")));

  // ── Live step (opt-in) ────────────────────────────────────────────────────
  section("live step");
  const liveKey = process.env.OPENROUTER_API_KEY;
  if (!liveKey) {
    console.log("  SKIP — no OPENROUTER_API_KEY in the environment (offline fixture stays green).");
  } else if (process.env.HELIOS_SMOKE_LIVE !== "1") {
    console.log("  SKIP — OPENROUTER_API_KEY is set; set HELIOS_SMOKE_LIVE=1 to run the live call.");
  } else {
    globalThis.fetch = realFetch;
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
  globalThis.fetch = realFetch;
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

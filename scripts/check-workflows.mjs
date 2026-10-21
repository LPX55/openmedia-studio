#!/usr/bin/env node
/**
 * check-workflows — offline structural validation for the workflow template pack.
 *
 * The templates in `lib/workflowTemplates.ts` are plain graphs, so the failure
 * mode that matters is a graph that looks fine and cannot run: an edge pointing
 * at a handle the model does not expose, a ratio the model rejects, a duplicate
 * prompt wire, a counter that makes the next added node collide. This script
 * proves those offline — no browser, no network, no build step.
 *
 * Checks per template:
 *   1. registry ids are unique and every graph is non-empty
 *   2. node ids unique; every edge endpoint exists; no self-loops
 *   3. every model id exists in the catalog (image or video)
 *   4. image gens: ratio in model.ratios, quality in the model's options
 *   5. video gens: every incoming handle is in model.handles, ratio in
 *      model.ratios (when the model declares any), duration in model.durations
 *   6. single-slot handles (prompt / startFrame / endFrame) are wired at most once
 *   7. every generator has a prompt source; assistant sources use `textOut`
 *   8. reference inputs carry content (r2Url / videoUrl) and generators start idle
 *   9. nodeCounters equal the real per-type counts
 *
 * Usage:  node scripts/check-workflows.mjs      (or: pnpm check:workflows)
 * Exit:   0 = all templates pass, 1 = at least one failure (printed with ✗).
 */
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

if (!process.execArgv.some((a) => a.startsWith("--disable-warning"))) {
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
}

// Same extensionless + "@/" resolution hook the provider smoke fixture uses.
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
      try { return await nextResolve(candidate, context); }
      catch { /* next candidate */ }
    }
    throw err;
  }
}`;
register("data:text/javascript," + encodeURIComponent(RESOLVE_HOOK));

process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w?.name === "MODULE_TYPELESS_PACKAGE_JSON") return;
  console.warn(`⚠ ${w?.name ?? "Warning"}: ${w?.message ?? String(w)}`);
});

const { IMAGE_MODELS, VIDEO_MODELS } = await import("../lib/modelConfig.ts");
const { WORKFLOW_TEMPLATES } = await import("../lib/workflowTemplates.ts");

let passed = 0;
const failures = [];

function check(ok, label, detail) {
  if (ok) {
    passed++;
    return true;
  }
  failures.push({ label, detail });
  return false;
}

const IMAGE_BY_ID = new Map(IMAGE_MODELS.map((m) => [m.id, m]));
const VIDEO_BY_ID = new Map(VIDEO_MODELS.map((m) => [m.id, m]));

const SINGLE_SLOT = new Set(["prompt", "startFrame", "endFrame"]);

// ── Registry level ───────────────────────────────────────────────────────────
const ids = new Set();
for (const t of WORKFLOW_TEMPLATES) {
  check(typeof t.id === "string" && t.id.length > 0, "template id is a non-empty string");
  check(!ids.has(t.id), `duplicate template id "${t.id}"`, t.id);
  ids.add(t.id);
  check(t.tags.length > 0, `${t.id}: has at least one tag`);
  check(t.preview.length > 0 && t.preview.length <= 4, `${t.id}: 1-4 preview images`);
  check(/^#[0-9a-fA-F]{6}$/.test(t.accent), `${t.id}: accent is a hex color`);
}

// ── Per-template graph ───────────────────────────────────────────────────────
for (const template of WORKFLOW_TEMPLATES) {
  const graph = template.make();
  const { nodes, edges, nodeCounters } = graph;
  const label = template.id;

  check(nodes.length > 0, `${label}: graph has nodes`);
  check(edges.length > 0, `${label}: graph has edges`);

  const nodeIds = new Set();
  for (const n of nodes) {
    check(!nodeIds.has(n.id), `${label}: duplicate node id "${n.id}"`, n.id);
    nodeIds.add(n.id);
    check(typeof n.type === "string" && n.type.length > 0, `${label}: node "${n.id}" has a type`);
    check(!!n.position && Number.isFinite(n.position.x) && Number.isFinite(n.position.y),
      `${label}: node "${n.id}" has a finite position`);
  }

  // Counters
  const actualCounts = {};
  for (const n of nodes) actualCounts[n.type] = (actualCounts[n.type] ?? 0) + 1;
  const counterKeys = new Set([...Object.keys(actualCounts), ...Object.keys(nodeCounters ?? {})]);
  for (const k of counterKeys) {
    check((actualCounts[k] ?? 0) === (nodeCounters?.[k] ?? 0),
      `${label}: nodeCounters["${k}"] matches the graph`,
      `${nodeCounters?.[k] ?? 0} != ${actualCounts[k] ?? 0}`);
  }

  // Edges
  const incoming = new Map();
  for (const e of edges) {
    const src = nodes.find((n) => n.id === e.source);
    const tgt = nodes.find((n) => n.id === e.target);
    check(!!src, `${label}: edge "${e.id}" source "${e.source}" exists`);
    check(!!tgt, `${label}: edge "${e.id}" target "${e.target}" exists`);
    check(e.source !== e.target, `${label}: edge "${e.id}" is not a self-loop`);
    if (!src || !tgt) continue;

    const handle = e.targetHandle ?? "";
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target).push({ handle, source: src });

    if (SINGLE_SLOT.has(handle)) {
      const count = edges.filter((x) => x.target === e.target && (x.targetHandle ?? "") === handle).length;
      check(count === 1, `${label}: "${handle}" on "${e.target}" is wired once`, `${count} edges`);
    }

    if (handle === "prompt") {
      check(src.type === "promptNode" || src.type === "assistantNode",
        `${label}: prompt edge "${e.id}" comes from a text node`, src.type);
      if (src.type === "assistantNode") {
        check(e.sourceHandle === "textOut",
          `${label}: assistant edge "${e.id}" uses the textOut handle`, e.sourceHandle);
      }
    }

    if (handle === "videoRef") {
      check(src.type === "videoInputNode" || src.type === "videoGeneratorNode",
        `${label}: videoRef edge "${e.id}" comes from a video node`, src.type);
    }
  }

  // Node-level semantics
  for (const n of nodes) {
    const data = n.data ?? {};
    const type = n.type;

    if (type === "generateNode") {
      const model = IMAGE_BY_ID.get(String(data.model));
      check(!!model, `${label}: "${n.id}" uses a catalog image model`, String(data.model));
      const promptWired = (incoming.get(n.id) ?? []).some((e) => e.handle === "prompt");
      check(promptWired, `${label}: "${n.id}" has a prompt source`);
      if (model) {
        check(model.ratios.includes(String(data.aspectRatio)),
          `${label}: "${n.id}" ratio "${data.aspectRatio}" is supported by ${model.id}`,
          model.ratios.join(","));
        if (data.quality !== undefined) {
          check(model.supportsQuality, `${label}: "${n.id}" sets quality on a model without quality`);
          const opts = model.apiInput.qualityOptions;
          if (opts) {
            check(opts.includes(String(data.quality)),
              `${label}: "${n.id}" quality "${data.quality}" is offered by ${model.id}`,
              opts.join(","));
          }
        }
      }
      if (!template.legacy) {
        check(data.status !== "done" && data.status !== "running",
          `${label}: "${n.id}" starts idle (templates never claim a result)`);
      }
    }

    if (type === "videoGeneratorNode") {
      const model = VIDEO_BY_ID.get(String(data.videoModel));
      check(!!model, `${label}: "${n.id}" uses a catalog video model`, String(data.videoModel));
      const promptWired = (incoming.get(n.id) ?? []).some((e) => e.handle === "prompt");
      check(promptWired || model?.promptOptional === true,
        `${label}: "${n.id}" has a prompt source`);
      if (model) {
        for (const inc of incoming.get(n.id) ?? []) {
          check(model.handles.includes(inc.handle),
            `${label}: "${n.id}" accepts handle "${inc.handle}" on ${model.id}`,
            model.handles.join(","));
        }
        if (data.aspectRatio !== undefined && model.ratios.length > 0) {
          check(model.ratios.includes(String(data.aspectRatio)),
            `${label}: "${n.id}" ratio "${data.aspectRatio}" is supported by ${model.id}`,
            model.ratios.join(","));
        }
        if (data.duration !== undefined && model.durations.length > 0) {
          check(model.durations.includes(Number(data.duration)),
            `${label}: "${n.id}" duration ${data.duration}s is supported by ${model.id}`,
            model.durations.join(","));
        }
      }
      if (!template.legacy) {
        check(data.status !== "done" && data.status !== "running",
          `${label}: "${n.id}" starts idle`);
      }
    }

    if (type === "imageInputNode") {
      check(!!(data.r2Url || data.inputImage), `${label}: "${n.id}" has a reference image`);
    }
    if (type === "videoInputNode") {
      check(!!data.videoUrl, `${label}: "${n.id}" has a reference video`);
    }
    if (type === "promptNode") {
      check(typeof data.prompt === "string" && data.prompt.trim().length > 0,
        `${label}: "${n.id}" has prompt text`);
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
if (failures.length === 0) {
  console.log(`✓ check-workflows: ${WORKFLOW_TEMPLATES.length} templates, ${passed} assertions passed.`);
  process.exit(0);
}

console.error(`✗ check-workflows: ${failures.length} failure(s), ${passed} assertions passed.`);
for (const f of failures) {
  console.error(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ""}`);
}
process.exit(1);

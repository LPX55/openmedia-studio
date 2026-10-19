import { NextRequest, NextResponse } from "next/server";
import {
  getProviderRuntimeConfig,
  setProviderApiKey,
  clearProviderApiKey,
  setProviderBaseUrl,
  setProviderDeployments,
  getModelPrefs,
  getCustomModelBindings,
  getModelBindingsByModel,
  setModelActiveProvider,
  upsertCustomModelBinding,
  deleteProviderModelBindings,
} from "@/lib/guest/db";
import { IMAGE_MODELS, VIDEO_MODELS } from "@/lib/modelConfig";

/**
 * Phase 3 — unified provider credential/config store (design.md §3.3).
 *
 * GET    → non-secret readiness per provider + modelPrefs + customBindings
 *          (+ bindingsByModel, the C8 per-model provider union: static Kie
 *          default ∪ stored model_bindings rows).
 * PUT    → upsert `{ providerId, apiKey?, baseUrl?, deployments? }` and/or
 *          `{ modelPrefs?, customBindings? }` (persisted into
 *          provider_configs / model_bindings).
 * POST   → alias of PUT (used by the one-time AppSidebar localStorage
 *          migration, C7d).
 * DELETE → `?providerId=` clears the stored DB key for that provider (and its
 *          model_bindings rows). Env fallbacks still apply afterwards; the
 *          cleared key must NOT resurrect on restart (C7a).
 *
 * Secrets never leave this route: GET reports `hasKey`/`keySource` only.
 */

const PROVIDER_CATALOG = [
  { id: "kie",           label: "Kie.ai" },
  { id: "azure",         label: "Azure Foundry" },
  { id: "codex",         label: "Codex CLI" },
  { id: "replicate",     label: "Replicate" },
  { id: "fal",           label: "fal" },
  { id: "openai-compat", label: "OpenAI Compatible" },
] as const;

type ProviderId = (typeof PROVIDER_CATALOG)[number]["id"];

interface ProviderReadiness {
  id: ProviderId;
  label: string;
  hasKey: boolean;
  keySource: "db" | "env" | "cli" | "none";
  baseUrl: string | null;
  deployments: Record<string, string>;
  ready: boolean;
}

export async function GET() {
  const providers: Record<string, ProviderReadiness> = {};
  for (const p of PROVIDER_CATALOG) {
    const cfg = getProviderRuntimeConfig(p.id);
    const deployments = (cfg.extra.deployments as Record<string, string> | undefined) ?? {};
    const hasKey = p.id === "codex" ? cfg.keySource === "cli" : !!cfg.apiKey;
    // Azure mirrors today's `if (azureBaseUrl && azureDeployment)` gate — not
    // ready without a base URL and at least one deployment (finding 1ii).
    const ready =
      p.id === "azure"
        ? hasKey && !!cfg.baseUrl && Object.keys(deployments).length > 0
        : hasKey;
    providers[p.id] = {
      id: p.id,
      label: p.label,
      hasKey,
      keySource: cfg.keySource,
      baseUrl: cfg.baseUrl,
      deployments,
      ready,
    };
  }

  // C8 per-model provider union: the C1 static default (every catalog model
  // runs on Kie) plus any stored model_bindings rows. The client renders the
  // provider selector at >=2 from this; the static binding set itself lives in
  // lib/providers/bindings.ts (Phase 4), not here.
  const rowsByModel = getModelBindingsByModel();
  const bindingsByModel: Record<string, string[]> = {};
  for (const m of [...IMAGE_MODELS, ...VIDEO_MODELS]) {
    bindingsByModel[m.id] = ["kie", ...((rowsByModel[m.id] ?? []).filter((p) => p !== "kie"))];
  }
  for (const [modelId, pids] of Object.entries(rowsByModel)) {
    if (!bindingsByModel[modelId]) bindingsByModel[modelId] = pids;
  }

  return NextResponse.json({
    providers,
    modelPrefs: getModelPrefs(),
    customBindings: getCustomModelBindings(),
    bindingsByModel,
  });
}

async function upsertFromBody(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "body must be an object" }, { status: 400 });
  }

  const { providerId, apiKey, baseUrl, deployments, modelPrefs, customBindings } = body as {
    providerId?: unknown;
    apiKey?: unknown;
    baseUrl?: unknown;
    deployments?: unknown;
    modelPrefs?: unknown;
    customBindings?: unknown;
  };

  if (providerId != null || apiKey != null || baseUrl != null || deployments != null) {
    if (typeof providerId !== "string" || !providerId.trim()) {
      return NextResponse.json({ error: "providerId is required" }, { status: 400 });
    }
    const pid = providerId.trim();
    if (apiKey != null) {
      if (typeof apiKey !== "string" || !apiKey.trim()) {
        return NextResponse.json({ error: "apiKey must be a non-empty string" }, { status: 400 });
      }
      setProviderApiKey(pid, apiKey.trim());
    }
    if (baseUrl != null) {
      if (typeof baseUrl !== "string") {
        return NextResponse.json({ error: "baseUrl must be a string" }, { status: 400 });
      }
      setProviderBaseUrl(pid, baseUrl.trim() || null);
    }
    if (deployments != null) {
      if (typeof deployments !== "object" || Array.isArray(deployments)) {
        return NextResponse.json({ error: "deployments must be an object" }, { status: 400 });
      }
      const deps: Record<string, string> = {};
      for (const [k, v] of Object.entries(deployments as Record<string, unknown>)) {
        if (typeof v === "string" && v.trim()) deps[k] = v.trim();
      }
      setProviderDeployments(pid, deps);
    }
  }

  if (modelPrefs != null) {
    if (typeof modelPrefs !== "object" || Array.isArray(modelPrefs)) {
      return NextResponse.json({ error: "modelPrefs must be an object" }, { status: 400 });
    }
    for (const [modelId, pid] of Object.entries(modelPrefs as Record<string, unknown>)) {
      if (typeof pid === "string" && pid.trim()) setModelActiveProvider(modelId, pid.trim());
    }
  }

  if (customBindings != null) {
    if (!Array.isArray(customBindings)) {
      return NextResponse.json({ error: "customBindings must be an array" }, { status: 400 });
    }
    for (const raw of customBindings as Array<Record<string, unknown> | null>) {
      const b = raw && typeof raw === "object" ? raw : null;
      const modelId = b && typeof b.modelId === "string" ? b.modelId.trim() : "";
      const pid = b && typeof b.providerId === "string" ? b.providerId.trim() : "";
      if (!b || !modelId || !pid) {
        return NextResponse.json(
          { error: "each customBinding needs modelId and providerId" },
          { status: 400 },
        );
      }
      const binding: Record<string, unknown> = { ...b };
      delete binding.modelId;
      delete binding.providerId;
      upsertCustomModelBinding(modelId, pid, binding);
    }
  }

  return NextResponse.json({ ok: true });
}

export async function PUT(req: NextRequest) {
  return upsertFromBody(req);
}

/** Alias used by the one-time localStorage migration in AppSidebar (C7d). */
export async function POST(req: NextRequest) {
  return upsertFromBody(req);
}

export async function DELETE(req: NextRequest) {
  const providerId = req.nextUrl.searchParams.get("providerId");
  if (!providerId?.trim()) {
    return NextResponse.json({ error: "providerId query param is required" }, { status: 400 });
  }
  const pid = providerId.trim();
  clearProviderApiKey(pid);          // stored DB key cleared — must stay deleted (C7a)
  deleteProviderModelBindings(pid);  // design §3.3: provider's bindings go too
  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from "next/server";
import {
  getProviderRuntimeConfig,
  setProviderApiKey,
  clearProviderApiKey,
  setProviderBaseUrl,
  setProviderDeployments,
  setProviderPresetId,
  setProviderChatConfig,
  getParamPresets,
  getParamPreset,
  getModelPrefs,
  getCustomModelBindings,
  getModelBindingsByModel,
  setModelActiveProvider,
  upsertCustomModelBinding,
  deleteProviderModelBindings,
} from "@/lib/guest/db";
import { IMAGE_MODELS, VIDEO_MODELS } from "@/lib/modelConfig";
import {
  getAvailableProvidersForModel,
  getOpenRouterBinding,
  getPollinationsBinding,
  OPENROUTER_BASE_URL,
  POLLINATIONS_BASE_URL,
} from "@/lib/providers/bindings";
// The registry (side-effect registration + the adapter's own `checkReadiness`)
// — controllers import the BOOTSTRAP module, never an adapter directly.
import { get as getRegisteredProvider } from "@/lib/providers/bootstrap";

/**
 * Phase 3 — unified provider credential/config store (design.md §3.3).
 *
 * GET    → non-secret readiness per provider + modelPrefs + customBindings
 *          (+ bindingsByModel, the C8 per-model provider union: static Kie
 *          default ∪ stored model_bindings rows) + the param presets
 *          (compat-plan §c: ids + family + params for the picker).
 * PUT    → upsert `{ providerId, apiKey?, baseUrl?, deployments?, presetId? }`
 *          and/or `{ modelPrefs?, customBindings? }` (persisted into
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
  // The BYOK chat credential (Settings → Assistant): the user's own key for
  // assistant/chat requests. It is NOT a generation backend — it never appears
  // in the model→provider bindings, only in the credential store.
  { id: "chat",          label: "Chat (BYOK)" },
  // OpenRouter is a BACKEND of the openai-compat family with its own id —
  // its own key row, its own base URL, its own model bindings.
  { id: "openrouter",    label: "OpenRouter" },
  // Pollinations is another BACKEND of the same family — its own key row
  // (POLLINATIONS_API_KEY), its own base URL, its own model bindings.
  { id: "pollinations",  label: "Pollinations" },
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
  /** Why the provider is not ready (adapter `checkReadiness` reason). */
  reason?: string;
  /** The provider-level param preset id (compat-plan §c) — "" when unset. */
  presetId: string;
  /** Assistant BYOK provider preset ("openai" | "openrouter" | "pollinations" | "custom" | "") when id === "chat". */
  chatPreset?: string;
  /** Assistant BYOK default model id when id === "chat". */
  chatModel?: string;
}

/** A stored param preset (id + family + params) — the picker's data source. */
interface PresetInfo {
  id: string;
  family: string;
  params: Record<string, unknown>;
}

export async function GET() {
  // The OpenRouter backend of the openai-compat family. Its readiness is
  // decided by the ADAPTER itself (`checkReadiness`) so the report can never
  // disagree with what the generation path will do (compat-plan §b).
  const orProvider = getRegisteredProvider("openrouter");
  const orBinding = getOpenRouterBinding();
  // The Pollinations backend of the same family (its OpenAI-compatible SYNC
  // image leg) — same treatment: the adapter decides readiness.
  const polProvider = getRegisteredProvider("pollinations");
  const polBinding = getPollinationsBinding();
  // The family adapter itself — a user-pointed backend (LiteLLM / new-api /
  // own gateway) is configured under the "openai-compat" id and needs a key
  // AND a base URL.
  const compatProvider = getRegisteredProvider("openai-compat");

  const providers: Record<string, ProviderReadiness> = {};
  for (const p of PROVIDER_CATALOG) {
    const cfg = getProviderRuntimeConfig(p.id);
    const deployments = (cfg.extra.deployments as Record<string, string> | undefined) ?? {};
    const hasKey = p.id === "codex" ? cfg.keySource === "cli" : !!cfg.apiKey;
    let baseUrl: string | null = cfg.baseUrl;
    let ready: boolean;
    let reason: string | undefined;

    if (p.id === "azure") {
      // Azure mirrors today's `if (azureBaseUrl && azureDeployment)` gate — not
      // ready without a base URL and at least one deployment (finding 1ii).
      ready = hasKey && !!cfg.baseUrl && Object.keys(deployments).length > 0;
    } else if (p.id === "openrouter") {
      // The compat family PINS its base URL on the binding (a code-seeded
      // backend carries its own), so the effective base URL is the binding's —
      // a stored `provider_configs.base_url` row never overrides it.
      baseUrl = orBinding?.baseUrl ?? OPENROUTER_BASE_URL;
      const check = orProvider?.checkReadiness(cfg, orBinding);
      ready = check?.ready ?? hasKey;
      reason = check?.reason;
    } else if (p.id === "pollinations") {
      // Same as OpenRouter: the binding pins the base URL (the generation
      // host) and the adapter decides readiness (key + base URL).
      baseUrl = polBinding?.baseUrl ?? POLLINATIONS_BASE_URL;
      const check = polProvider?.checkReadiness(cfg, polBinding);
      ready = check?.ready ?? hasKey;
      reason = check?.reason;
    } else if (p.id === "openai-compat") {
      // A USER-pointed backend: the base URL comes from the stored config, and
      // the adapter decides readiness (key + base URL) so the report can never
      // disagree with the generation path.
      const check = compatProvider?.checkReadiness(cfg, undefined);
      ready = check?.ready ?? hasKey;
      reason = check?.reason;
    } else {
      ready = hasKey;
    }

    providers[p.id] = {
      id: p.id,
      label: p.label,
      hasKey,
      keySource: cfg.keySource,
      baseUrl,
      deployments,
      ready,
      presetId: typeof cfg.extra.presetId === "string" ? cfg.extra.presetId : "",
      ...(p.id === "chat"
        ? {
            chatPreset: typeof cfg.extra.chatPreset === "string" ? cfg.extra.chatPreset : "",
            chatModel:
              typeof cfg.extra.chatModel === "string" && cfg.extra.chatModel.trim()
                ? cfg.extra.chatModel.trim()
                : (process.env.CHAT_MODEL?.trim() ?? ""),
          }
        : {}),
      ...(reason ? { reason } : {}),
    };
  }

  // C3 (o6-gate): bindingsByModel is the UNION of the static binding set
  // (lib/providers/bindings.ts — e.g. gpt-image-2 → kie+azure+codex) and any
  // stored model_bindings rows, so the P5 provider selector sees every
  // provider a model can actually run on. Rows only ever ADD to the static
  // set; the static set itself is code, not rows (bindings.ts hedge (d)).
  const rowsByModel = getModelBindingsByModel();
  const bindingsByModel: Record<string, string[]> = {};
  for (const m of [...IMAGE_MODELS, ...VIDEO_MODELS]) {
    bindingsByModel[m.id] = [
      ...new Set([...getAvailableProvidersForModel(m.id), ...(rowsByModel[m.id] ?? [])]),
    ];
  }
  for (const [modelId, pids] of Object.entries(rowsByModel)) {
    if (!bindingsByModel[modelId]) bindingsByModel[modelId] = pids;
  }

  return NextResponse.json({
    providers,
    modelPrefs: getModelPrefs(),
    customBindings: getCustomModelBindings(),
    bindingsByModel,
    // Param presets (compat-plan §c): ids + family (+ the params JSON for the
    // view-only preview in the Settings picker). No secrets here.
    presets: getParamPresets().map(
      (p): PresetInfo => ({ id: p.presetId, family: p.family, params: p.params }),
    ),
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

  const {
    providerId,
    apiKey,
    baseUrl,
    deployments,
    presetId,
    chatPreset,
    chatModel,
    modelPrefs,
    customBindings,
  } = body as {
    providerId?: unknown;
    apiKey?: unknown;
    baseUrl?: unknown;
    deployments?: unknown;
    presetId?: unknown;
    chatPreset?: unknown;
    chatModel?: unknown;
    modelPrefs?: unknown;
    customBindings?: unknown;
  };

  if (
    providerId != null ||
    apiKey != null ||
    baseUrl != null ||
    deployments != null ||
    presetId != null ||
    chatPreset != null ||
    chatModel != null
  ) {
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
    if (chatPreset != null || chatModel != null) {
      const chatPatch: { chatPreset?: string | null; chatModel?: string | null } = {};
      if (chatPreset != null) {
        if (typeof chatPreset !== "string") {
          return NextResponse.json({ error: "chatPreset must be a string" }, { status: 400 });
        }
        chatPatch.chatPreset = chatPreset.trim() || null;
      }
      if (chatModel != null) {
        if (typeof chatModel !== "string") {
          return NextResponse.json({ error: "chatModel must be a string" }, { status: 400 });
        }
        chatPatch.chatModel = chatModel.trim() || null;
      }
      setProviderChatConfig(pid, chatPatch);
    }
    if (presetId != null) {
      if (typeof presetId !== "string") {
        return NextResponse.json({ error: "presetId must be a string" }, { status: 400 });
      }
      const wanted = presetId.trim();
      if (wanted) {
        // Fail fast on a typo'd preset id — a silent fallback would generate
        // with the wrong dialect (compat-plan §c).
        if (!getParamPreset(wanted)) {
          return NextResponse.json({ error: `Unknown param preset "${wanted}"` }, { status: 400 });
        }
        setProviderPresetId(pid, wanted);
      } else {
        setProviderPresetId(pid, null);
      }
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

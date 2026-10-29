import { NextRequest, NextResponse } from "next/server";
import {
  getProviderRuntimeConfig,
  getProviderConfig,
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
  getCustomModelIdsOnlyBoundTo,
} from "@/lib/guest/db";
import { db } from "@/lib/guest/sqlite";
import { IMAGE_MODELS, VIDEO_MODELS } from "@/lib/modelConfig";
// P7a-1 — custom logical models: the SAME server-side resolver the generation
// controllers use, so the report and the generation path can never disagree.
import {
  deleteCustomModel,
  getCustomModelSpecs,
  isCatalogModelId,
  isCustomModelKind,
  upsertCustomModel,
} from "@/lib/guest/customModels";
import type { CustomModelApiInput } from "@/lib/guest/customModels";
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
import {
  PROVIDER_KINDS,
  providerKindOf,
  resolveProviderFor,
} from "@/lib/providers/registry";
import type { ProviderKind } from "@/lib/providers/registry";

/**
 * Phase 3 — unified provider credential/config store (design.md §3.3).
 *
 * GET    → non-secret readiness per provider + modelPrefs + customBindings
 *          (+ bindingsByModel, the C8 per-model provider union: static Kie
 *          default ∪ stored model_bindings rows) + the param presets
 *          (compat-plan §c: ids + family + params for the picker) + the
 *          `customModels` array (P7a-1/P7a-5: user-created logical models —
 *          id, kind, label, picker fields and the apiInput subset).
 *          P7a-0: the per-backend list is DYNAMIC — every stored
 *          `provider_configs` row not in the built-in catalog is appended with
 *          its `kind` (absent ⇒ openai-compat) and its own readiness.
 * PUT    → upsert `{ providerId, apiKey?, baseUrl?, deployments?, presetId?,
 *          kind?, label? }` and/or `{ modelPrefs?, customBindings? }`
 *          (persisted into provider_configs / model_bindings). `kind` and
 *          `label` merge into `extra_json` without disturbing other keys.
 * POST   → a custom-model body `{ id, kind: "image"|"video", label, … }`
 *          creates/updates a `custom_models` row (P7a-1); every other body is
 *          an alias of PUT (used by the one-time AppSidebar localStorage
 *          migration, C7d).
 * DELETE → `?customModelId=` deletes that custom model AND its
 *          model_bindings rows (cascade, P7a-1); `?providerId=` clears the
 *          stored DB key for that provider (and its model_bindings rows) and
 *          reports the custom model ids that became unbound. Env fallbacks
 *          still apply afterwards; the cleared key must NOT resurrect on
 *          restart (C7a). Unknown query params (e.g. `kind`) are ignored —
 *          DELETE has no JSON to persist.
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

interface ProviderReadiness {
  /** The BACKEND id — a built-in catalog id or a user-created `provider_configs` id. */
  id: string;
  label: string;
  /**
   * The backend FAMILY (P7a-0). Only user-created rows carry it in the report
   * (built-in entries keep their pre-P7a shape byte-for-byte).
   */
  kind?: ProviderKind;
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

/**
 * Stored `provider_configs` ids, in a stable order (P7a-0).
 *
 * The report must list a USER-CREATED backend even though it is not in
 * `PROVIDER_CATALOG`. `lib/guest/db.ts` has no "list ids" helper and this
 * commit does not own `lib/guest/**`, so the route reads the ids itself and
 * resolves every row through the same `getProviderRuntimeConfig()` the rest of
 * the server uses. No secret column is selected.
 */
function listStoredProviderIds(): string[] {
  const rows = db()
    .prepare("SELECT provider_id FROM provider_configs ORDER BY provider_id")
    .all() as Array<{ provider_id: string }>;
  return rows.map((r) => r.provider_id);
}

/**
 * Merges `kind` / `label` into `provider_configs.extra_json` (P7a-0) without
 * disturbing any other key (`deployments`, `presetId`, `chatPreset`,
 * `chatModel`, …). A `null` value removes the key.
 */
function setProviderKindAndLabel(
  providerId: string,
  patch: { kind?: ProviderKind | null; label?: string | null },
): void {
  const cfg = getProviderConfig(providerId);
  const extra = { ...(cfg?.extra ?? {}) };
  if (patch.kind !== undefined) {
    if (patch.kind) extra.kind = patch.kind;
    else delete extra.kind;
  }
  if (patch.label !== undefined) {
    if (patch.label) extra.label = patch.label;
    else delete extra.label;
  }
  db()
    .prepare(`
      INSERT INTO provider_configs (provider_id, extra_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET extra_json = excluded.extra_json, updated_at = excluded.updated_at
    `)
    .run(providerId, JSON.stringify(extra), new Date().toISOString());
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

  // ── User-created backends (P7a-0) ─────────────────────────────────────────
  // Every stored `provider_configs` row whose id is NOT in the built-in
  // catalog is a backend the user created. Without this merge such a row is
  // writable but invisible: no key/base-url card, no readiness, no provider
  // label. Built-in entries above stay first and byte-identical; a row for a
  // built-in id is skipped (the catalog entry owns its shape).
  const catalogIds = new Set<string>(PROVIDER_CATALOG.map((p) => p.id));
  for (const id of listStoredProviderIds()) {
    if (catalogIds.has(id)) continue;
    const cfg = getProviderRuntimeConfig(id);
    // Absent/unrecognized kind ⇒ the historical openai-compat default.
    const kind = providerKindOf(cfg) ?? "openai-compat";
    const deployments = (cfg.extra.deployments as Record<string, string> | undefined) ?? {};
    const hasKey = !!cfg.apiKey;
    // Same readiness rule as the built-ins: the FAMILY adapter decides when it
    // is registered (key + base URL for compat, base URL for a Space), with
    // `hasKey` as the pre-adapter fallback (e.g. `mcp` before its adapter
    // lands). `resolveProviderFor` is the registry's own kind→family mapping,
    // so this report can never disagree with the generation path.
    const adapter = resolveProviderFor(id, cfg);
    const check = adapter?.checkReadiness(cfg, undefined);
    const rawLabel = cfg.extra.label;
    const label = typeof rawLabel === "string" && rawLabel.trim() ? rawLabel.trim() : id;

    providers[id] = {
      id,
      label,
      kind,
      hasKey,
      keySource: cfg.keySource,
      baseUrl: cfg.baseUrl,
      deployments,
      ready: check?.ready ?? hasKey,
      presetId: typeof cfg.extra.presetId === "string" ? cfg.extra.presetId : "",
      ...(check?.reason ? { reason: check.reason } : {}),
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
    if (!bindingsByModel[modelId]) {
      // A model id the static catalog does not know is a CUSTOM model
      // (P7a-1). `getAvailableProvidersForModel()` seeds "kie" for ANY
      // unknown id, which would claim the model can run on Kie — never use it
      // here. The stored rows are the whole union (possibly empty).
      bindingsByModel[modelId] = [...new Set(pids)];
    }
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
    // P7a-1/P7a-5 — user-created logical models. EXACT shape another lane
    // codes against: id, kind, label, picker fields + the apiInput subset.
    customModels: getCustomModelSpecs(),
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
    kind,
    label,
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
    kind?: unknown;
    label?: unknown;
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
    kind != null ||
    label != null ||
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
    // P7a-0: the backend FAMILY (and an optional display label) live in
    // `extra_json`; merge them LAST so the other writes above are visible and
    // nothing else in that JSON is disturbed.
    if (kind != null || label != null) {
      const extraPatch: { kind?: ProviderKind | null; label?: string | null } = {};
      if (kind != null) {
        if (typeof kind !== "string") {
          return NextResponse.json({ error: "kind must be a string" }, { status: 400 });
        }
        const wanted = kind.trim();
        if (wanted && !(PROVIDER_KINDS as readonly string[]).includes(wanted)) {
          // Fail fast on a typo'd kind — defaulting it to openai-compat would
          // route the backend through the wrong dialect.
          return NextResponse.json(
            { error: `Unknown provider kind "${wanted}" — expected one of ${PROVIDER_KINDS.join(", ")}` },
            { status: 400 },
          );
        }
        extraPatch.kind = (wanted || null) as ProviderKind | null;
      }
      if (label != null) {
        if (typeof label !== "string") {
          return NextResponse.json({ error: "label must be a string" }, { status: 400 });
        }
        extraPatch.label = label.trim() || null;
      }
      setProviderKindAndLabel(pid, extraPatch);
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

// ── P7a-1 custom logical models (POST body / DELETE ?customModelId=) ───────

const badRequest = (error: string) => NextResponse.json({ error }, { status: 400 });

/** The `apiInput` keys a custom model may carry (the report's exact shape). */
const CUSTOM_MODEL_API_INPUT_KEYS = [
  "aspectRatioKey",
  "promptMaxLength",
  "imageInputKey",
  "qualityKey",
  "qualityOptions",
  "qualityMap",
  "outputFormat",
  "durationMin",
  "durationMax",
  "extra",
] as const;
const CUSTOM_MODEL_API_INPUT_KEY_SET = new Set<string>(CUSTOM_MODEL_API_INPUT_KEYS);

/**
 * A POST body is a CUSTOM MODEL — not a provider write — when it has no
 * `providerId` and carries a custom-model id plus a custom-model field.
 * `kind` alone cannot decide it: provider writes also carry `kind`
 * (openai-compat | gradio | mcp), while a custom model's is image | video.
 */
function looksLikeCustomModelBody(body: Record<string, unknown>): boolean {
  if (body.providerId != null) return false;
  // image|video can never be a PROVIDER kind, so the body is a custom model
  // even when `id` is missing (it must get "id is required", not the provider
  // upsert's "providerId is required").
  if (body.kind === "image" || body.kind === "video") return true;
  if (typeof body.id !== "string") return false;
  // A custom-model body with a missing/bad `kind` is still recognised by its
  // other fields, so it gets the actionable 400.
  return (
    body.apiInput != null ||
    body.ratios != null ||
    body.supportsImages != null ||
    body.maxImages != null ||
    body.supportsQuality != null
  );
}

/** Validates + persists `{ id, kind, label, … }` as a `custom_models` row. */
function upsertCustomModelFromBody(body: Record<string, unknown>) {
  if (typeof body.id !== "string" || !body.id.trim()) {
    return badRequest("id is required");
  }
  const id = body.id.trim();
  if (!isCustomModelKind(body.kind)) {
    return badRequest(`kind must be "image" or "video"`);
  }
  if (isCatalogModelId(id)) {
    return badRequest(`id "${id}" already exists in the built-in catalog — pick a different id`);
  }
  if (body.label != null && typeof body.label !== "string") {
    return badRequest("label must be a string");
  }
  if (body.ratios != null) {
    if (!Array.isArray(body.ratios) || body.ratios.some((r) => typeof r !== "string")) {
      return badRequest("ratios must be an array of strings");
    }
  }
  if (body.supportsImages != null && typeof body.supportsImages !== "boolean") {
    return badRequest("supportsImages must be a boolean");
  }
  if (body.supportsQuality != null && typeof body.supportsQuality !== "boolean") {
    return badRequest("supportsQuality must be a boolean");
  }
  if (
    body.maxImages != null &&
    (typeof body.maxImages !== "number" || !Number.isFinite(body.maxImages) || body.maxImages < 0)
  ) {
    return badRequest("maxImages must be a non-negative number");
  }

  let apiInput: Partial<CustomModelApiInput> | undefined;
  if (body.apiInput != null) {
    if (typeof body.apiInput !== "object" || Array.isArray(body.apiInput)) {
      return badRequest("apiInput must be an object");
    }
    const raw = body.apiInput as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!CUSTOM_MODEL_API_INPUT_KEY_SET.has(key)) {
        return badRequest(
          `unknown apiInput key "${key}" — expected one of ${CUSTOM_MODEL_API_INPUT_KEYS.join(", ")}`,
        );
      }
    }
    if (raw.aspectRatioKey != null && typeof raw.aspectRatioKey !== "string") {
      return badRequest("apiInput.aspectRatioKey must be a string");
    }
    if (
      raw.promptMaxLength != null &&
      (typeof raw.promptMaxLength !== "number" ||
        !Number.isFinite(raw.promptMaxLength) ||
        raw.promptMaxLength <= 0)
    ) {
      return badRequest("apiInput.promptMaxLength must be a positive number");
    }
    if (raw.imageInputKey != null && typeof raw.imageInputKey !== "string") {
      return badRequest("apiInput.imageInputKey must be a string");
    }
    if (raw.qualityKey != null && typeof raw.qualityKey !== "string") {
      return badRequest("apiInput.qualityKey must be a string");
    }
    if (raw.outputFormat != null && typeof raw.outputFormat !== "string") {
      return badRequest("apiInput.outputFormat must be a string");
    }
    if (
      raw.qualityOptions != null &&
      (!Array.isArray(raw.qualityOptions) || raw.qualityOptions.some((v) => typeof v !== "string"))
    ) {
      return badRequest("apiInput.qualityOptions must be an array of strings");
    }
    if (raw.qualityMap != null) {
      if (typeof raw.qualityMap !== "object" || Array.isArray(raw.qualityMap)) {
        return badRequest("apiInput.qualityMap must be an object");
      }
      if (Object.values(raw.qualityMap as Record<string, unknown>).some((v) => typeof v !== "string")) {
        return badRequest("apiInput.qualityMap values must be strings");
      }
    }
    if (raw.durationMin != null && (typeof raw.durationMin !== "number" || !Number.isFinite(raw.durationMin))) {
      return badRequest("apiInput.durationMin must be a number");
    }
    if (raw.durationMax != null && (typeof raw.durationMax !== "number" || !Number.isFinite(raw.durationMax))) {
      return badRequest("apiInput.durationMax must be a number");
    }
    if (raw.extra != null && (typeof raw.extra !== "object" || Array.isArray(raw.extra))) {
      return badRequest("apiInput.extra must be an object");
    }
    apiInput = raw as Partial<CustomModelApiInput>;
  }

  const spec = upsertCustomModel({
    id,
    kind: body.kind,
    label: typeof body.label === "string" ? body.label : undefined,
    supportsImages: typeof body.supportsImages === "boolean" ? body.supportsImages : undefined,
    maxImages: typeof body.maxImages === "number" ? body.maxImages : undefined,
    supportsQuality: typeof body.supportsQuality === "boolean" ? body.supportsQuality : undefined,
    ratios: Array.isArray(body.ratios) ? (body.ratios as string[]) : undefined,
    apiInput,
  });
  return NextResponse.json({ ok: true, customModel: spec });
}

/**
 * Alias used by the one-time localStorage migration in AppSidebar (C7d) AND
 * the custom-model write path (P7a-1): a custom-model body is dispatched
 * first; every other body is a provider write (unchanged PUT semantics).
 */
export async function POST(req: NextRequest) {
  const body = (await req.clone().json().catch(() => null)) as Record<string, unknown> | null;
  if (body && typeof body === "object" && !Array.isArray(body) && looksLikeCustomModelBody(body)) {
    return upsertCustomModelFromBody(body);
  }
  return upsertFromBody(req);
}

export async function DELETE(req: NextRequest) {
  const customModelId = req.nextUrl.searchParams.get("customModelId");
  if (customModelId != null) {
    if (!customModelId.trim()) {
      return badRequest("customModelId query param is required");
    }
    // P7a-1 cascade: the row AND its model_bindings rows go together, so no
    // binding is left pointing at an id nothing can resolve.
    deleteCustomModel(customModelId.trim());
    return NextResponse.json({ ok: true });
  }

  const providerId = req.nextUrl.searchParams.get("providerId");
  if (!providerId?.trim()) {
    return NextResponse.json({ error: "providerId query param is required" }, { status: 400 });
  }
  const pid = providerId.trim();
  // P7a-1 cascade REPORT: custom models whose ONLY bindings point at this
  // provider become unbound when its rows are wiped. Computed BEFORE the
  // delete; the provider DELETE's own effect is unchanged (no implicit
  // custom-model deletion — that stays explicit on ?customModelId=).
  const unboundCustomModels = getCustomModelIdsOnlyBoundTo(pid);
  clearProviderApiKey(pid);          // stored DB key cleared — must stay deleted (C7a)
  deleteProviderModelBindings(pid);  // design §3.3: provider's bindings go too
  return NextResponse.json({ ok: true, unboundCustomModels });
}

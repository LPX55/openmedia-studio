// ─────────────────────────────────────────────────────────────────────────────
// PROVIDERS — single source of truth for per-model backend selection
// (Kie.ai / Azure Foundry / Codex CLI / OpenRouter), shared by the Settings
// modal, the workflow GenerateNode, and the gallery generation composer.
//
// Phase 5 (C8 / design §3.4): the zustand store is the backing store —
// hydrated from `GET /api/settings/providers` (AppSidebar) and written back
// through `PUT /api/settings/providers`. The legacy localStorage keys
// (`aiui-model-providers` / `aiui-azure-base-url` / `aiui-azure-endpoints`)
// are GONE; every helper keeps its pre-P5 name and signature so callers don't
// churn. Individual components must not inline localStorage reads of these
// keys (design §4.1) — they go through this module or the store.
// ─────────────────────────────────────────────────────────────────────────────
import { IMAGE_MODELS } from "@/lib/modelConfig";
import { useWorkflowStore } from "@/lib/store";

export const PROVIDERS = [
  { id: "kie",        label: "Kie.ai" },
  { id: "azure",      label: "Azure Foundry" },
  { id: "codex",      label: "Codex CLI" },
  // OpenRouter rides the openai-compat family (P6 step 1) but keeps its OWN
  // provider id — it carries its own key row, base URL and model bindings.
  { id: "openrouter", label: "OpenRouter" },
  // Pollinations is another backend of the same family (its OpenAI-compatible
  // sync image leg) — own key row, base URL and model bindings.
  { id: "pollinations", label: "Pollinations" },
] as const;

/**
 * Provider ids the client understands.
 *
 * The known ids come from `PROVIDERS`; the `(string & {})` tail keeps the type
 * OPEN for ids only the SERVER knows (another compat backend alias, a
 * user-defined `model_bindings` row). The per-model provider union the server
 * sends (`bindingsByModel`) is DATA, not a closed enum — the client must never
 * assume a fixed provider set (P6 step 2: a 4th provider id crashed every
 * `PROVIDERS.find(...)!` call site).
 */
export type ProviderId = (typeof PROVIDERS)[number]["id"] | (string & {});

/**
 * Display metadata for a provider id — a KNOWN id yields its label, an unknown
 * one (server-only backend) degrades to the raw id instead of crashing a
 * `find()!` call site.
 */
export function providerMeta(id: string): { id: string; label: string } {
  const known = (PROVIDERS as readonly { id: string; label: string }[]).find((p) => p.id === id);
  return known ?? { id, label: id };
}

// ── Model → provider preference (was localStorage `aiui-model-providers`) ────

/** The persisted provider map (server `modelPrefs`), hydrated from GET providers. */
export function loadModelProviders(): Record<string, ProviderId> {
  return useWorkflowStore.getState().modelProviders as Record<string, ProviderId>;
}

/** Writes the whole pref map: optimistic store write + PUT /api/settings/providers. */
export function saveModelProviders(map: Record<string, ProviderId>) {
  useWorkflowStore.setState({ modelProviders: map });
  void (async () => {
    try {
      await fetch("/api/settings/providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelPrefs: map }),
      });
    } catch { /* offline — the store keeps the pref for this session */ }
  })();
}

export function getModelProvider(modelId: string): ProviderId {
  return loadModelProviders()[modelId] ?? "kie";
}

/** Persists the backend for a single model, leaving the others untouched. */
export function setModelProvider(modelId: string, provider: ProviderId) {
  const map = loadModelProviders();
  saveModelProviders({ ...map, [modelId]: provider });
}

// ── Visibility toggles (declutter) ───────────────────────────────────────────
// The user can hide a provider or a model from every picker (Settings →
// Models). The toggles live in the client-side store (persisted in
// localStorage) — they only affect WHICH entries are offered, never the
// server-side routing of an already-saved workflow.
//
// The `disabled*` lists are passed in by the caller so a component that
// SUBSCRIBES to the store slice re-renders when a toggle flips; the defaults
// read the store directly for non-reactive call sites.

/** Is this provider enabled? (false once the user hid it in Settings) */
export function isProviderEnabled(
  providerId: string,
  disabledProviders: readonly string[] = useWorkflowStore.getState().disabledProviders,
): boolean {
  return !disabledProviders.includes(providerId);
}

/** Is this model enabled? (false once the user hid it in Settings) */
export function isModelEnabled(
  modelId: string,
  disabledModels: readonly string[] = useWorkflowStore.getState().disabledModels,
): boolean {
  return !disabledModels.includes(modelId);
}

/** Drop the hidden models from a model list (dropdowns / pickers). */
export function filterEnabledModels<T extends { id: string }>(
  models: T[],
  disabledModels: readonly string[] = useWorkflowStore.getState().disabledModels,
): T[] {
  return models.filter((m) => isModelEnabled(m.id, disabledModels));
}

/**
 * The providers of `modelId` that are still enabled (backend pickers).
 *
 * `keep` pins one provider into the list even when it is hidden — the
 * Settings panel uses it so a model that is currently bound to a hidden
 * provider still shows that binding (and can be changed away from it).
 */
export function enabledProvidersForModel(
  modelId: string,
  disabledProviders: readonly string[] = useWorkflowStore.getState().disabledProviders,
  keep?: string,
): ProviderId[] {
  const all = availableProvidersForModel(modelId);
  const enabled = all.filter((p) => isProviderEnabled(p, disabledProviders));
  if (keep && !enabled.includes(keep as ProviderId) && all.includes(keep as ProviderId)) {
    enabled.push(keep as ProviderId);
  }
  return enabled;
}

/**
 * The model id to use for a DEFAULT (a fresh node / a fresh picker): the
 * preferred id when it is still enabled, else the first enabled model.
 *
 * An EXPLICIT id (a model already saved on a node) is never rewritten — the
 * toggles only affect what is offered and what is picked by default.
 */
export function defaultModelId<T extends { id: string }>(
  models: T[],
  preferredId: string,
  disabledModels: readonly string[] = useWorkflowStore.getState().disabledModels,
): string {
  if (isModelEnabled(preferredId, disabledModels)) return preferredId;
  return models.find((m) => isModelEnabled(m.id, disabledModels))?.id ?? preferredId;
}

// ── Per-model provider choices (bindingsByModel from GET providers) ─────────

/**
 * Models with more than one backend to choose from — driven by the server's
 * `bindingsByModel` (static binding set ∪ stored rows) for image AND video
 * models alike (P5 / design §5 Phase 5). Pre-hydration falls back to the
 * pre-P5 static set (azure-capable image models), so nothing blinks away.
 */
export function modelHasProviderChoice(modelId: string): boolean {
  return availableProvidersForModel(modelId).length >= 2;
}

/** Providers selectable for `modelId` (server union; static fallback pre-hydration). */
export function availableProvidersForModel(modelId: string): ProviderId[] {
  const { bindingsByModel, providersHydrated } = useWorkflowStore.getState();
  const fromServer = bindingsByModel[modelId];
  if (fromServer?.length) return fromServer;
  if (providersHydrated) return ["kie"]; // hydrated with no row ⇒ static set said kie-only
  // Pre-hydration fallback — the old MULTI_PROVIDER set (azure-capable images).
  return MULTI_PROVIDER_MODEL_IDS.has(modelId) ? ["kie", "azure", "codex"] : ["kie"];
}

const MULTI_PROVIDER_MODEL_IDS = new Set(
  IMAGE_MODELS.filter((m) => !!m.azureSizeMap).map((m) => m.id),
);

// ── Readiness (design §3.4 — replaces the `kieKeySet === false` kill-switch) ─

export interface ModelReadiness {
  ready: boolean;
  providerId: ProviderId;
  reason?: string;
}

function readinessReason(providerId: ProviderId): string {
  switch (providerId) {
    case "azure":
      return "Azure Foundry is not configured — add its API key, base URL, and a model deployment in Settings.";
    case "codex":
      return "Codex CLI is not configured — run `codex login` on this machine.";
    case "openrouter":
      return "OpenRouter is not configured — add its API key in Settings (or set OPENROUTER_API_KEY).";
    case "pollinations":
      return "Pollinations is not configured — add its API key in Settings (or set POLLINATIONS_API_KEY).";
    default:
      return "No Kie.ai API key configured. Add one in Settings.";
  }
}

/**
 * Is `modelId` ready to generate on its active provider?
 *
 * `providerOverride` wins over the stored pref (the nodes pass the provider
 * their pill shows). Before the GET bootstrap hydrates the store this returns
 * `ready: true` — the pre-P5 `kieKeySet === null` pass-through — so a slow or
 * failing settings fetch never bricks generation.
 */
export function isModelReady(modelId: string, providerOverride?: ProviderId): ModelReadiness {
  const { providerStatus, modelProviders, providersHydrated } = useWorkflowStore.getState();
  const providerId = providerOverride ?? (modelProviders[modelId] as ProviderId | undefined) ?? "kie";
  if (!providersHydrated) return { ready: true, providerId };
  const status = providerStatus[providerId];
  if (status?.ready) return { ready: true, providerId };
  return { ready: false, providerId, reason: readinessReason(providerId) };
}

/** Re-hydrate the store bootstrap (call after any settings write). */
export async function refreshProviderBootstrap(): Promise<void> {
  try {
    const res = await fetch("/api/settings/providers");
    if (!res.ok) return;
    const d = (await res.json()) as Parameters<
      ReturnType<typeof useWorkflowStore.getState>["setProviderBootstrap"]
    >[0];
    useWorkflowStore.getState().setProviderBootstrap({
      providers: d.providers,
      modelPrefs: d.modelPrefs,
      bindingsByModel: d.bindingsByModel,
      presets: d.presets,
    });
  } catch {
    /* offline — readiness stays in the pass-through pre-hydration state */
  }
}

// ── Azure config (was localStorage `aiui-azure-base-url` / `aiui-azure-endpoints`)
// Server-authoritative: `provider_configs.base_url` + `extra.deployments`,
// surfaced by GET /api/settings/providers into the store (C2/C8).

/** Per-model deployment name map (e.g. { "gpt-image-2": "gpt-image-2" }). */
export function getAzureDeployments(): Record<string, string> {
  return useWorkflowStore.getState().providerStatus.azure?.deployments ?? {};
}

/** Per-model Azure deployment name ("" when unset). */
export function getAzureDeployment(modelId: string): string {
  return getAzureDeployments()[modelId] ?? "";
}

/** Base URL of the Azure Foundry resource ("" when unset). */
export function getAzureBaseUrl(): string {
  return (useWorkflowStore.getState().providerStatus.azure?.baseUrl as string | null | undefined) ?? "";
}

/** Azure is fully configured for this model (provider chosen + base URL + deployment). */
export function isAzureConfiguredForModel(modelId: string): boolean {
  return getModelProvider(modelId) === "azure" && !!getAzureBaseUrl() && !!getAzureDeployment(modelId);
}

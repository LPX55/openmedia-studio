/**
 * Provider registry — design.md §1.4 (Phase 4).
 *
 * Server-side singleton `Map<ProviderId, GenerationProvider>` exposing
 * `register` / `get` / `resolveForModel` (the C1 default-binding rule).
 *
 * P4b: the built-in adapters (`lib/providers/adapters/kie.ts`, `azure.ts`,
 * `codex.ts`) register through the `lib/providers/bootstrap.ts` module —
 * controllers import that module (side-effect registration) and never the
 * adapters directly. `resolveForModel` therefore resolves all three built-ins;
 * Phase-6 adapters (replicate / fal / openai-compat) will register the same
 * way.
 *
 * SERVER-ONLY: unlike `bindings.ts`, this module imports `guest/db` for runtime
 * configs (hedge (d) applies to `bindings.ts`; nothing here is client-bundled).
 */
import { getProviderRuntimeConfig } from "../guest/db";
import { BUILT_IN_BINDINGS, getDefaultBinding } from "./bindings";
import type { ModelProviderBinding } from "./bindings";
import type { GenerationProvider, ProviderId, ProviderRuntimeConfig } from "./types";

const providers = new Map<ProviderId, GenerationProvider>();

/**
 * Registers (or replaces, e.g. on hot-reload) the adapter for its `id`.
 *
 * Family adapters (compat-plan §b) declare the BACKEND ids they serve via
 * `aliases`; each alias is registered as an id-overridden VIEW of the same
 * adapter, so `provider.id` — the id the job manager resolves credentials
 * and writes into `generations.provider_id` with — stays the backend id.
 */
export function register(provider: GenerationProvider): void {
  providers.set(provider.id, provider);
  for (const alias of provider.aliases ?? []) {
    providers.set(alias, { ...provider, id: alias });
  }
}

/** The registered adapter, or `undefined` when no adapter has registered for `providerId` yet. */
export function get(providerId: ProviderId): GenerationProvider | undefined {
  return providers.get(providerId);
}

/**
 * A `model_bindings` row as consumed by `resolveForModel` — callers pass rows
 * read from SQLite (see `lib/guest/db.ts`), so the registry itself stays free
 * of query logic. All fields are optional-tolerant: `CustomModelBinding` rows
 * (`{ modelId, providerId, binding }`) are assignable as-is.
 */
export interface ModelBindingRowLike {
  modelId: string;
  providerId: string;
  /** Parsed `binding_json` — `null`/absent ⇒ use the static built-in default for (modelId, providerId). */
  binding?: Partial<ModelProviderBinding> | Record<string, unknown> | null;
  /** `model_bindings.is_active = 1` — the model's chosen provider. */
  isActive?: boolean;
  /** `model_bindings.is_custom = 1` — user-defined endpoint binding. */
  isCustom?: boolean;
}

export interface ResolvedModelProvider {
  provider: GenerationProvider;
  binding: ModelProviderBinding;
  config: ProviderRuntimeConfig;
}

/**
 * Resolve the provider + binding + runtime config for a generation (C1
 * default-binding rule):
 *
 *   1. `explicitProviderId` (what the client asked for) — wins if given;
 *   2. else the model's ACTIVE `model_bindings` row (`isActive`);
 *   3. else the static default binding (Kie, `getDefaultBinding`).
 *
 * The binding for the chosen provider is `static BUILT_IN_BINDINGS entry`
 * merged with that provider's `model_bindings` row override (`binding_json`,
 * when present); a provider with no built-in entry (Phase-6 custom endpoints)
 * must carry `upstreamModelId` in its row. DB rows are passed in by the caller
 * — this function performs no queries itself.
 *
 * Throws when: the model id is unknown (custom logical models are out of scope,
 * C6), no static binding AND no usable row exist for the pair, the merged
 * binding lacks `upstreamModelId`, or no adapter has registered yet (P4b).
 */
export function resolveForModel(
  modelId: string,
  explicitProviderId?: string,
  modelBindingsRows?: ModelBindingRowLike[],
): ResolvedModelProvider {
  const rows = (modelBindingsRows ?? []).filter((r) => r.modelId === modelId);

  // 1 → 2 → 3: explicit → active row → static default (kie).
  // getDefaultBinding() is only reached when neither explicit nor active row
  // identifies a provider — and throws for ids outside the catalog (C6).
  const activeRow = rows.find((r) => r.isActive);
  const providerId: ProviderId =
    explicitProviderId ?? activeRow?.providerId ?? getDefaultBinding(modelId).providerId;

  const staticBase =
    BUILT_IN_BINDINGS.find((b) => b.modelId === modelId && b.providerId === providerId) ??
    (providerId === "kie" ? getDefaultBinding(modelId) : undefined);
  const row = rows.find((r) => r.providerId === providerId);
  const override = (row?.binding ?? undefined) as Partial<ModelProviderBinding> | undefined;

  if (!staticBase && !override) {
    throw new Error(
      `resolveForModel: no binding for (model "${modelId}", provider "${providerId}") — ` +
        `no built-in binding and its model_bindings row carries no binding_json`,
    );
  }

  const merged: Partial<ModelProviderBinding> & { modelId: string; providerId: ProviderId } = {
    ...staticBase,
    ...override,
    modelId,
    providerId,
  };
  if (row?.isCustom || override?.isCustom) merged.isCustom = true;
  if (!merged.upstreamModelId) {
    throw new Error(`resolveForModel: binding for (model "${modelId}", provider "${providerId}") has no upstreamModelId`);
  }
  const binding: ModelProviderBinding = { ...merged, upstreamModelId: merged.upstreamModelId };

  const provider = get(providerId);
  if (!provider) {
    throw new Error(
      `resolveForModel: provider "${providerId}" is not registered — adapters register in P4b (lib/providers/adapters/*)`,
    );
  }

  return { provider, binding, config: getProviderRuntimeConfig(providerId) };
}

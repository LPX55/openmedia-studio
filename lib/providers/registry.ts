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
import { getProviderRuntimeConfig, getParamPreset } from "../guest/db";
import { BUILT_IN_BINDINGS, getDefaultBinding } from "./bindings";
import type { ModelProviderBinding } from "./bindings";
import { mergeParamMaps } from "./presets";
import type { GenerationProvider, ProviderId, ProviderRuntimeConfig } from "./types";

const providers = new Map<ProviderId, GenerationProvider>();

// ── Family / kind routing (P7a-0) ────────────────────────────────────────────
//
// `register()` can only know the ids its adapter declares at load time, so a
// USER-CREATED backend id (`hf-mflux`, `mcp-lan-1`, …) is never a Map key.
// Its `provider_configs.extra_json.kind` names the FAMILY it belongs to, and
// the family adapter serves it as an id-overridden view — exactly the shape
// `register()` builds for a declared alias.

/**
 * The provider FAMILY a backend belongs to, stored in
 * `provider_configs.extra_json.kind` (P7a-0).
 *
 * `openai-compat` is the default: every backend created before the field
 * existed was an OpenAI-speaking endpoint. `gradio` / `mcp` are the Phase-7
 * families (`hf-gradio` / `mcp` adapters).
 */
export type ProviderKind = "openai-compat" | "gradio" | "mcp";

/** The accepted `kind` values (PUT validation + report defaults). */
export const PROVIDER_KINDS = ["openai-compat", "gradio", "mcp"] as const;

/** kind → the registered FAMILY adapter id that serves it (P7a-0). */
const FAMILY_ADAPTER_BY_KIND: Record<ProviderKind, ProviderId> = {
  "openai-compat": "openai-compat",
  gradio: "hf-gradio",
  mcp: "mcp",
};

/**
 * The family kind stored on a provider row (`extra_json.kind`).
 *
 * Absent/empty ⇒ `"openai-compat"` (the historical default). An UNRECOGNIZED
 * non-empty value returns `null`: routing must fail loudly instead of guessing
 * a dialect. (`PUT /api/settings/providers` validates the field, so only a
 * hand-edited row can get here.)
 */
export function providerKindOf(config: Pick<ProviderRuntimeConfig, "extra">): ProviderKind | null {
  const raw = config.extra.kind;
  if (raw === undefined || raw === null || raw === "") return "openai-compat";
  return typeof raw === "string" && (PROVIDER_KINDS as readonly string[]).includes(raw)
    ? (raw as ProviderKind)
    : null;
}

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
 * Resolve the adapter for a BACKEND id, including user-created backends
 * (P7a-0).
 *
 *   1. an EXACT registration wins — every built-in id and every declared alias
 *      behaves exactly as `get()` did before this hook existed;
 *   2. otherwise the row's `extra_json.kind` names its FAMILY and the family
 *      adapter (already registered) is served as an ID-OVERRIDDEN VIEW, the
 *      same shape `register()` stores for an alias: `provider.id` stays the
 *      BACKEND id, which is what the job manager uses for credential
 *      resolution and `generations.provider_id`;
 *   3. otherwise `undefined` — the caller (`resolveForModel`) fails loudly.
 *
 * `config` is optional so callers that already read the runtime config can
 * hand it over instead of triggering a second lookup.
 */
export function resolveProviderFor(
  providerId: ProviderId,
  config?: ProviderRuntimeConfig,
): GenerationProvider | undefined {
  const exact = providers.get(providerId);
  if (exact) return exact;

  const cfg = config ?? getProviderRuntimeConfig(providerId);
  const kind = providerKindOf(cfg);
  if (!kind) return undefined;
  const family = providers.get(FAMILY_ADAPTER_BY_KIND[kind]);
  if (!family) return undefined;
  return { ...family, id: providerId };
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
 * The param preset a binding uses (compat-plan §c).
 *
 * Precedence: the custom binding's OWN `"preset"` key (per binding) wins over
 * the provider-level default (`provider_configs.extra_json.presetId`).
 */
function resolvePresetId(
  override: Partial<ModelProviderBinding> | undefined,
  config: ProviderRuntimeConfig,
): string | null {
  const raw = override as (Partial<ModelProviderBinding> & { preset?: unknown }) | undefined;
  const candidates = [raw?.preset, raw?.presetId, config.extra?.presetId];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
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
 * For the openai-compat family the binding's effective `paramMap` is the
 * PARAM PRESET layer (compat-plan §c):
 *     preset params ← binding.paramMap ← custom-binding overrides
 * An unknown preset id is NOT a silent fallback — the binding carries a
 * `presetError` the adapter fails the job with.
 *
 * Throws when: the model id is unknown (custom logical models are out of scope,
 * C6), no static binding AND no usable row exist for the pair, the merged
 * binding lacks `upstreamModelId`, or no adapter can be resolved for the id —
 * neither an exact registration nor a registered FAMILY adapter for the row's
 * `extra_json.kind` (P7a-0; see `resolveProviderFor`).
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

  // Runtime config first: the family routing hook below needs `extra_json.kind`,
  // and the preset layer needs the same row (one read, not two).
  const config = getProviderRuntimeConfig(providerId);
  const provider = resolveProviderFor(providerId, config);
  if (!provider) {
    const kind = providerKindOf(config);
    const hint = kind
      ? ` — no family adapter "${FAMILY_ADAPTER_BY_KIND[kind]}" is registered for kind "${kind}"`
      : ` — its provider_configs row carries an unrecognized kind "${String(config.extra.kind)}"`;
    throw new Error(
      `resolveForModel: provider "${providerId}" is not registered — adapters register in P4b (lib/providers/adapters/*)${hint}`,
    );
  }

  // ── Param preset layer (compat-plan §c) ───────────────────────────────────
  // The effective params of a compat binding are
  //     preset params ← binding.paramMap ← custom-binding overrides
  // Only the openai-compat family has presets (every other family shapes its
  // payload in code) — for those, a binding WITHOUT a preset keeps exactly
  // today's behaviour (the shallow `{...staticBase, ...override}` merge above).
  if (provider.usesParamPresets) {
    const presetId = resolvePresetId(override, config);
    if (presetId) {
      merged.presetId = presetId;
      const preset = getParamPreset(presetId);
      if (!preset) {
        // Loud failure, NEVER a silent fallback: the adapter turns this into a
        // settled job error carrying the message (compat-plan §c).
        merged.presetError =
          `Unknown param preset "${presetId}" for provider "${providerId}" — ` +
          `pick one of the stored presets in Settings (API Keys → Compatible endpoints).`;
      } else {
        merged.paramMap = mergeParamMaps(
          preset.params,
          staticBase?.paramMap,
          override?.paramMap,
        );
      }
    }
  }

  const binding: ModelProviderBinding = { ...merged, upstreamModelId: merged.upstreamModelId };

  return { provider, binding, config };
}

# /api/settings/providers — provider credentials, readiness & bindings

## Responsibility
The unified provider credential/config store and the client's **only** source of
provider readiness, per-model provider unions and param presets. Replaces the
ad-hoc key routes for everything except their compatibility wrappers, and keeps
every secret server-side (the client cannot import `lib/providers/bootstrap`,
`registry` or the adapters — ESLint `no-restricted-imports`).

## Design
- Provider catalog (hard-coded, ordered): `kie`, `azure`, `codex`, `replicate`,
  `fal`, `openai-compat`, `chat` (BYOK assistant, not a generation backend),
  `openrouter` and `pollinations` (backends of the `openai-compat` family, each
  with its own key row / base URL / bindings).
- **`GET`** → `{ providers, modelPrefs, customBindings, bindingsByModel, presets }`.
  - `providers[id]`: `{ id, label, hasKey, keySource: "db"|"env"|"cli"|"none",
    baseUrl, deployments, ready, reason?, presetId }` (+ `chatPreset`, `chatModel`
    for `chat`). No secrets — presence only.
  - Readiness is **adapter-owned** so the report cannot disagree with generation:
    `azure` = key && base URL && ≥1 deployment; `openrouter` / `pollinations` =
    `checkReadiness(cfg, binding)` with the binding-pinned base URL
    (`OPENROUTER_BASE_URL`, `POLLINATIONS_BASE_URL`); `openai-compat` =
    `checkReadiness(cfg, undefined)` (key + stored base URL); `codex` =
    `keySource === "cli"`; the rest = `hasKey`.
  - `chat.chatModel` = stored `extra_json.chatModel` → `CHAT_MODEL` env → `""`.
  - `bindingsByModel` = union of the static set
    (`getAvailableProvidersForModel`, always includes `kie`) and stored
    `model_bindings` rows, computed over `IMAGE_MODELS` + `VIDEO_MODELS`; rows
    only ever ADD providers. Unknown row-only models are appended too.
  - `presets` = `getParamPresets()` → `{ id, family, params }` (view-only preview
    in the Settings picker; resolution stays `preset ← binding.paramMap ← custom
    overrides`, openai-compat family only).
- **`PUT`** (and **`POST`**, an alias used by the one-time AppSidebar
  localStorage migration) → `upsertFromBody`:
  - provider fields `{ providerId, apiKey?, baseUrl?, deployments?, presetId?,
    chatPreset?, chatModel? }` — `providerId` required when any is present;
    `apiKey` non-empty string (400 otherwise); `baseUrl` string (`""` → null,
    clearing it); `deployments` object of non-empty strings, **merged** into
    `extra_json.deployments`; `presetId` must exist (`400 Unknown param preset`)
    — a typo never silently falls back to the wrong dialect; `chatPreset` /
    `chatModel` strings (`""` → null);
  - top-level `modelPrefs` (modelId → providerId, `setModelActiveProvider`) and
    `customBindings` (array of `{ modelId, providerId, ...binding }`,
    `upsertCustomModelBinding`) — validated independently of the provider block.
  - Malformed JSON / non-object body → 400.
- **`DELETE ?providerId=`** → `clearProviderApiKey(pid)` +
  `deleteProviderModelBindings(pid)`; env fallbacks still apply afterwards, but
  the cleared key must not resurrect on restart (C7a). Missing param → 400.

## Flow
1. `GET`: for each catalog provider → `getProviderRuntimeConfig(pid)` → readiness
   branch (adapter `checkReadiness` where a family/binding exists) → assemble the
   report; then add `modelPrefs`, `customBindings`, `bindingsByModel`, `presets`.
2. `PUT`/`POST`: parse + validate → per-field setters (`setProviderApiKey`,
   `setProviderBaseUrl`, `setProviderChatConfig`, `setProviderPresetId`,
   `setProviderDeployments`) → `modelPrefs` → `customBindings` → `{ ok: true }`.
3. `DELETE`: clear key + drop the provider's binding rows → `{ ok: true }`.

## Integration
- **Stores**: `lib/guest/db.ts` — `provider_configs` (key, base URL,
  `extra_json.deployments|presetId|chatPreset|chatModel`), `model_bindings`
  (active provider via `is_active = 1`, custom bindings), `param_presets`.
- **Registry**: `get` from `@/lib/providers/bootstrap` to reach the registered
  adapter's `checkReadiness`; `lib/providers/bindings.ts` for the static union,
  `getOpenRouterBinding` / `getPollinationsBinding` and the pinned base URLs.
- **Catalog**: `IMAGE_MODELS` / `VIDEO_MODELS` (`lib/modelConfig.ts`).
- **Consumers**: `components/SettingsModal.tsx` (provider panel) and
  `components/AppSidebar.tsx` (one-time localStorage migration), client provider
  dropdowns (`providerStatus` in `lib/store.ts`, read via `lib/providers.ts`),
  the assistant model default, and indirectly every generation controller via
  `resolveForModel` + `getProviderRuntimeConfig`.
- **Related routes**: `/api/settings/azure-key`, `/api/settings/kie-key` (thin
  wrappers over the same rows); `/api/assistant` (chat credential);
  `/api/generate`, `/api/generate-video` (bindings + readiness).

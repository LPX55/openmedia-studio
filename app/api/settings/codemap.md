# /api/settings — settings route group

## Responsibility
Group folder for provider-credential, model-binding and desktop-integration
settings. It has **no `route.ts` of its own** — this codemap indexes the child
routes.

## Routes

| Route | Method | Purpose |
|---|---|---|
| `/api/settings/providers` | GET, PUT, POST, DELETE | **Primary store** — non-secret readiness report, credential/base-URL/deployment writes, model prefs, custom bindings, param presets |
| `/api/settings/azure-key` | GET, POST, DELETE | Presence-check / set / clear the Azure Foundry API key (thin `providers` wrapper) |
| `/api/settings/kie-key` | GET, POST, DELETE | Presence-check / set / clear the Kie.ai API key (thin `providers` wrapper) |
| `/api/settings/codex-login` | GET, POST | Start/poll a `codex login --device-auth` flow |
| `/api/settings/codex-status` | GET | Report whether the `codex-imagegen` CLI + `auth.json` are in place |

## Design
- **One credential store**: all provider secrets live in `provider_configs`
  (`lib/guest/db.ts`) — provider keys are no longer read from or written to the
  legacy `settings` key/value rows (that table still holds migration flags).
  `getProviderRuntimeConfig(providerId)` resolves DB key → env fallback
  (`KIE_API_KEY`/`KIE_API_TOKEN`, `AZURE_API_KEY`, `REPLICATE_API_TOKEN`,
  `FAL_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `POLLINATIONS_API_KEY`,
  `CHAT_API_KEY`); `codex` reports `keySource: "cli"` from
  `~/.codex/auth.json` instead of a key.
- **Readiness is owned by the adapters**, not the route: `GET providers` asks
  each registered adapter's `checkReadiness(cfg, binding)` so the report can
  never disagree with what generation will do. Azure additionally requires a
  base URL and ≥1 deployment.
- **Secrets never leave the server**: `GET providers` returns `hasKey` /
  `keySource` only; the key routes return `{ hasToken }` only.
- **Two shapes for the same data**: `azure-key` / `kie-key` are compatibility
  wrappers (`get/set/deleteAzureApiKey` → `provider_configs` row `azure`, same
  for `kie`). `DELETE` clears the stored key; env fallbacks still apply
  afterwards (and the cleared key must not resurrect on restart).
- **Codex credentials are host-level, not per-user**: a single shared
  `codex login` session (`$CODEX_HOME` or `~/.codex/auth.json`), so there is no
  key to save from the browser — hence status/login endpoints instead of a key route.
- The client learns provider readiness, per-model provider unions
  (`bindingsByModel`) and param presets from `GET /api/settings/providers`; it
  must never import `lib/providers/bootstrap` / `registry` / adapters
  (ESLint `no-restricted-imports`).

## Flow (typical)
1. Settings UI `GET providers` → badges, base URLs, deployments, per-model
   provider dropdowns, preset picker.
2. `PUT providers` with `{ providerId, apiKey?, baseUrl?, deployments?, presetId? }`
   and/or `{ modelPrefs?, customBindings? }`; `POST` is the same handler (used by
   the one-time AppSidebar localStorage migration). `DELETE ?providerId=` clears
   the key + that provider's `model_bindings` rows.
3. Key consumers read server-side only: `getKieToken`/`getKieTokenForUser`
   (`lib/getKieToken.ts`) and `getAzureToken`/`getAzureKeyForUser`
   (`lib/getAzureKey.ts`), both thin wrappers over `guest/db`.

## Integration
- **Stores**: SQLite `provider_configs`, `model_bindings` (active provider =
  `is_active = 1`, plus custom bindings), `param_presets` (`lib/guest/db.ts`);
  in-memory `codexLoginStore` (`lib/codexLoginStore.ts`).
- **Consumers**: `/api/generate`, `/api/generate-video`, `/api/assistant`,
  `/api/credit` (Kie / Azure / chat / compat keys); `resolveForModel` in every
  generation controller (bindings); `GET /api/settings/providers` feeds the
  Settings UI and client dropdowns.
- **External**: kie.ai API, Azure Foundry endpoints, OpenRouter / Pollinations /
  OpenAI-compatible backends, `codex` CLI.

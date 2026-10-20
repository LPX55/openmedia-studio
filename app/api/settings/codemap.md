# /api/settings — settings route group

## Responsibility
Group folder for provider-credential and desktop-integration settings. It has
**no `route.ts` of its own** — this codemap indexes the child routes.

## Routes

| Route | Method | Purpose |
|---|---|---|
| `/api/settings/azure-key` | GET, POST, DELETE | Presence-check / set / clear the Azure Foundry API key |
| `/api/settings/kie-key` | GET, POST, DELETE | Presence-check / set / clear the Kie.ai API key |
| `/api/settings/codex-login` | GET, POST | Start/poll a `codex login --device-auth` flow |
| `/api/settings/codex-status` | GET | Report whether the `codex-imagegen` CLI + `auth.json` are in place |

## Design
- Azure/Kie keys follow an identical shape: `GET` returns only a boolean
  (`{ hasToken }` — the secret is never echoed back), `POST` upserts a trimmed
  non-empty string, `DELETE` clears it. All persistence is the SQLite settings
  table via `lib/guest/db.ts` (`get/set/deleteKieApiToken`,
  `get/set/deleteAzureApiKey`).
- Codex credentials are **host-level, not per-user**: a single shared
  `codex login` session (`$CODEX_HOME` or `~/.codex/auth.json`), so there is no
  key to save from the browser — hence status/login endpoints instead of a key route.

## Flow (typical)
1. Settings UI `GET` → show whether a key is configured (badge).
2. `POST` with `{ azureApiKey }` / `{ kieApiToken }` to save; `DELETE` to remove.
3. Key consumers read server-side only: `getKieToken`/`getKieTokenForUser`
   (`lib/getKieToken.ts`) and `getAzureToken`/`getAzureKeyForUser` (`lib/getAzureKey.ts`),
   with `KIE_API_TOKEN` / `AZURE_API_KEY` env fallbacks.

## Integration
- **Stores**: SQLite settings (`lib/guest/db.ts`), in-memory `codexLoginStore`
  (`lib/codexLoginStore.ts`).
- **Consumers**: `/api/generate`, `/api/generate-video`, `/api/assistant`,
  `/api/credit` (Kie); `/api/generate`, `/api/assistant` (Azure);
  `/api/generate` (`codexProvider`), `/api/settings/codex-status` (Codex CLI).
- **External**: kie.ai API, Azure Foundry endpoints, `codex` CLI.

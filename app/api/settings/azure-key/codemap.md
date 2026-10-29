# /api/settings/azure-key — Azure API key CRUD

## Responsibility
Stores/removes the Azure Foundry API key and exposes only its presence to the
client (the secret itself is never sent back). Compatibility wrapper — the same
row is reachable through `PUT/DELETE /api/settings/providers`.

## Design
- Three verbs over one resource, no query params, no path params:
  - `GET` → `{ hasToken: boolean }` (`getAzureApiKey()` → `provider_configs`
    row `azure`, presence only — drives the key-set badge).
  - `POST` body `{ azureApiKey: string }` → validates non-empty string after trim
    (400 `azureApiKey is required` otherwise) → `setAzureApiKey(trimmed)` → `{ ok: true }`.
  - `DELETE` → `deleteAzureApiKey()` → `{ ok: true }` (no error if unset).
- Persistence is synchronous SQLite (`provider_configs`); no encryption — the key
  lives in the local DB.
- `DELETE` clears the DB key only: the `AZURE_API_KEY` env fallback still applies
  to readers, but the cleared key does not resurrect on restart.

## Flow
1. Verb dispatch → validate (POST) → get/set/delete → JSON result.

## Integration
- **Store**: `lib/guest/db.ts` — `getAzureApiKey`, `setAzureApiKey`,
  `deleteAzureApiKey` (all over `provider_configs`).
- **Readers**: `lib/getAzureKey.ts` (`getAzureToken(req)`, `getAzureKeyForUser()`)
  with the `AZURE_API_KEY` env fallback — used by `/api/generate` (Azure binding)
  and `/api/assistant` (`azure-auto`).
- **Request/Response**: `GET → { hasToken }`; `POST { azureApiKey } → { ok }`
  | 400; `DELETE → { ok }`.
- **Related**: `/api/settings/providers` (base URL + deployments, which Azure
  also needs before it is ready).

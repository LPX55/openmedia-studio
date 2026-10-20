# /api/settings/azure-key — Azure API key CRUD

## Responsibility
Stores/removes the Azure Foundry API key in local settings and exposes only its
presence to the client (the secret itself is never sent back).

## Design
- Three verbs over one resource, no query params, no path params:
  - `GET` → `{ hasToken: boolean }` (presence only — drives the key-set badge).
  - `POST` body `{ azureApiKey: string }` → validates non-empty string after trim
    (400 `azureApiKey is required` otherwise) → `setAzureApiKey(trimmed)` → `{ ok: true }`.
  - `DELETE` → `deleteAzureApiKey()` → `{ ok: true }` (no error if unset).
- Persistence is synchronous SQLite (settings table); no encryption noted —
  key lives in the local DB.

## Flow
1. Verb dispatch → validate (POST) → get/set/delete → JSON result.

## Integration
- **Store**: `lib/guest/db.ts` — `getAzureApiKey`, `setAzureApiKey`, `deleteAzureApiKey`.
- **Readers**: `lib/getAzureKey.ts` (`getAzureToken(req)`, `getAzureKeyForUser()`)
  with `AZURE_API_KEY` env fallback — used by `/api/generate` (Azure image branch)
  and `/api/assistant` (`azure-auto`).
- **Request/Response**: `GET → { hasToken }`; `POST { azureApiKey } → { ok }`
  | 400; `DELETE → { ok }`.

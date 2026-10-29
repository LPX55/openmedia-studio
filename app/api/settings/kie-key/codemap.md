# /api/settings/kie-key — Kie.ai API key CRUD

## Responsibility
Stores/removes the Kie.ai API key and exposes only its presence to the client.
Compatibility wrapper — the same row is reachable through
`PUT/DELETE /api/settings/providers`.

## Design
- Mirror of `/api/settings/azure-key` with the same three verbs:
  - `GET` → `{ hasToken: boolean }` (`getKieApiToken()` → `provider_configs`
    row `kie`).
  - `POST` body `{ kieApiToken: string }` → trim + non-empty check
    (400 `kieApiToken is required`) → `setKieApiToken(trimmed)` → `{ ok: true }`.
  - `DELETE` → `deleteKieApiToken()` → `{ ok: true }`.
- Synchronous SQLite write; the secret is never echoed on `GET`.
- `DELETE` clears the DB key only; the `KIE_API_KEY` / `KIE_API_TOKEN` env
  fallbacks still apply to readers.

## Flow
1. Verb dispatch → validate (POST) → get/set/delete → JSON result.

## Integration
- **Store**: `lib/guest/db.ts` — `getKieApiToken`, `setKieApiToken`,
  `deleteKieApiToken` (all over `provider_configs`).
- **Readers**: `lib/getKieToken.ts` (`getKieToken(req)`, `getKieTokenForUser()`)
  with the `KIE_API_KEY` / `KIE_API_TOKEN` env fallback — used by `/api/credit`,
  `/api/assistant`, `/api/generate`, `/api/generate-video`, and the Kie
  adapter's media re-hosting.
- **Request/Response**: `GET → { hasToken }`; `POST { kieApiToken } → { ok }`
  | 400; `DELETE → { ok }`.
- **Related**: `/api/settings/providers` (readiness report, base URL, model
  bindings).

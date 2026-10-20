# /api/settings/kie-key — Kie.ai API key CRUD

## Responsibility
Stores/removes the Kie.ai API key in local settings and exposes only its
presence to the client.

## Design
- Mirror of `/api/settings/azure-key` with the same three verbs:
  - `GET` → `{ hasToken: boolean }`.
  - `POST` body `{ kieApiToken: string }` → trim + non-empty check
    (400 `kieApiToken is required`) → `setKieApiToken(trimmed)` → `{ ok: true }`.
  - `DELETE` → `deleteKieApiToken()` → `{ ok: true }`.
- Synchronous SQLite write; secret never echoed on `GET`.

## Flow
1. Verb dispatch → validate (POST) → get/set/delete → JSON result.

## Integration
- **Store**: `lib/guest/db.ts` — `getKieApiToken`, `setKieApiToken`, `deleteKieApiToken`.
- **Readers**: `lib/getKieToken.ts` (`getKieToken(req)`, `getKieTokenForUser()`)
  with `KIE_API_TOKEN` env fallback — used by `/api/credit`, `/api/assistant`,
  `/api/generate`, `/api/generate-video`, and `lib/kieUpload.ts` re-hosting.
- **Request/Response**: `GET → { hasToken }`; `POST { kieApiToken } → { ok }`
  | 400; `DELETE → { ok }`.

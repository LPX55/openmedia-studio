# /api/credit — Kie.ai credit balance proxy

## Responsibility
Proxies the kie.ai credit endpoint so the browser sees the account balance
without holding the API key.

## Design
- `GET` only, no query params, no body.
- Key resolution: `getKieToken(req)` (`lib/getKieToken.ts`) — the stored
  `provider_configs` row `kie`, else the `KIE_API_KEY` / `KIE_API_TOKEN` env
  fallback. Absent → **401**
  `{ error: "No API key configured for this provider. Add one in Settings." }`.
- Upstream call carries `next: { revalidate: 60 }` — the balance is cached for
  60 s at the Next fetch layer, limiting burn against the provider rate limit.
- Response body is passed through verbatim; upstream failure mirrors the
  upstream status with `{ error: "Failed to fetch credit" }`.

## Flow
1. Resolve key → fetch `GET https://api.kie.ai/api/v1/chat/credit`
   with `Authorization: Bearer <key>`.
2. Return upstream JSON unchanged.

## Integration
- **Kie.ai**: `GET /api/v1/chat/credit` (Bearer).
- **Auth source**: `lib/getKieToken.ts` → `getKieApiToken()` in `lib/guest/db.ts`
  (`provider_configs`, written by `/api/settings/providers` or the legacy
  `/api/settings/kie-key`).
- **Consumers**: credit/balance display in the header.
- **Response**: raw Kie JSON (shape owned by provider), or `{ error }`.

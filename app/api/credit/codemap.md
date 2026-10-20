# /api/credit — Kie.ai credit balance proxy

## Responsibility
Proxies the kie.ai credit endpoint so the browser sees the account balance
without holding the API key.

## Design
- `GET` only, no query params, no body.
- Key resolution: `getKieToken(req)` (`lib/getKieToken.ts`, settings DB →
  `KIE_API_TOKEN` env). Absent → **401**
  `{ error: "No Kie.ai API key configured. Add one in Settings." }`.
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
- **Auth source**: `lib/getKieToken.ts` ← `/api/settings/kie-key` (SQLite settings)
  or `KIE_API_TOKEN`.
- **Consumers**: credit/balance display in the header.
- **Response**: raw Kie JSON (shape owned by provider), or `{ error }`.

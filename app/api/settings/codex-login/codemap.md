# /api/settings/codex-login — device-code login driver

## Responsibility
Runs the host's `codex login --device-auth` flow, surfaces the verification URL +
code to the UI, and tracks the login verdict so the Settings panel can show
pending/success/error without holding any credential itself.

## Design
- State lives in an in-memory singleton `codexLoginStore` (`lib/codexLoginStore.ts`),
  polled by the client via `GET`.
- `CODE_LIFETIME_MS = 16 min` (device-code expiry + slack).
- `GET` → `codexLoginStore.get()` verbatim.
- `POST`:
  - **Guard**: if a pending code is younger than `CODE_LIFETIME_MS`, return it —
    never spawn a second `codex login` (the CLI wipes existing credentials when a
    new login starts, so a concurrent attempt would log the host out).
  - Spawn `codex login --device-auth`; stream stdout/stderr through `stripAnsi`,
    settle the promise as soon as both a URL (`https://…`) and a code
    (`XXXX-XXXX[X]`) regex match → store `{ status: "pending", url, code, startedAt }`.
  - 10 s fallback → `{ status: "error", error: "Timed out waiting for codex login to print a device code." }`.
  - Spawn failure → `{ status: "error", error: "codex spawn failed: …" }`.
  - The CLI keeps polling in the background after the code prints; on `close`
    `confirmLoggedIn()` decides the final verdict — up to 6 × 1 s retries checking
    either `auth.json` presence (the CLI rewrites it only on success) or
    `codex login status` output anchored with `/^logged in/im` (so "Not logged in"
    can't false-match) — then stores `{ status: "success" }` or
    `{ status: "error", error: <last 300 chars> }`. Frontend keeps polling `GET`.

## Flow
1. `GET` → current store state.
2. `POST` → (reuse pending code | spawn CLI) → parse device code → return `pending`
   state → CLI exit → `confirmLoggedIn()` → store final state.

## Integration
- **Host**: `codex` CLI (`login --device-auth`, `login status`), `CODEX_HOME`/`~/.codex/auth.json`.
- **Store**: `lib/codexLoginStore.ts` (in-memory, process-scoped).
- **Related**: `/api/settings/codex-status` (readiness badge);
  `/api/generate` `codexProvider` consumes the resulting shared session.
- **Response**: `GET/POST → { status: "pending", url, code, startedAt } |
  { status: "success" } | { status: "error", error }`.

# /api/settings/codex-status — Codex readiness probe

## Responsibility
Reports whether the host-level Codex image-generation setup is ready, for the
"READY / NOT CONFIGURED" badge. `codex-imagegen` has no per-user credentials —
it reuses the single shared `codex login` session on this host.

## Design
- `GET` only.
- Two facts computed in parallel:
  - `installed` — spawn `codex-imagegen --help`; `error` event → `false`
    (binary missing), `close` → `code === 0`.
  - `authFound` — `existsSync($CODEX_HOME/auth.json)` with
    `~/.codex/auth.json` fallback.
- `ready = installed && authFound`.

## Flow
1. `Promise.all` the binary probe + `auth.json` existence check.
2. Return `{ installed, authFound, ready }`.

## Integration
- **Host**: `codex-imagegen` CLI on PATH; `CODEX_HOME` env / `~/.codex/auth.json`.
- **Sibling**: `/api/settings/codex-login` (performs the login that creates
  `auth.json`); consumer `/api/generate` `codexProvider` branch.
- **Response**: `{ installed: boolean, authFound: boolean, ready: boolean }`.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Commands (pnpm-pinned, Node 22+)

- Repo pins `pnpm@9.15.9` (`packageManager`); prefer `pnpm` over the `npm` commands in README. Requires Node 22+ (`node:sqlite` has no fallback).
- `pnpm dev` / `pnpm build` / `pnpm start` (`PORT` supported). Plain `next dev`/`build` leave `DESKTOP_BUILD` unset — that is correct for browser dev.
- No test runner. Verify with: `npx tsc --noEmit`, `pnpm lint` (or `npx eslint <touched-files>`), plus the relevant offline script:
  - `node scripts/check-workflows.mjs` — workflow-template validator (~600 assertions, stubbed fetch, zero network).
  - `node scripts/providers/smoke-compat.mjs` — provider smoke fixture (stubbed fetch, zero network).
- Desktop: `pnpm desktop:dev` (next dev + `tauri dev`, no sidecar) / `pnpm desktop:build` (runs `check-version` first). See `DESKTOP.md` for signing/data-dir details.

## Architecture (read `codemap.md` first)

- Root `codemap.md` + per-folder `codemap.md` files are the repo map — read them before working, not leaf files at random. Path alias: `@/*` → repo root.
- App Router: `app/layout.tsx` shell → `/` redirects to `/gallery`; canvas editor `app/workflow/[id]/page.tsx` (dynamic `WorkflowCanvas` + `useSpaceSync`); gallery, chat (SSE to `/api/assistant`).
- Generation flow: canvas (`components/WorkflowCanvas.tsx`, nodes in `components/nodes/`, `usePipelineRunner` → `lib/executor.ts` waves) → POST `/api/generate` or `/api/generate-video` → `lib/jobStore` + `lib/kieJobPoller` → poll `/api/job-status` or subscribe `/api/job-stream` (SSE via `lib/jobEvents.ts`). State: `lib/store.ts` (Zustand, `NodeData` contract); models: `lib/modelConfig.ts` + `lib/providers.ts` (catalog vs bindings, dialect is binding data).
- Persistence is server-only `lib/guest/` (SQLite via `node:sqlite`, `spaces.ts`, `db.ts`). `DATA_DIR`/`MEDIA_DIR` resolve from `HELIOS_DATA_DIR`/`HELIOS_MEDIA_DIR` else `data/` and `public/generated/` (both gitignored; delete to reset). Media URLs stay `/generated/...`, served by `app/generated/[...path]/route.ts` even when bytes live outside `public/`. API keys live in SQLite via Settings UI; `.env` is optional (`KIE_API_KEY`, `AZURE_API_KEY` fallbacks only).
- Provider docs: `docs/compat-endpoints.md` (verified-live registry), `docs/provider-*.md` (migration/refactor history). Param presets are code-seeded (`param_presets` table, 4 presets); resolution order is `preset ← binding.paramMap ← custom overrides`, openai-compat family only.

## Constraints

- **Never import server-only provider modules into client bundles.** ESLint `no-restricted-imports` errors on `@/lib/providers/bootstrap`, `registry`, `mediaStager`, `adapters/*` from `components/**`, `app/**/page.*`, `lib/providers.ts`, `lib/store.ts`. Client gets readiness/prefs from `GET /api/settings/providers`. `types.ts`/`bindings.ts` (pure data) are allowed.
- `next.config.ts`: `DESKTOP_BUILD=1` switches on `output: standalone` (packaged Tauri sidecar only); `src-tauri/**` is excluded from tracing/lint/tsconfig. Don't touch `output`, `outputFileTracing*`, or `serverExternalPackages: ["undici"]` without a desktop-build reason.
- Version files must agree: `package.json` + `src-tauri/tauri.conf.json` + `src-tauri/Cargo.toml` + `Cargo.lock` (`node scripts/desktop/check-version.mjs`; CI `version-check` fails tag pushes on mismatch). Do not rename `src-tauri` `productName`/bundle id `cash.sdd.helios.desktop` — breaks desktop update continuity.
- shadcn: `components.json` (`style: base-nova`, css `app/globals.css`, icons `lucide`, aliases `@/components`, `@/lib`, `@/hooks`). Primitives on `@base-ui/react`.

## Repository Map

A full codemap is available at `codemap.md` in the project root.

Before working on any task, read `codemap.md` to understand:
- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md`.

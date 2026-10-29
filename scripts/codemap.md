# scripts/

Build, dev, release, and offline-validation automation for the project. All
scripts are plain Node ESM (`.mjs`) or JS run directly with `node` — no build
step, no framework.

## Responsibility

Developer/CI entry points that don't belong in app code:

- `scripts/desktop/` — the Tauri desktop shell toolchain (dev runner, sidecar
  build/stage, version guard, macOS signing env template). See
  `scripts/desktop/codemap.md` for details.
- `scripts/check-workflows.mjs` — offline structural validator for the workflow
  template pack in `lib/workflowTemplates.ts`: unique template/node ids, edge
  endpoints exist and are not self-loops, every model id is in the catalog,
  image/video ratios/quality/duration are supported, incoming handles are
  declared by the model, single-slot handles (`prompt`/`startFrame`/`endFrame`)
  are wired once, every generator has a prompt source (assistant sources use
  `textOut`), reference inputs carry content, generators start `idle` (except
  `legacy` templates), and `nodeCounters` match the real per-type counts.
- `scripts/providers/smoke-compat.mjs` — permanent offline smoke fixture for the
  openai-compat provider family (OpenRouter + Pollinations): registry aliases,
  static bindings, request bodies/dialect fields via a stubbed `fetch`, response
  mapping, per-operation media staging, readiness gates, param presets and
  resolution order, the settings endpoint (`GET`/`PUT`), the job trail
  (cap/redaction/bounded retry) and the run-log read API, the async video lane
  (bindings, submit body, caps/clamping, six poll states) and the
  `POST /api/generate-video` controller. One opt-in live OpenRouter call.

## Design

- Each script is self-contained, derives its paths from `import.meta.url`
  (`ROOT = join(dirname(fileURLToPath(import.meta.url)), …)`), and is invoked by
  name from `package.json` scripts or Tauri `before*Command` hooks.
- **No build step for TS**: both validators register a `node:module` resolve
  hook (`register("data:text/javascript,…")`) that maps the repo's `@/…` alias
  to `ROOT` and retries extensionless imports with `.ts`/`/index.ts`/`.tsx`, so
  they can import app modules directly under Node 22's type-stripping.
- **Self re-exec**: both re-spawn themselves once with
  `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON` (the repo has no
  `"type": "module"`), forwarding `process.execArgv`/`argv`; the child's exit
  code is the script's.
- **Zero network**: `check-workflows.mjs` only imports `modelConfig.ts` +
  `workflowTemplates.ts`; `smoke-compat.mjs` stubs `globalThis.fetch`
  (recording calls and returning canned responses) and restores it in a
  `finally`. The live step is gated on `OPENROUTER_API_KEY` +
  `HELIOS_SMOKE_LIVE=1` and skipped by default.
- **Isolated scratch state**: `smoke-compat.mjs` sets `HELIOS_MEDIA_DIR` /
  `HELIOS_DATA_DIR` under `public/generated/.smoke-compat` BEFORE importing any
  app module (`lib/guest/paths.ts` reads env at import time) and removes the
  directory at the end; it also silences repo `console.log` unless
  `HELIOS_SMOKE_VERBOSE=1`.
- **Tiny assertion harness**: `ok()`/`eq()`/`section()` accumulate passes and
  failures; output is `✓ …` on success, `✗`-prefixed lines + exit 1 on failure.
  `check-workflows.mjs` reports `N templates, M assertions passed` (several
  hundred assertions, ~600 today).

## Flow

Human or CI runs a `package.json` script → script operates on the repo tree
directly (read manifests, import app TS through the resolve hook, run
`next`/`cargo`/`npm` via `execFileSync`, stage files).

- `node scripts/check-workflows.mjs` (or `pnpm check:workflows`): re-exec →
  resolve hook → import `IMAGE_MODELS`/`VIDEO_MODELS` + `WORKFLOW_TEMPLATES` →
  per-template graph checks → exit 0/1.
- `node scripts/providers/smoke-compat.mjs` (or `pnpm smoke:providers`): re-exec
  → resolve hook → scratch dirs → import bootstrap/bindings/types/stager/
  modelConfig → registry + binding + stubbed-fetch request/response checks →
  media staging + readiness → presets (incl. a fresh SQLite reopen) → settings
  route → Pollinations leg → job trail/retry + log route → video bindings/body/
  caps/polling + generate-video route → optional live call → cleanup → exit 0/1.

## Integration

- `package.json`:
  - `desktop:dev` → `scripts/desktop/dev.mjs`
  - `desktop:check-version` → `scripts/desktop/check-version.mjs`
  - `desktop:build` → `node scripts/desktop/check-version.mjs && CI=true tauri build`
  - `check:workflows` → `scripts/check-workflows.mjs`
  - `smoke:providers` → `scripts/providers/smoke-compat.mjs`
- `src-tauri/tauri.conf.json`: `beforeDevCommand` → `build-server.mjs --dev`,
  `beforeBuildCommand` → `build-server.mjs`.
- CI (GitHub Actions) calls the version check with `$GITHUB_REF_NAME` as the
  release tag.
- Validators are the offline gate named in `AGENTS.md`; they import only app
  modules (`lib/modelConfig`, `lib/workflowTemplates`, `lib/providers/*`,
  `lib/jobStore`/`jobLog`, `lib/guest/*`, `app/api/*` route handlers) and are
  safe to run with no API keys, no DB, and no server.

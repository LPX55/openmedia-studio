# scripts/providers/

Offline validation fixtures for the provider layer. Plain Node ESM, no
dependencies, no build step, no network.

## Responsibility

- **`smoke-compat.mjs`** — the permanent smoke fixture for the openai-compat
  provider family (OpenRouter + Pollinations). It boots the real provider
  registry and exercises, with a stubbed `fetch`:
  1. registry — the `openrouter`/`pollinations` backend aliases and the family
     adapter's capabilities;
  2. static OpenRouter image bindings (19) — upstream ids, base URL, endpoint
     path, key env, dialect fields, value maps, ref caps, per-model provider
     union;
  3. request body — URL, auth header, dialect body (`model` / `prompt` /
     `aspect_ratio` / `resolution` / `input_references`), "undeclared field is
     not sent", upstream reference cap;
  4. response mapping — `b64_json` → raw buffer, `url` → media url, 401 →
     invalid-key error;
  5. media staging — strategy per operation (`data-url` for the compat family,
     `multipart-buffer` for Azure edits) on a local fixture file;
  6. readiness — key + base URL gates (db key, `keyEnv` fallback, missing key,
     missing base URL);
  7. param presets — seeded ids/family, valid JSON, no duplicates on reopen,
     resolution order (`preset ← binding.paramMap ← custom override`), loud
     failure on an unknown preset id;
  8. settings endpoint — `GET /api/settings/providers` (label, key source, base
     URL, readiness, provider union, preset list) and `PUT` `presetId`
     accept/reject;
  9. Pollinations — 11 image bindings, dialect body (width/height/seed/image),
     media-store upload for `remote-url` staging, settings entry;
  10. job trail + bounded retry — 50-entry cap, trail survives a status write,
      redaction (keys / `data:` payloads / URL userinfo), DNS failure retried
      exactly once, HTTP 5xx not retried;
  11. run-log read API — `GET /api/jobs/[taskId]/log` 200 for known and unknown
      ids (never 500);
  12. OpenRouter video lane — 12 bindings, video dialect body, `auto` ratio
      dropped, duration clamped, async submit (`202` + `polling_url` → absolute
      status URL), all six poll statuses, raw-bytes completion, URL fallback,
      and the `POST /api/generate-video` controller path.
- **Live step (opt-in)** — one real OpenRouter image submit, only when
  `OPENROUTER_API_KEY` is set AND `HELIOS_SMOKE_LIVE=1`; skipped otherwise.

## Design

- **TS without a build**: registers a `node:module` resolve hook that maps
  `@/…` to the repo root and retries extensionless imports with
  `.ts` / `/index.ts` / `.tsx`, then imports repo modules by
  `pathToFileURL(...)`. Runs on Node >= 22.18 (native type stripping); no
  tsx/esbuild/dependency.
- **Self re-exec**: spawns itself once with
  `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON` (repo has no
  `"type": "module"`) and forwards `execArgv`/`argv`; the child's exit code is
  the script's. The `warning` listener also filters that one warning.
- **Isolated state before imports**: `HELIOS_MEDIA_DIR` and `HELIOS_DATA_DIR`
  are pointed under `public/generated/.smoke-compat` (gitignored) BEFORE any
  app module loads, because `lib/guest/paths.ts` reads env at import time. The
  directory is removed in a `finally`; a fresh SQLite module instance is loaded
  with a `?reopen=1` query to prove preset seeding is duplicate-free.
- **Stubbed network**: `globalThis.fetch` is replaced with a recorder
  (`capturedCalls`) plus a settable `stubbedResponse` factory
  (`fakeResponse()` supports JSON, raw bytes, non-2xx); the real fetch is
  restored in `finally`. `quiet()` mutes repo `console.log` unless
  `HELIOS_SMOKE_VERBOSE=1`.
- **Assertion harness**: `ok(name, condition, detail)` / `eq(name, actual,
  expected)` / `section(title)` accumulate `passed` + `failures`; output is
  `✓ …` or `✗`-prefixed lines with exit 1. A crash is recorded as one failure,
  never a stack-only exit.
- **Fixtures**: inline PNG/MP4 byte buffers, a local reference image on disk,
  fake credentials (`sk-or-smoke-key`), and `ProviderMeta` objects shaped like
  the real `jobStore.ProviderMeta`.
- **Route-level, not HTTP**: route handlers (`app/api/settings/providers`,
  `app/api/jobs/[taskId]/log`, `app/api/generate-video`) are imported and called
  directly with `NextRequest`, so the controller path is covered without a
  server.

## Flow

`main()`: create scratch dir → import bootstrap/bindings/types/stager/
modelConfig → registry section → static bindings → stubbed request body →
reference cap + url mapping → staging → readiness → presets (incl. fresh
SQLite reopen) → settings GET/PUT → Pollinations bindings/body/upload/settings →
client-surface source checks → job trail/retry → log route → video
bindings/body/caps/polling → generate-video route → optional live call →
cleanup → report `✓ N assertions passed` / exit 0, or failures / exit 1.

## Integration

- `package.json`: `smoke:providers` → `node scripts/providers/smoke-compat.mjs`
  (named in `AGENTS.md` as the provider offline gate).
- Imports: `lib/providers/{bootstrap,bindings,types,mediaStager,registry,
  presets}.ts`, `lib/modelConfig.ts`, `lib/guest/{db,sqlite}.ts`,
  `lib/jobStore.ts`, `lib/jobLog.ts`, and the three `app/api/*` route handlers.
- Requires Node >= 22.18, zero network, zero API keys by default; the only
  writes are inside `public/generated/.smoke-compat` (removed at the end).

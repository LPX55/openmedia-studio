# app/api — Route Overview

Next.js App Router route handlers for OpenMedia Studio — **28 route files** across
six domains. Data routes are guest-scoped (`GUEST_USER_ID` from `lib/guestMode`)
and persist to the local SQLite DB (`lib/guest/db.ts`) plus local disk media
(`lib/storage.ts` → `lib/guest/localStorage.ts`, served same-origin under
`/generated/...`). Names like `cdnUrl`, `ensureR2`, `r2_url` are legacy —
everything writes to `MEDIA_DIR` (`lib/guest/paths.ts`). Settings routes are
host-level (no user scoping).

`generate` and `generate-video` are now **thin, provider-agnostic controllers**
(Phase 4): `resolveForModel` (`lib/providers/bootstrap`) picks the backend from
the explicit `providerId`, the model's active `model_bindings` row, or the static
Kie default; `stageInputMedia` (`lib/providers/mediaStager`) normalizes reference
media; and `submitJob` (`lib/jobManager`) mints the `taskId` and owns the whole
job lifecycle. Provider dialects live only in `lib/providers/adapters/*`
(`generate-image` is the legacy Replicate path and still polls inline).

Long-running generations are fire-and-forget: those controllers return a
`taskId` immediately, `provider.submit()` runs in a managed background task, the
result lands in the in-memory `jobStore` (`lib/jobStore.ts`) via `settleJob`, and
clients read it through `/api/job-status`, `/api/job-stream` or
`/api/jobs/[taskId]/log`.

## Routes by domain

### Generation

| Route | Method | Purpose |
|---|---|---|
| `/api/generate` | POST | Image generation via the resolved provider (Kie / Azure Foundry / Codex CLI / openai-compat) |
| `/api/generate-video` | POST | Video generation via the resolved provider (Kie's 9 video families, OpenRouter `/videos`) |
| `/api/generate-image` | POST | Simple sync image generation via Replicate (`flux-schnell` / `flux-dev` / `sdxl`), legacy path |
| `/api/assistant` | POST | Streaming chat completions proxy (BYOK chat credential, Kie Claude/OpenAI-compat, Azure model-router) |
| `/api/workflows` | GET, PUT | CRUD for local workflow "space" documents (`lib/guest/spaces.ts`) |

### Assets (upload / ingest / media tools)

| Route | Method | Purpose |
|---|---|---|
| `/api/upload` | POST | Accepts base64 `data:` URL or remote `http(s)` URL, mirrors to disk |
| `/api/upload-asset` | POST | Unified raw-binary upload (image or video), SHA-256 dedupe, ≤100 MB |
| `/api/upload-video` | POST | Raw-binary video-only upload, ≤100 MB |
| `/api/fetch-url` | POST | Server-side fetch of remote image/video, stores locally (≤50 MB) |
| `/api/lookup-asset` | GET | Hash → CDN URL lookup so clients can skip redundant uploads |
| `/api/download` | GET | Download proxy that adds `Content-Disposition: attachment` (allow-listed origins, edge runtime) |
| `/api/extract-frame` | POST | ffmpeg single-frame JPEG extraction from a video URL |
| `/api/trim-video` | POST | ffmpeg stream-copy trim of a video URL |

### Folders / gallery

| Route | Method | Purpose |
|---|---|---|
| `/api/folders` | GET, POST | List folders + folder items; create folder |
| `/api/folders/[id]` | PATCH, DELETE | Rename/reorder/recolor; delete folder |
| `/api/folder-items` | POST, DELETE | Add/remove items (generation & upload ids) in a folder |
| `/api/gallery` | GET, DELETE | Paginated merge of generations + uploads; delete an item |

### Jobs

| Route | Method | Purpose |
|---|---|---|
| `/api/job-status` | GET | One-shot poll of `jobStore`, with `resumeJob` recovery + DB fallback |
| `/api/job-stream` | GET | SSE stream that emits the settled job result (12-min cap, 25-s heartbeat) |
| `/api/jobs/[taskId]/log` | GET | **NEW** — the job's event trail (`lib/jobLog.ts`), falling back to `generations.job_log`; never 500s |

### Settings

| Route | Method | Purpose |
|---|---|---|
| `/api/settings/providers` | GET, PUT, POST, DELETE | **NEW** — unified provider credential/config store + non-secret readiness report |
| `/api/settings/azure-key` | GET, POST, DELETE | Presence-check / set / clear Azure API key (thin wrapper over `provider_configs`) |
| `/api/settings/kie-key` | GET, POST, DELETE | Presence-check / set / clear Kie.ai API key (thin wrapper over `provider_configs`) |
| `/api/settings/codex-login` | GET, POST | Drive `codex login --device-auth`; poll login state |
| `/api/settings/codex-status` | GET | Report `codex-imagegen` install + `auth.json` presence |

`/api/settings/codemap.md` documents the group (there is no `app/api/settings/route.ts`).

### Misc

| Route | Method | Purpose |
|---|---|---|
| `/api/credit` | GET | Kie.ai credit balance proxy (60-s revalidate) |
| `/api/open-external` | POST | Open a URL in the OS browser (desktop webview traps `window.open`) |
| `/api/update-check` | GET | Compare `NEXT_PUBLIC_APP_VERSION` against GitHub latest release (1-h cache) |

## Recent changes

**New routes**
- `app/api/jobs/[taskId]/log/route.ts` — read side of `lib/jobLog.ts`: the
  per-job submit → poll → settle trail, `jobStore` first then the
  `generations.job_log` copy; consumed by `components/JobLogViewer.tsx`.
- `app/api/settings/providers/route.ts` — replaces ad-hoc key routes as the
  client's single source of provider readiness, per-model provider unions and
  param presets; secrets stay server-side (`hasKey` / `keySource` only).

**Rewritten**
- `generate` / `generate-video` — from monolithic, provider-branching controllers
  to thin `resolveForModel → stageInputMedia → submitJob` controllers; provider
  payload builders moved into `lib/providers/adapters/*`.
- `job-status` / `job-stream` — the `azure-*` / `codex-*` prefix shortcuts are
  gone; recovery goes through `resumeJob` (C2 live-job guard) and every job has
  a `generations` row.
- `assistant` — model resolution is client model → stored `chatModel` → default;
  BYOK chat credential preferred over Kie/Azure.
- `credit`, `fetch-url`, `update-check` — unchanged contracts, re-verified
  against source; `azure-key` / `kie-key` now write `provider_configs` instead
  of the legacy `settings` rows.

## Cross-cutting conventions

- Request bodies are JSON unless stated raw-binary; validation failures → 400 with `{ error }`.
- Missing provider readiness → 401 carrying the adapter's `checkReadiness().reason`
  (e.g. "No API key configured for this provider. Add one in Settings.").
- Task ids are minted by `submitJob` as `<providerId>-<epoch>-<uuid8>`; every job
  (Kie, Azure, Codex, compat) gets a pending `generations` row *before* the
  upstream call, so all jobs are recoverable after a restart. Live in-process
  jobs are tracked by `lib/jobManager` (`activeSubmits` / `activePollers`).
- Upload routes record rows via `guestDb.insertUpload`; registry-backed generation
  routes via `guestDb.insertGeneration` (inside `submitJob`); completion via
  `guestDb.updateGeneration` (inside `settleJob`).
- Controllers import `@/lib/providers/bootstrap`, never an adapter or the
  server-only registry directly (ESLint `no-restricted-imports`).
- `maxDuration` is set per route (60–1000 s); `/api/download` runs on the edge
  runtime, the rest on Node.

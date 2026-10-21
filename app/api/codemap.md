# app/api — Route Overview

Next.js App Router route handlers for OpenMedia Studio. All routes are guest-scoped
(`GUEST_USER_ID` from `lib/guestMode`) and persist to the local SQLite DB
(`lib/guest/db.ts`) plus local disk media (`lib/storage.ts` → `lib/guest/localStorage.ts`,
served same-origin under `/generated/...`). Names like `cdnUrl`, `ensureR2`,
`r2_url` are legacy — everything writes to `MEDIA_DIR` (`lib/guest/paths.ts`).

Long-running generations are fire-and-forget: routes return a `taskId` immediately,
the result lands in the in-memory `jobStore` (`lib/jobStore.ts`) via
`lib/kieJobPoller.ts`, and clients read it through `/api/job-status` or `/api/job-stream`.

## Routes by domain

### Generation

| Route | Method | Purpose |
|---|---|---|
| `/api/generate` | POST | Image generation; branches to Azure Foundry, `codex-imagegen` CLI, or kie.ai |
| `/api/generate-video` | POST | Video generation over kie.ai (Kling, Veo, MiniMax H3, Seedance, Grok, Gemini Omni, HappyHorse …) |
| `/api/generate-image` | POST | Simple sync image generation via Replicate (`flux-schnell` / `flux-dev` / `sdxl`) |
| `/api/assistant` | POST | Streaming chat completions proxy (Kie Claude/OpenAI-compat models, Azure model-router) |
| `/api/workflows` | GET, PUT | CRUD for local workflow "space" documents (`lib/guest/spaces.ts`) |

### Assets (upload / ingest / media tools)

| Route | Method | Purpose |
|---|---|---|
| `/api/upload` | POST | Accepts base64 `data:` URL or remote `http(s)` URL, mirrors to disk |
| `/api/upload-asset` | POST | Unified raw-binary upload (image or video), SHA-256 dedupe, ≤100 MB |
| `/api/upload-video` | POST | Raw-binary video-only upload, ≤100 MB |
| `/api/fetch-url` | POST | Server-side fetch of remote image/video, stores locally (≤50 MB) |
| `/api/lookup-asset` | GET | Hash → CDN URL lookup so clients can skip redundant uploads |
| `/api/download` | POST-less GET | Download proxy that adds `Content-Disposition: attachment` (allow-listed origins, edge runtime) |
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
| `/api/job-status` | GET | One-shot poll of `jobStore`, with DB recovery after restart |
| `/api/job-stream` | GET | SSE stream that emits the settled job result (12-min cap, 25-s heartbeat) |
| `/api/jobs/[taskId]/log` | GET | The job's event trail (`lib/jobLog.ts`): `{ taskId, status, providerId, model, trail[], recoveredFromDb }` — falls back to the `generations` row, never 500s |

### Settings

| Route | Method | Purpose |
|---|---|---|
| `/api/settings/azure-key` | GET, POST, DELETE | Presence-check / set / clear Azure API key |
| `/api/settings/kie-key` | GET, POST, DELETE | Presence-check / set / clear Kie.ai API key |
| `/api/settings/codex-login` | GET, POST | Drive `codex login --device-auth`; poll login state |
| `/api/settings/codex-status` | GET | Report `codex-imagegen` install + `auth.json` presence |

`/api/settings/codemap.md` documents the group (there is no `app/api/settings/route.ts`).

### Misc

| Route | Method | Purpose |
|---|---|---|
| `/api/credit` | GET | Kie.ai credit balance proxy (60-s revalidate) |
| `/api/open-external` | POST | Open a URL in the OS browser (desktop webview traps `window.open`) |
| `/api/update-check` | GET | Compare `NEXT_PUBLIC_APP_VERSION` against GitHub latest release (1-h cache) |

## Cross-cutting conventions

- Request bodies are JSON unless stated raw-binary; validation failures → 400 with `{ error }`.
- Missing provider key → 401 `{ error: "… configured. Add one in Settings." }`.
- Upload routes record rows via `guestDb.insertUpload`; generation routes via `guestDb.insertGeneration`.
- Task ids are namespaced: `azure-*`, `codex-*` (memory-only, unrecoverable after restart) vs kie ids (recoverable from DB).
- `maxDuration` is set per route (30–1000 s); `/api/download` runs on the edge runtime, the rest on Node.

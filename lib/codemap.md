# lib/

Shared, framework-light core for HeliosGen: client Zustand stores, graph
execution/pipeline logic, server-side job persistence/polling, media storage
facades, and model/provider config. No `"use client"` directives here except the
React hooks — imported by both `components/` (client) and `app/api/` (server).

## Responsibility

- **Workflow state (`store.ts`)** — the central Zustand store: React Flow
  `nodes`/`edges`, multiple named *spaces* (canvases), undo/redo, toasts, API-key
  presence flags, UI flags, per-type `nodeDefaults` and `lastNodeSize`.
  `NodeData` (prompt, model params, `imageUrl`/`r2Url`/`videoUrl`, `status`,
  `taskId`, …) is the payload contract for every node component and API route.
- **Job lifecycle (server)** — `jobStore.ts` (file-backed `taskId → JobResult`),
  `jobEvents.ts` (in-process `EventEmitter` for SSE), `kieJobPoller.ts`
  (polls kie.ai in lieu of a webhook), `pendingJobs.ts` (global resolve/reject
  map for in-flight generate requests).
- **Graph execution (client)** — `executor.ts` (`topoSort`,
  `buildPipelineWaves`, `resolveInputs`), `usePipelineRunner.ts` (wave-by-wave
  orchestration), `arrangeNodes.ts` (grid layout).
- **Persistence sync** — `useSpaceSync.ts` (debounced `PUT /api/workflows`),
  `workflowSyncBus.ts` (window event to force an early flush).
- **Chat** — `chatSessionStore.ts` (persisted sessions), `chatStreamingStore.ts`
  (SSE stream state; currently has no component consumer), `systemPrompt.ts`.
- **Folders / gallery** — `folderStore.ts` (optimistic folder CRUD via REST),
  `galleryUtils.ts` (thumbnails, `getToken` stub, gallery cache).
- **Media & assets** — `storage.ts` (facade over `guest/localStorage.ts`),
  `assetCache.ts`/`assetHash.ts` (SHA-256 dedupe index), `mediaMetadata.ts`
  (EXIF/metadata strip via sharp/ffmpeg), `kieUpload.ts` (re-host local media to
  kie.ai's temp store), `makeZip.ts` + `exportWorkflow.ts`/`importWorkflow.ts`.
- **Model/provider config** — `modelConfig.ts` (single source of truth:
  `IMAGE_MODELS`/`VIDEO_MODELS` + API input mapping), `models.ts` (chat LLM
  picker), `providers.ts` (per-model backend: kie/azure/codex, localStorage),
  `getKieToken.ts`/`getAzureKey.ts` (thin wrappers over `guest/db` settings).
- **UI helpers** — `nodeTypes.tsx` (node catalog/metadata/sizes), `edgeStyles.ts`,
  `templates.ts` (UGC starter space), `textFormat.ts` (JSON/YAML detection),
  `useAnimatedPopup.ts`, `useGeneratingBorderAnimation.ts`, `useGeneratingPhase.ts`,
  `browserNotify.ts`, `readOnlyContext.ts`, `utils.ts` (`cn`).
- **Misc plumbing** — `guestMode.ts` (`GUEST_USER_ID = "guest"`, the single
  implicit user all server routes key by), `codexLoginStore.ts` (file-backed
  Codex CLI login state).

## Design

- **Zustand + persist (client)**: `store.ts`, `chatSessionStore.ts`,
  `folderStore.ts` use `persist`/`createJSONStorage(localStorage)` with keys
  `heliosgen-guest`, `heliosgen-chats-guest`, `aiui-folders-v2`.
  `store.ts` `partialize` strips base64 `inputImage` (only durable `r2Url`
  survives reload) and `onRehydrateStorage` migrates v0 flat nodes→spaces.
- **Dual-source space state**: live `nodes`/`edges`/`nodeCounters` mirror the
  *active* space; every mutation runs `syncSpace()` to write back into
  `spaces[]`. `loadSpacesFromDB()` merges DB vs local by `updatedAt` (local
  wins ties), dropping empty placeholder spaces.
- **Two-tier write coalescing**: continuous edits debounce at 1.5 s; discrete
  actions (add/remove/connect/resize-end) call `requestWorkflowSync()` →
  `SYNC_NOW_EVENT` → 250 ms arm. `useSpaceSync` gates all writes on Zustand v5
  async hydration (`hasHydrated`/`onFinishHydration`) to avoid overwriting real
  spaces with the default empty state, and flushes dirty state on
  `pagehide`/`visibilitychange` with `keepalive` fetch (≤64 KB body).
- **Three persistence tiers**:
  1. browser `localStorage` (workflow, chats, folders, providers, gallery cache);
  2. SQLite `lib/guest/*` (generations, uploads, folders, settings, spaces,
     asset hash index) — server-only, `node:sqlite`, WAL;
  3. flat files in `DATA_DIR` for server state that must survive Next.js dev
     module reloads and restarts: `.job-store.json`, `.codex-login-store.json`.
- **Two event buses, deliberately separate**: `jobEvents` (Node EventEmitter,
  server-only, bridges generate callback → SSE stream) and `workflowSyncBus`
  (window `Event`, client-only, bridges store actions → `useSpaceSync`). Both
  are standalone/no-import to avoid circular deps.
- **Placeholder/single-user auth**: no real session; `GUEST_USER_ID` +
  `getToken() === "guest"` keep call sites shaped for future multi-user.
- **Facades over legacy names**: `storage.ts` re-exports `mirrorToR2`/`ensureR2`
  as aliases for local-disk equivalents so R2-era call sites don't churn.

## Flow

**Node status**: `idle → pending → running → done | error`
(`NodeData.status`, plus `errorMsg`, `taskId`, transient
`pendingGenerate`/`pipelineQueued` flags).

**Pipeline** (`usePipelineRunner`):
1. `run()` computes `buildPipelineWaves()` — generation nodes only, edges
   between them define dependencies; same-wave nodes are independent → parallel.
2. Future-wave nodes get `pipelineQueued: true` (waiting indicator); wave 0
   nodes get `pendingGenerate: true`.
3. A wave is "done" only after it has been *observed* active (`pending`/`running`)
   and every member has `!pendingGenerate && status ∉ {pending,running}` —
   the `waveEverActive` guard prevents a race where flags clear before
   `generate()` sets status.
4. Advance wave or clear all `pipelineQueued` and end (also on early error).

**Job lifecycle** (server):
1. `/api/generate` (or `/api/generate-video`) resolves provider from
   `modelConfig`+`providers`, mints a `taskId` (`azure-`/`codex-` prefixes are
   local-only), writes `jobStore.set(taskId, {status:"pending"})`, inserts a
   `generations` row, kicks off `pollKieJob()` (kie.ai has no reachable
   webhook URL in desktop mode; hosted callback still exists).
2. Frontend waits either via `GET /api/job-status` polling or
   `EventSource('/api/job-stream')`. The SSE route: settled job → immediate
   event; lost record → recover from `generations` table; pending →
   `resumeKieJob()` (re-arm poller after restart, skipped for non-kie ids) then
   `jobEvents.once('job:<taskId>')`, 25 s heartbeat, 12 min hard cap.
3. `kieJobPoller` loop (3 s interval, 12 min deadline) → on terminal state:
   `settleSuccess` mirrors output URLs into local storage
   (`mirrorToR2` → `guest/localStorage`), then `settle()` writes `jobStore`,
   emits `job:<taskId>`, and updates the `generations` row.
4. Client node resolves `done`/`error` → sets `status`, `imageUrl`/`videoUrl`,
   optional `browserNotify`.

**Chat streaming** (`chatStreamingStore`): `startStream` POSTs
`/api/assistant` with `stream:true`, parses SSE (`content_block_delta` or
OpenAI `choices[0].delta.content`), `flushSync`-updates `streams[sessionId]`,
then `upsertSession` into `chatSessionStore` and fires a toast if the user
navigated away.

## Integration

- **Consumers (components)**: `WorkflowCanvas` (`store`, `executor.topoSort/
  resolveInputs`, `exportWorkflow`/`importWorkflow` lazy-loaded), all
  `components/nodes/*` (`store`, `modelConfig`, `executor.resolveInputs`,
  animation/popup hooks), `GenerateNode`/`VideoGeneratorNode` (poll
  `/api/job-status`, subscribe `/api/job-stream`), `WorkflowDashboard`
  (`templates.makeUGCTemplate`, `useSpaceSync.timeAgo`), `SettingsModal`
  (`modelConfig`, `providers`, key stores), `AppSidebar`/`QuickAssist`
  (`chatSessionStore`, `folderStore`), `Toaster` (`store.Toast`),
  `SelectionToolbar`/`GroupNode` (`arrangeNodes`, `usePipelineRunner`).
- **Consumers (pages)**: `app/workflow/page.tsx` + `[id]/page.tsx`
  (`useSpaceSync`), `app/gallery/page.tsx` (`store`, `folderStore`,
  `galleryUtils`, `browserNotify`, `/api/job-status`), `app/chat/page.tsx`
  (`chatSessionStore`).
- **API routes**: `app/api/generate`, `generate-video` (`jobStore`,
  `kieJobPoller`, `guestDb`, `storage`, `modelConfig`, `kieUpload`);
  `job-stream`/`job-status` (`jobStore`, `jobEvents`, `resumeKieJob`,
  `guestDb.recoverJob`); `workflows` (`guest/spaces`); `folders*`,
  `folder-items`, `gallery`, `upload*`, `upload-asset`, `fetch-url`
  (`guestDb`, `guestMode`, `storage`); `settings/{kie,azure}-key`
  (`guestDb` settings), `settings/codex-login` (`codexLoginStore`);
  `lookup-asset` (`assetCache`); `app/generated/[...path]` serves bytes from
  `guest/paths.MEDIA_DIR`.
- **External services**: kie.ai (`api.kie.ai` job API +
  `kieai.redpandaai.co` temp file upload), Azure OpenAI (image gen, user key),
  Codex CLI (spawned login flow), Anthropic/Gemini/OpenAI chat models,
  local SQLite + local media disk (R2 URLs only remain in templates/legacy data).

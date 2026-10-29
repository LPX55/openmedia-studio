# lib/

Shared, framework-light core for OpenMedia Studio: client Zustand stores, graph
execution/pipeline logic, server-side job submission/persistence/polling, media
storage facades, model/provider config, and the workflow template pack. No
`"use client"` directives here except the React hooks — imported by both
`components/` (client) and `app/api/` (server).

## Responsibility

- **Workflow state (`store.ts`)** — the central Zustand store: React Flow
  `nodes`/`edges`, multiple named *spaces* (canvases), undo/redo, toasts, UI
  flags, per-type `nodeDefaults` and `lastNodeSize`. Also the client-side
  provider slice — `providerStatus`, `modelProviders` (modelPrefs),
  `bindingsByModel`, `presets`, `providersHydrated`, `setProviderBootstrap()` —
  plus the persisted visibility toggles (`disabledProviders`/`disabledModels`)
  and `customSystemPrompt`. `NodeData` (prompt, model params,
  `imageUrl`/`r2Url`/`videoUrl`, `status`, `taskId`, …) is the payload contract
  for every node component and API route.
- **Job submission (server, `jobManager.ts`)** — the single funnel for all
  in-process generation: `submitJob()` (pre-mint taskId → pending jobStore +
  `generations` rows → managed background `provider.submit()`),
  `settleJob()` (mirror media → jobStore → generations row → SSE emit →
  release), `startPolling()` (provider-generic 3 s/12 min loop),
  `resumeJob()` (crash recovery), `isActive()`/`registerSubmit()`.
- **Job persistence (server)** — `jobStore.ts` (file-backed `taskId →
  JobResult`, capped 50-entry `trail`, `ProviderMeta`), `jobEvents.ts`
  (in-process `EventEmitter` for SSE), `kieJobPoller.ts` (standalone legacy kie
  loop, kept as reference; nothing imports it — `jobManager` owns the live
  poll loop). `pendingJobs.ts` was **removed**; live-submit tracking now lives
  in `jobManager`'s `activeSubmits`/`activePollers` registries.
- **Job trail (server, `jobLog.ts`)** — `appendJobLog()` writes a redacted,
  length-capped `{ t, phase, detail }` entry to the jobStore trail (and echoes
  it to the console). Enforces: no keys (`sk-…`, `Bearer`, `?key=`), no `data:`
  payloads, no full bodies, URLs reduced to hosts. Read back through
  `GET /api/jobs/[taskId]/log` with the `generations.job_log` fallback.
- **Graph execution (client)** — `executor.ts` (`buildPipelineWaves` — wave
  topological order over generation nodes; `resolveInputs` — prompt/image/
  frame/video/audio resolution honouring source handles), `usePipelineRunner.ts`
  (wave-by-wave orchestration), `arrangeNodes.ts` (grid layout).
- **Persistence sync** — `useSpaceSync.ts` (debounced `PUT /api/workflows`),
  `workflowSyncBus.ts` (window event to force an early flush).
- **Chat** — `chatSessionStore.ts` (persisted sessions), `chatStreamingStore.ts`
  (SSE stream state; currently no component consumer; sends the user's
  `customSystemPrompt` as `systemPromptOverride`), `systemPrompt.ts`.
- **Folders / gallery** — `folderStore.ts` (optimistic folder CRUD via REST),
  `galleryUtils.ts` (thumbnails, `getToken` stub, gallery cache).
- **Media & assets** — `storage.ts` (thin facade over `guest/localStorage.ts`;
  `mirrorToR2`/`ensureR2` are legacy aliases for local-disk storage),
  `assetCache.ts`/`assetHash.ts` (SHA-256 dedupe index), `mediaMetadata.ts`
  (EXIF/metadata strip via sharp/ffmpeg), `kieUpload.ts` (re-host local media —
  `/generated/…`, `data:`, loopback URLs — to kie.ai's temp store),
  `makeZip.ts` + `exportWorkflow.ts`/`importWorkflow.ts` (zip export/import).
- **Model/provider config** — `modelConfig.ts` (catalog: `IMAGE_MODELS` /
  `VIDEO_MODELS`, per-model `apiInput` mapping, handles, ratios, Azure size
  maps + `validateAzureCustomSize`), `models.ts` (chat LLM picker),
  `providers.ts` (client-only provider selection/readiness facade over the
  store bootstrap; `PROVIDERS` = kie/azure/codex/openrouter/pollinations),
  `getKieToken.ts`/`getAzureKey.ts` (thin wrappers over `guest/db` settings).
- **Templates** — `workflowTemplates.ts` (seven-template registry + graph
  builders: product-ad, character-set, campaign-kit, scene-transition,
  clip-remix, motion-transfer, legacy ugc-repurposer), `templates.ts` (the
  classic UGC starter graph, exposed as one registry entry).
- **UI helpers** — `nodeTypes.tsx` (node catalog/metadata/sizes), `edgeStyles.ts`,
  `textFormat.ts` (JSON/YAML detection), `useAnimatedPopup.ts`,
  `useGeneratingBorderAnimation.ts`, `useGeneratingPhase.ts`,
  `browserNotify.ts`, `readOnlyContext.ts`, `utils.ts` (`cn`).
- **Misc plumbing** — `guestMode.ts` (`GUEST_USER_ID = "guest"`, the single
  implicit user all server routes key by), `codexLoginStore.ts` (file-backed
  Codex CLI login state), `pendingFiles.ts`.

## Design

- **Zustand + persist (client)**: `store.ts`, `chatSessionStore.ts`,
  `folderStore.ts` use `persist`/`createJSONStorage(localStorage)` with keys
  `heliosgen-guest`, `heliosgen-chats-guest`, `aiui-folders-v2`.
  `store.ts` `partialize` strips base64 `inputImage` (only durable `r2Url`
  survives reload) and persists the visibility toggles + `customSystemPrompt`;
  the provider bootstrap slice is deliberately NOT persisted
  (server-authoritative). `onRehydrateStorage` migrates v0 flat nodes→spaces
  and backfills missing defaults/toggles.
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
  1. browser `localStorage` (workflow, chats, folders, visibility toggles,
     custom prompt, gallery cache);
  2. SQLite `lib/guest/*` (generations, uploads, folders, settings, spaces,
     provider configs/bindings/presets, asset hash index) — server-only,
     `node:sqlite`, WAL;
  3. flat files in `DATA_DIR` for server state that must survive Next.js dev
     module reloads and restarts: `.job-store.json`, `.codex-login-store.json`.
- **Pre-mint job contract**: `submitJob()` writes the taskId, pending
  `jobStore` record and `generations` row (with `provider_id`) BEFORE the
  upstream call, so a crash mid-submit cannot orphan a job; the trail is also
  started pre-submit. `provider_meta` (upstream id, family, status URL,
  upstream model) is persisted on async acceptance.
- **Single settle funnel + registries**: every terminal path (sync submit,
  poll result, timeout, thrown submit, resume) goes through `settleJob()`,
  which is idempotent for already-terminal jobs and is the only release point
  for `activeSubmits` (tagged with a per-process `bootId`) and
  `activePollers`. `isActive()` = live poll OR live submit of this boot.
- **Provider-generic polling**: `startPolling()` resolves the adapter from
  `providers/bootstrap` and calls `provider.poll()`; the Kie-Veo family is the
  one explicitly unpolled family (no loop armed; async submit settles an
  explicit "polling not available" error).
- **Catalog vs bindings vs client prefs**: `modelConfig.ts` is the model
  catalog (pure data, safe on both sides); server adapters/bindings live in
  `lib/providers/*`; `providers.ts` is the client facade over the store
  bootstrap. Provider ids are open strings — `providerMeta()` degrades unknown
  ids to the raw id instead of crashing `find()!` call sites.
- **Templates are pure data**: each entry is `{ id, name, tagline, models,
  accent, preview, make() }` returning `{ nodes, edges, nodeCounters }` — the
  same shape `createSpace(name, template)` consumes. Graphs use real model
  handles and start `idle` (except the `legacy` UGC board), and are validated
  offline by `scripts/check-workflows.mjs`.
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
1. `/api/generate` (or `/api/generate-video`) resolves the provider via
   `registry.resolveForModel` (from `guestDb.getModelBindingRows`), checks
   readiness, stages media, then calls `jobManager.submitJob()` — which mints
   `taskId` (`<providerId>-<ts>-<uuid8>`), appends the `submit` trail, writes
   pending `jobStore` + `generations` rows, `registerSubmit()`s, and returns
   `{ taskId }` immediately.
2. Background `provider.submit()`: sync outcome → `settleJob(done)`; async →
   persist `provider_meta` on both records, then `startPolling()` (Veo family
   settles an explicit error instead). A throw settles the row `error`.
3. `settleJob()` mirrors remote URLs (`mirrorToR2`) and local buffers
   (`uploadBuffer`) into `MEDIA_DIR`, writes `jobStore`, updates the
   `generations` row (status/urls/error + `job_log`), emits
   `job:<taskId>` on `jobEvents`, and releases both registries.
4. Poll loop (3 s interval, 12 min deadline) calls `provider.poll()`; transient
   errors retry, terminal states settle, deadline settles "Generation timed out".
5. Frontend waits via `GET /api/job-status` polling or
   `EventSource('/api/job-stream')`. Pending + not live → `resumeJob()`:
   terminal `generations` row is synced back into `jobStore`; kie or any
   compat backend with `poll` restarts the loop; orphaned azure/codex jobs
   settle `error` ("Server restarted…"); unknown providers stay pending.
6. Client node resolves `done`/`error` → sets `status`, `imageUrl`/`videoUrl`,
   optional `browserNotify`.

**Job trail** (`jobLog` + `jobStore`): phases `submit | poll | settle |
resume | error | retry`; poll ticks keep the first tick, every state change and
every 10th tick; the trail is capped at the last 50 entries, preserved across
status writes, mirrored into `generations.job_log` at settle, and served by
`GET /api/jobs/[taskId]/log` (unknown ids → 200 empty shape, never 500).
`JobLogViewer` renders it inside `GenerateNode`/`VideoGeneratorNode` and the
gallery lightbox.

**Chat streaming** (`chatStreamingStore`): `startStream` POSTs
`/api/assistant` with `stream:true` (plus `systemPromptOverride` when the user
set a custom prompt), parses SSE (`content_block_delta` or OpenAI
`choices[0].delta.content`), `flushSync`-updates `streams[sessionId]`, then
`upsertSession` into `chatSessionStore` and fires a toast if the user navigated
away.

**Templates**: `WORKFLOW_TEMPLATES` → `TemplateGallery` cards /
`WorkflowDashboard` → `makeWorkflowTemplate(id)` → `createSpace(name, graph)`;
`check-workflows.mjs` imports the registry + catalog and validates every graph
offline before it ships.

## Integration

- **Consumers (components)**: `WorkflowCanvas` (`store`, `executor`
  `buildPipelineWaves`/`resolveInputs`, `exportWorkflow`/`importWorkflow`
  lazy-loaded), all `components/nodes/*` (`store`, `modelConfig`,
  `executor.resolveInputs`, animation/popup hooks), `GenerateNode`/
  `VideoGeneratorNode` (poll `/api/job-status`, subscribe `/api/job-stream`,
  render `JobLogViewer`), `WorkflowDashboard`/`TemplateGallery`
  (`workflowTemplates`), `SettingsModal` (`modelConfig`, `providers`),
  `AppSidebar` (provider bootstrap GET), `QuickAssist`/`AppSidebar`
  (`chatSessionStore`, `folderStore`), `Toaster` (`store.Toast`),
  `SelectionToolbar`/`GroupNode` (`arrangeNodes`, `usePipelineRunner`).
- **Consumers (pages)**: `app/workflow/page.tsx` + `[id]/page.tsx`
  (`useSpaceSync`), `app/gallery/page.tsx` (`store`, `folderStore`,
  `galleryUtils`, `browserNotify`, `/api/job-status`, `JobLogViewer`),
  `app/chat/page.tsx` (`chatSessionStore`).
- **API routes**: `app/api/generate`, `generate-video` (thin controllers →
  `providers/bootstrap` + `mediaStager` + `jobManager.submitJob`); `job-status`
  /`job-stream` (`jobStore`, `jobEvents`, `jobManager.resumeJob`,
  `guestDb.recoverJob`); `jobs/[taskId]/log` (`jobStore` trail +
  `guestDb.recoverJob().job_log`); `workflows` (`guest/spaces`);
  `folders*`, `folder-items`, `gallery`, `upload*`, `upload-asset`,
  `fetch-url` (`guestDb`, `guestMode`, `storage`); `settings/providers`
  (`guestDb` provider configs/bindings/presets); `settings/{kie,azure}-key`
  (legacy wrappers over `provider_configs`), `settings/codex-login`
  (`codexLoginStore`); `lookup-asset` (`assetCache`);
  `app/generated/[...path]` serves bytes from `guest/paths.MEDIA_DIR`.
- **Scripts**: `scripts/check-workflows.mjs` imports `modelConfig.ts` +
  `workflowTemplates.ts` directly; `scripts/providers/smoke-compat.mjs`
  exercises `jobStore`/`jobLog`, provider registry/adapters, media staging,
  presets and the settings/generate-video routes with a stubbed `fetch`.
- **External services**: kie.ai (`api.kie.ai` job API +
  `kieai.redpandaai.co` temp file upload), Azure OpenAI (image gen, user key),
  Codex CLI (spawned login flow), OpenRouter + Pollinations (openai-compat
  family), Anthropic/Gemini/OpenAI chat models, local SQLite + local media disk
  (R2 URLs only remain in legacy data/aliases).

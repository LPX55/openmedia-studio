# Repository Atlas: OpenMedia Studio

## Project Responsibility
Free & open-source visual AI workflow builder for image and video generation. Infinite node-based canvas where users chain prompts, models, reference images, and automations. 100% local desktop app (Tauri 2 + Next.js sidecar); generations run through the user's own kie.ai / Azure / Replicate / Codex CLI keys. No accounts, no cloud state — SQLite + local disk under per-user app-data dirs.

## System Entry Points
- `app/layout.tsx`: Root App Router shell (SidebarProvider, AppSidebar, GlobalModals, banners, fonts, `globals.css`).
- `app/page.tsx`: `/` → `redirect("/gallery?tab=images")`.
- `app/workflow/[id]/page.tsx`: Canvas editor (dynamic ssr:false `WorkflowCanvas` + `useSpaceSync`).
- `app/workflow/page.tsx`: Space dashboard (`WorkflowDashboard`).
- `app/gallery/page.tsx`: Generation history / media library UI.
- `app/chat/page.tsx`: Assistant chat (SSE to `/api/assistant`).
- `app/api/generate/route.ts`, `app/api/generate-video/route.ts`, `app/api/generate-image/route.ts`: Generation dispatch → `lib/jobStore` + `lib/kieJobPoller` → `/api/job-status` or `/api/job-stream` (SSE).
- `lib/store.ts`: Central Zustand workflow store (`NodeData` contract, spaces, undo/redo).
- `lib/modelConfig.ts` + `lib/providers.ts`: Model catalog and per-model backend routing.
- `lib/guest/*`: Server-only SQLite + local-disk media persistence.
- `src-tauri/tauri.conf.json` + `src-tauri/src/lib.rs`: Desktop shell — spawns `helios-node` sidecar (staged Next standalone server), splash → `http://127.0.0.1:<port>/`.
- `package.json`: `dev`, `build`, `desktop:dev`, `desktop:check-version`, `desktop:build`.
- `next.config.ts`, `tsconfig.json` (`@/*` alias), `components.json`, `eslint.config.mjs`.

## Data & Control Flow (end to end)
1. User drops/connects nodes on `WorkflowCanvas` (`components/WorkflowCanvas.tsx`, node renderers in `components/nodes/`, `CuttableEdge` in `components/edges/`).
2. `usePipelineRunner` (`lib/usePipelineRunner.ts`) computes waves via `lib/executor.ts` (`buildPipelineWaves`, `resolveInputs` over edges), runs generation nodes.
3. Node action POSTs `/api/generate` or `/api/generate-video` → provider branch (Azure / codex CLI / kie.ai) → `taskId` returned immediately → `jobStore.set(pending)` + `kieJobPoller` loop.
4. Client polls `/api/job-status` or subscribes `/api/job-stream` (SSE, `lib/jobEvents.ts`) → poller settles (`mirrorToR2` local-disk mirror) → `jobStore` + `guest.db` update + SSE emit → node `data.status = done`, media URL under `/generated/...` served by `app/generated/[...path]/route.ts`.
5. Workflow state syncs back via `useSpaceSync` → `PUT /api/workflows` → `lib/guest/spaces.ts`; gallery/folders via `lib/folderStore.ts` + `/api/folders*`, `/api/gallery`.

## Directory Map (Aggregated)
| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `app/` | Root App Router shell: layout chrome, `/` redirect, global canvas stylesheet. | [View Map](app/codemap.md) |
| `app/api/` | 28 route handlers: generation dispatch, asset ingest/tools, folders/gallery, jobs (poll/SSE/log), settings keys + providers catalog, misc (credit, update-check). | [View Map](app/api/codemap.md) |
| `app/chat/` | Assistant chat page (landing vs window, SSE streaming). | [View Map](app/chat/codemap.md) |
| `app/gallery/` | Media history library (tabs, @mention engine, pending-gen resume). | [View Map](app/gallery/codemap.md) |
| `app/generated/` | Static-media fallback route (MEDIA_DIR streaming, traversal guards). | [View Map](app/generated/codemap.md) |
| `app/workflow/` | Space dashboard (CRUD, import/zip, templates). | [View Map](app/workflow/codemap.md) |
| `app/workflow/[id]/` | Canvas editor page (space guard, dynamic WorkflowCanvas). | [View Map](app/workflow/[id]/codemap.md) |
| `components/` | Top-level React layer: canvas host, shell chrome, modals, dashboard (17 files). | [View Map](components/codemap.md) |
| `components/nodes/` | All 11 ReactFlow node renderers + shared chrome helpers. | [View Map](components/nodes/codemap.md) |
| `components/edges/` | `CuttableEdge` (bezier, scissor-cut, gradient/error states). | [View Map](components/edges/codemap.md) |
| `components/ui/` | shadcn-style primitives on `@base-ui/react` + decorative components. | [View Map](components/ui/codemap.md) |
| `lib/` | Shared core: Zustand stores, execution pipeline, server job lifecycle, media facades, model config. | [View Map](lib/codemap.md) |
| `lib/guest/` | Server-only persistence: SQLite (`guest.db`), local-disk media store, spaces, settings. | [View Map](lib/guest/codemap.md) |
| `lib/providers/` | Pluggable provider subsystem: adapter contract, registry, bootstrap, presets, media staging. | [View Map](lib/providers/codemap.md) |
| `lib/providers/adapters/` | Backend adapters: kie, azure, codex, openai-compat. | [View Map](lib/providers/adapters/codemap.md) |
| `hooks/` | Shared client hooks (`useIsMobile`). | [View Map](hooks/codemap.md) |
| `scripts/` | Node-ESM automation overview (desktop packaging). | [View Map](scripts/codemap.md) |
| `scripts/desktop/` | Desktop toolchain: dev runner, server stager, version guard, sidecar watchdog. | [View Map](scripts/desktop/codemap.md) |
| `scripts/providers/` | OpenAI-compat smoke fixture (stubbed fetch, offline checks). | [View Map](scripts/providers/codemap.md) |
| `src-tauri/` | Tauri v2 shell config/build: sidecar resources, capabilities, loader shim, splash. | [View Map](src-tauri/codemap.md) |
| `src-tauri/src/` | Rust entry (`main.rs` shim, `lib.rs`: port pick, env repair, spawn/wait/kill sidecar). | [View Map](src-tauri/src/codemap.md) |

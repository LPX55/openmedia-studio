# components/

## Responsibility

Top-level React layer for the OpenMedia Studio app: the workflow canvas (ReactFlow host), shell chrome (sidebar, toolbars, banners, toasts), app-level modals (settings, media picker), the shared job run-log viewer, and the dashboard/hero/template screens for space selection. Owns all `*.tsx` files in this directory (node/edge/UI primitives live in the subfolders — see their own codemaps):

- **Canvas core**: `WorkflowCanvas` (ReactFlow host + all canvas interaction), `SelectionToolbar`, `CanvasToolbar`, `AddNodeMenu`, `NodePickerMenu`
- **Shell / chrome**: `AppSidebar`, `GlobalModals`, `Toaster`, `KieBanner`, `UpdateBanner`, `DesktopLinkHandler`, `DragDropGuard`
- **Modals**: `SettingsModal`, `MediaPickerModal`
- **Assistant**: `QuickAssist`
- **Dashboard**: `WorkflowDashboard`, `WorkflowHero`, `TemplateGallery`
- **Run log**: `JobLogViewer` — read-only phase timeline of a job's event trail, shared by canvas nodes and the gallery's pending tiles

## Design

- **React patterns**
  - Client components (`"use client"`) throughout; the canvas subtree relies on hooks/context rather than prop drilling.
  - `WorkflowCanvas` is the composition root for canvas UI: it renders `<ReactFlow>` and nests `AddNodeMenu`/`NodePickerMenu`/`SelectionToolbar`/`CanvasToolbar` *inside* the provider so they can call `useReactFlow()`.
  - `AppSidebar` uses recursive `React.memo` (`FolderRow`) for the folder tree (drag-reparent/reorder, inline rename, color menu, generating/unseen dots) plus a deterministic `PixelAvatar`, a chat-session list, and a credit balance polled from `/api/credit` (60 s + `credits-refresh` window event). Mount effects hydrate provider bootstrap and run the one-time populate-only legacy provider-config migration (`aiui-providers-uploaded-v1` marker).
  - `JobLogViewer` is a pure reader: `GET /api/jobs/[taskId]/log`, auto-refresh on the same 3 s cadence the app already uses for `/api/job-status` (only while `status === "pending"`), payload tagged with its `taskId` so switching jobs never shows a stale trail. It never mutates a job.
  - Event-driven side effects are isolated: `DesktopLinkHandler` (external links → `/api/open-external`), `DragDropGuard` (kills navigate-on-drop), `Toaster` (transient notices).
- **@xyflow usage**: `WorkflowCanvas` declares the `nodeTypes` map (8 keys: `promptNode`, `imageInputNode`, `videoInputNode`, `generateNode`, `videoGeneratorNode`, `assistantNode`, `groupNode`, `commentNode`) and `edgeTypes` (`default: CuttableEdge`). It drives `onNodesChange`/`onEdgesChange` through the store, and implements debounced viewport persistence (300 ms → `saveViewport`, restored per space by `ViewportSyncer`), 8 px edge/center snap guides, ancestor-BFS dimming, group-preview outlines, delayed node/edge removal for exit animations, clipboard copy/paste (sentinel marker distinguishes node-copy from external text), and zip export. `NodePickerMenu` renders on connect-end: dashed bezier preview, target-handle routing, aspect-ratio inheritance from the source node, and model defaults filtered by `isModelEnabled`.
- **shadcn/ui**: only via `components/ui/*` primitives (`Button`, `Input`, `Tooltip`, `Sheet`, `Sidebar`, `DropdownMenu`, `Avatar`, `Kbd`, `Separator`, `Skeleton`) — `cva` wrappers over `@base-ui/react` (not Radix). Most non-UI components style with inline `style={{}}`; `AppSidebar`/`NodePickerMenu`/`WorkflowHero` use Tailwind classes, while `TemplateGallery`/`WorkflowDashboard` inject scoped CSS through `<style>`.
- **zustand**: 13 of 19 components read `useWorkflowStore` from `lib/store.ts` (nodes/edges/spaces/toasts/settings flags/undo-redo/provider status). `AppSidebar` additionally composes `useChatSessionStore` (`lib/chatSessionStore.ts`) and `useFolderStore` (`lib/folderStore.ts`).
- **Banners / toasts**: `KieBanner` shows only after hydration and only when **no** generation provider is ready (`providerStatus` has no `ready` entry). `UpdateBanner` fetches `/api/update-check` once on mount and stores the dismissed version in `localStorage["helios-update-dismissed"]` (functional key — never rename). `Toaster` has two shapes: rich notification (`title` + `preview`, manual dismiss) and simple toast (auto-dismiss 4 s, or 8 s when it carries an `href`).
- **Dashboard chrome**: `WorkflowHero` is a decorative three-card diagram (prompt → hero node → media output) with CSS keyframe fade-ups and desktop-only bezier connectors; flanking cards hide below `lg`. `TemplateGallery` renders `WORKFLOW_TEMPLATES` as accent-themed cards (CSS vars per template, 4-cell preview mosaic via `next/image`, tag/model chips, optional CLASSIC badge, Enter/Space activation) and is the dashboard's primary entry point.

## Flow

- **State**: canonical workflow state (nodes, edges, spaces, selection, undo/redo stacks, `nodeCounters`, `lastNodeSize`, toast queue, `settingsOpen`, provider readiness/prefs, hidden-model toggles) lives in `lib/store.ts`; components subscribe with selectors and mutate through store actions (`addNode`, `updateNodeData`, `onNodesChange`, `insertEdge`, …). Local `useState` is only for transient UI (menus open, input drafts, panel nav).
- **Props**: leaf/overlay components (`SelectionToolbar`, `AddNodeMenu`, `NodePickerMenu`, `JobLogViewer`, `Toaster`, banners) take narrow props or read the store directly; `WorkflowCanvas` keeps only transient view state locally (active tool, snap guides, dying-node/edge sets) and reads workflow data from the store + ReactFlow.
- **Events**:
  1. User action (drag from `AddNodeMenu` / drop on canvas, toolbar click, keyboard shortcut) → store action → `onNodesChange` reconciles ReactFlow's controlled state; connect-end opens `NodePickerMenu`, which creates the node + edge in one store transaction.
  2. Settings: `GlobalModals` mounts `SettingsModal` gated on `settingsOpen`; the modal re-hydrates `refreshProviderBootstrap()` on mount, then mirrors server state into local editor copies and PUTs changes to `/api/settings/providers`. Store readiness (`providerStatus`, `providersHydrated`) gates `KieBanner`, node generate buttons, and picker options.
  3. Assistant: `QuickAssist` resolves its model as in-session pick → Settings `providerStatus.chat.chatModel` → persisted `preferredModel` → catalog default (`pickedRef` protects explicit picks), streams `/api/assistant` SSE, and persists turns via `useChatSessionStore`.
  4. Dashboard: `WorkflowDashboard` renders `WorkflowHero` + `TemplateGallery` (`WORKFLOW_TEMPLATES`, 7 templates) above the space grid; creating/importing/template selection calls `createSpace` then routes to `/workflow/[id]`; imports go through `lib/importWorkflow` zip reader with a toast summary.
  5. Job log: nodes pass their live `taskId` (falling back to `lastTaskId` after settle) into `JobLogViewer`, which fetches the trail and self-schedules refreshes until the job leaves `pending`.

## Integration

- **Stores**
  - `lib/store.ts` → `useWorkflowStore` (canvas + most shell components)
  - `lib/chatSessionStore.ts` → `useChatSessionStore` (`AppSidebar`, `QuickAssist`)
  - `lib/folderStore.ts` → `useFolderStore` (`AppSidebar`)
- **lib/** consumed (across this folder)
  - `lib/store`, `lib/providers` (`isModelEnabled`, `refreshProviderBootstrap`, provider metadata), `lib/providers/bindings` (chat preset base URLs), `lib/nodeTypes` (`NODES`, `NODE_SIZE`, `NODE_META`, `getLastNodeSettings`, `getDefaultNodeSize`), `lib/modelConfig`, `lib/edgeStyles`, `lib/galleryUtils`, `lib/models`, `lib/workflowTemplates`, `lib/useSpaceSync` (`timeAgo`), `lib/workflowSyncBus`, `lib/textFormat`, `lib/assetHash`, `lib/arrangeNodes`, `lib/systemPrompt`, `lib/utils` (`cn`)
  - `SettingsModal` also exports the Azure loaders (`loadAzureBaseUrl`, `loadAzureTextDeployment`, `loadAzureTextModelName`, `loadAzureEndpoints`, `getAzureDeployment`) that `QuickAssist` and `app/chat/page.tsx` import from the component.
- **Sibling components / subfolders**: `WorkflowCanvas` maps `components/nodes/*` into `nodeTypes` and `components/edges/CuttableEdge` into `edgeTypes`; `GlobalModals` composes `DesktopLinkHandler` + `SettingsModal` + `Toaster`; `AddNodeMenu` and the gallery page embed `MediaPickerModal`; `JobLogViewer` is consumed by `components/nodes/GenerateNode`/`VideoGeneratorNode` and gallery pending tiles; `AppSidebar` renders `components/ui/sidebar`.
- **External**: `@xyflow/react` (ReactFlow, `useReactFlow`, `useViewport`, `useUpdateNodeInternals`), Next.js `Link`/`next/navigation`/`next/image`, `motion/react`, `lucide-react`, `@base-ui/react` (via `components/ui/*`).

# components/

## Responsibility

Top-level React layer for the OpenMedia Studio app: the workflow canvas (ReactFlow host), shell chrome (sidebar, toolbars, banners, toasts), app-level modals (settings, media picker), and the dashboard/hero screens for space selection. Owns all `*.tsx` files in this directory (node/edge/UI primitives live in the subfolders — see their own codemaps):

- **Canvas core**: `WorkflowCanvas` (ReactFlow host + all canvas interaction), `SelectionToolbar`, `CanvasToolbar`, `AddNodeMenu`, `NodePickerMenu`
- **Shell / chrome**: `AppSidebar`, `GlobalModals`, `Toaster`, `KieBanner`, `UpdateBanner`, `DesktopLinkHandler`, `DragDropGuard`
- **Modals**: `SettingsModal`, `MediaPickerModal`
- **Assistant**: `QuickAssist`
- **Dashboard**: `WorkflowDashboard`, `WorkflowHero`

## Design

- **React patterns**
  - Client components (`"use client"`) throughout; canvas subtree relies on hooks/context rather than prop drilling.
  - `WorkflowCanvas` is the composition root for canvas UI: it renders `<ReactFlow>` and nests `AddNodeMenu`/`NodePickerMenu`/`SelectionToolbar`/`CanvasToolbar` *inside* the provider so they can call `useReactFlow()`.
  - `AppSidebar` uses recursive `React.memo` (`FolderRow`) for the folder tree; deterministic `PixelAvatar` for user avatars.
  - Event-driven side effects are isolated: `DesktopLinkHandler` (deep links), `DragDropGuard` (drag/drop safety), `Toaster` (transient notices).
- **@xyflow usage**: `WorkflowCanvas` declares the `nodeTypes` / `edgeTypes` maps (imported node components + `CuttableEdge`), drives `onNodesChange`/`onEdgesChange` through the store, and implements viewport persistence, snap guides, ancestor-BFS dimming, drag-drop node creation, and clipboard copy/paste (with a sentinel marker to avoid re-pasting pasted content). Toolbar/menu components use `useReactFlow`, `useViewport`, `getNodes`.
- **shadcn/ui**: only via the `components/ui/*` primitives (`Button`, `Input`, `Tooltip`, `Sheet`, `Sidebar`, `DropdownMenu`, `Avatar`, `Kbd`, `Separator`, `Skeleton`) — these are `cva`-based wrappers over `@base-ui/react` (not Radix). Most non-UI components style with inline `style={{}}` objects instead of Tailwind classes.
- **zustand**: 11 of 17 components read `useWorkflowStore` from `lib/store.ts` (nodes/edges/spaces/toasts/settings flags/undo-redo). `AppSidebar` additionally composes `useChatSessionStore` (`lib/chatSessionStore.ts`) and `useFolderStore` (`lib/folderStore.ts`).

## Flow

- **State**: canonical workflow state (nodes, edges, spaces, selection, undo/redo stacks, `nodeCounters`, `lastNodeSize`, toast queue, `settingsOpen`, API-key-set flags) lives in `lib/store.ts`; components subscribe with selectors and mutate through store actions (`addNode`, `updateNodeData`, `onNodesChange`, `insertEdge`, …) — local `useState` is only for transient UI (menus open, input drafts).
- **Props**: leaf/overlay components (`SelectionToolbar`, `AddNodeMenu`, `NodePickerMenu`, `Toaster`, banners) take narrow props or read the store directly; `WorkflowCanvas` is stateless at the root (reads everything from the store + ReactFlow).
- **Events**:
  1. User action (drag from `AddNodeMenu` / drop on canvas, toolbar click, keyboard shortcut) → store action → `onNodesChange` reconciles ReactFlow's controlled state.
  2. Modals: `GlobalModals` mounts `SettingsModal`/`MediaPickerModal` gated on store flags (`settingsOpen`, etc.); closing flips the flag.
  3. Cross-component config reads: `QuickAssist` imports `loadAzureBaseUrl` / `loadAzureTextDeployment` / `loadAzureTextModelName` **exported from `SettingsModal`** rather than from a lib module.
  4. `WorkflowDashboard` drives space CRUD (create/switch/delete/rename/duplicate) via store actions, imports zips through `lib/importWorkflow`, seeds templates via `lib/templates.makeUGCTemplate`, and renders `WorkflowHero` + `DotCanvasBackground`.

## Integration

- **Stores**
  - `lib/store.ts` → `useWorkflowStore` (all canvas + most shell components)
  - `lib/chatSessionStore.ts` → `useChatSessionStore` (`AppSidebar`)
  - `lib/folderStore.ts` → `useFolderStore` (`AppSidebar`)
- **lib/** consumed (import counts across this folder)
  - `lib/store`, `lib/nodeTypes` (`NODE_SIZE`, `getLastNodeSettings`, `getDefaultNodeSize`), `lib/modelConfig`, `lib/galleryUtils`, `lib/edgeStyles`, `lib/models`, `lib/chatSessionStore`, `lib/workflowSyncBus`, `lib/useSpaceSync`, `lib/textFormat`, `lib/templates`, `lib/systemPrompt`, `lib/providers`, `lib/folderStore`, `lib/executor`, `lib/assetHash`, `lib/arrangeNodes`, `lib/utils` (`cn`)
- **Sibling components / subfolders**: `WorkflowCanvas` is the only importer of `lib/nodeTypes`' node registry consumers — it maps `components/nodes/*` into `nodeTypes` and `components/edges/CuttableEdge` into `edgeTypes`; `GlobalModals` composes `SettingsModal` + `MediaPickerModal`; `AppSidebar` renders `components/ui/sidebar`.
- **External**: `@xyflow/react` (ReactFlow, `useReactFlow`, `useViewport`), Next.js `Link` / `next/navigation`, `@base-ui/react` (via `components/ui/*`), `lucide-react` icons.

# app/workflow/[id]/codemap.md

Covers `app/workflow/[id]/page.tsx`.

## Responsibility
Per-workflow editor at `/workflow/[id]` — mounts the React Flow canvas (`WorkflowCanvas`) for the given space id, activating the correct space in the global store and guarding against unknown ids.

## Design
- Client component; params arrive as `Promise<{ id: string }>` (App Router async params) and are unwrapped with React's `use()` hook.
- `WorkflowCanvas` is loaded via `next/dynamic` with `ssr: false` — the canvas (React Flow + heavy node graph) is client-only, avoiding SSR hydration mismatches and Node-side failures.
- Guard pattern: on mount/id change, read `useWorkflowStore.getState().spaces`; if no space matches `id`, `router.replace("/")`; otherwise `switchSpace(id)` to make it the active space (also handles direct URL entry deep-links).
- Layout: flex row container (`flex-1 flex overflow-hidden min-h-0`) holding `WorkflowCanvas` + floating `QuickAssist` panel; root layout's `SidebarProvider`/`SidebarInset` wraps the whole thing.
- `useSpaceSync()` called as in the dashboard page for space persistence while the editor is open.

## Flow
1. Navigate to `/workflow/<id>` → `WorkflowPage` mounts → `use(params)` yields `id`.
2. `useSpaceSync()` activates.
3. `useEffect([id, switchSpace, router])`: `useWorkflowStore.getState().spaces` lookup → missing → `router.replace("/")`; found → `switchSpace(id)` (store updates, canvas re-renders with the space's nodes/edges).
4. `WorkflowCanvas` (dynamic import resolved client-side) renders the editor; `QuickAssist` renders alongside.
5. On id change (in-app nav), effect re-runs and re-switches space.

## Integration
- Depends on: `@/lib/store` (`useWorkflowStore` — `spaces`, `switchSpace`), `@/lib/useSpaceSync`, `@/components/WorkflowCanvas` (dynamic, ssr:false), `@/components/QuickAssist`, `next/dynamic`, `next/navigation` (`useRouter`), React `use()`.
- Consumed by: routed from `app/workflow` dashboard; sidebar links may deep-link to specific ids.
- Store contract: the page assumes spaces are loaded into `useWorkflowStore` before mount (synced via `useSpaceSync` / prior navigation); direct cold loads rely on store hydration from persistence.

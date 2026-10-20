# app/workflow/codemap.md

Covers `app/workflow/page.tsx`.

## Responsibility
Workflow list/dashboard at `/workflow` — renders the space/workflow management dashboard and activates cross-space sync for the session.

## Design
- Minimal client page (`"use client"`); composition over logic.
- `useSpaceSync()` (from `@/lib/useSpaceSync`) is invoked as a hook in the page body — side-effecting sync (space membership / persistence) runs while the dashboard is mounted.
- `WorkflowDashboard` is the sole child; no local state, no props.

## Flow
1. Route `/workflow` matches → `WorkflowPage` mounts.
2. `useSpaceSync()` activates (subscribe/persist space state for the mounted lifetime).
3. Return `<WorkflowDashboard />` fills the `SidebarInset` flex area (root layout provides the shell).

## Integration
- Depends on: `@/components/WorkflowDashboard` (the actual dashboard UI), `@/lib/useSpaceSync` (space sync hook).
- Consumed by: routed from `app/layout.tsx` shell; users click a workflow row in `WorkflowDashboard` to navigate to `/workflow/[id]`.
- Sibling route: `app/workflow/[id]/page.tsx` (per-workflow canvas; also calls `useSpaceSync`).

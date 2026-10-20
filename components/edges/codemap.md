# components/edges/

## Responsibility

Custom ReactFlow edge renderers. Currently a single implementation, `CuttableEdge.tsx`: draws a bezier connection between nodes with a hover "scissors" badge that lets the user cut the edge, plus a gradient stroke and lifecycle visual states (dying, dimmed, error).

## Design

- **React patterns**: functional component typed against ReactFlow's `EdgeProps` (via `Edge<NodeData>`-compatible edge objects); all visual state derives from the edge's `data` payload — no local store, only ephemeral hover/press state. `memo`-friendly: re-renders are driven by edge `data` changes pushed through `lib/store.ts`.
- **@xyflow usage**: reuses ReactFlow's `<Handle>`/path primitives (renders its own SVG path rather than the default edge), exposes the standard `markerEnd`, and re-computes path geometry from `sourceX/sourceY/targetX/targetY` + `sourcePosition/targetPosition`. Registered in `WorkflowCanvas`'s `edgeTypes` map as the app-wide edge type.
- **Styling**: inline `style={{}}` SVG attributes (stroke gradient via `<linearGradient>`, opacity/dash overrides per state) — consistent with the non-`ui` component convention rather than Tailwind classes.
- **State model** (encoded in edge `data`): `dying` (cut animation in progress), `dimmed` (ancestor-BFS dimming from canvas selection), `error` (failed generation linkage) — each adjusts stroke opacity/color/dash.

## Flow

- **Props in**: ReactFlow passes geometry (`sourceX`, `targetX`, …), `data`, `selected`, and interaction callbacks.
- **Events**:
  1. Hover over edge → scissor badge appears at path midpoint.
  2. Click badge → requests edge removal (store action via `insertEdge`/edge-change path in `WorkflowCanvas`) and sets `dying` on the edge so the cut animates before removal.
  3. Canvas selection changes → `WorkflowCanvas` computes ancestor BFS and writes `dimmed` into edge `data` → re-render with reduced opacity.
- **Out**: edge deletion requests and `data` mutations flow through the same `useWorkflowStore.onNodesChange`/edge-change pipeline the rest of the canvas uses; no direct store writes from render.

## Integration

- **Stores**: `lib/store.ts` — `useWorkflowStore` edge list (`edges`, `insertEdge`, edge change handlers) and `NodeData` types for edge `data`.
- **lib/**: `lib/edgeStyles` (stroke/gradient palette consumed when rendering), `lib/utils` (`cn`) if class merging is needed.
- **Consumed by**: `components/WorkflowCanvas.tsx` (`edgeTypes = { default: CuttableEdge, … }`); dim/error/dying flags are written by `WorkflowCanvas` selection & generation logic and by `components/nodes/*` error propagation.
- **External**: `@xyflow/react` (`EdgeProps`, `getBezierPath`/path helpers, `BaseEdge`-style rendering), `lucide-react` (scissor icon).

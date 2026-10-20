# components/nodes/

## Responsibility

All ReactFlow node renderers plus their shared chrome helpers. Every workflow node type the canvas can instantiate lives here and is registered in `WorkflowCanvas`'s `nodeTypes` map.

**Node types** (export `default`, keyed in `nodeTypes`):

| File | Node type key | Role |
|---|---|---|
| `NoteNode.tsx` (23 L) | `noteNode` | Minimal free-text sticky note |
| `CommentNode.tsx` (88 L) | `commentNode` | Annotation node (readOnly-aware) |
| `PromptNode.tsx` (1306 L) | `promptNode` | Text prompt + prompt-library/assist integration |
| `AssistantNode.tsx` (444 L) | `assistantNode` | Chat/assistant turn node |
| `GenerateNode.tsx` (1601 L) | `generateNode` | Primary text→media generation node |
| `ImageGenNode.tsx` (114 L) | `imageGenNode` | Thin image-generation variant |
| `VideoGenNode.tsx` (150 L) | `videoGenNode` | Thin video-generation variant |
| `VideoGeneratorNode.tsx` (2286 L) | `videoGeneratorNode` | Full-featured video pipeline node (largest) |
| `ImageInputNode.tsx` (540 L) | `imageInputNode` | Image source/upload node |
| `VideoInputNode.tsx` (1473 L) | `videoInputNode` | Video source/upload node |
| `GroupNode.tsx` (825 L) | `groupNode` | Container node: color-coded grouping, ancestor collection, arrange/zip export |
| `Assistant…`, *helpers*: `CornerResizer.tsx`, `GenerateButton.tsx`, `NodeActionBar.tsx`, `MissingInputWarning.tsx` | — | Shared node chrome (default exports, not registered as node types) |

(`test` in this directory is a stray file, not a test folder.)

## Design

- **React patterns**: each node is a self-contained `"use client"` functional component typed `NodeProps`/`Node<NodeData, "…">`; heavy nodes (Generate/Prompt/VideoGenerator) hold large amounts of local `useState` for editor/UI drafts, and read canonical data from the store with `useWorkflowStore` (28 call sites in `GenerateNode` alone). Shared UI is factored into `NodeActionBar`, `GenerateButton`, `CornerResizer`, `MissingInputWarning` to avoid duplicating chrome across node types. `GroupNode` defines its own local `Btn` primitive and `collectAncestors` BFS helper.
- **@xyflow usage**: `<Handle type="source|target" position={Position.…}>` for connection points (input nodes declare multiple typed handles), `NodeToolbar` for contextual toolbars, `NodeResizeControl` (via `CornerResizer`) for resizing, `useUpdateNodeInternals` when dynamic handles appear, `useViewport` for viewport-relative popups, `useReactFlow` for programmatic node ops (GroupNode: `arrangeNodes`, zip export via `lib/makeZip`).
- **shadcn/ui**: node internals mostly use inline `style={{}}` (matching the rest of the app outside `components/ui`); a few import `@/components/nodes/GenerateButton` and `next/image` for media. Popups/animations use dedicated hooks (`lib/useAnimatedPopup`, `lib/useGeneratingBorderAnimation`).
- **zustand**: `useWorkflowStore` + `NodeData` from `lib/store.ts` is the single source of truth — nodes read their own `data` by id and call `updateNodeData`/generation actions; never keep long-lived copies of workflow state in local state.
- **Read-only mode**: 6 nodes (`Assistant`, `Comment`, `Generate`, `Group`, `Prompt`, `VideoGenerator`) gate editing via `useReadOnly()` from `lib/readOnlyContext`.
- **Generation pipeline**: generation nodes use `usePipelineRunner` to execute graph steps, `lib/executor.resolveInputs` to gather upstream inputs, `lib/providers` for model/provider selection, `lib/modelConfig` (`IMAGE_MODELS`, `VIDEO_MODELS`, Azure size validation) for model metadata, `lib/assetHash`/`lib/galleryUtils` for media identity & thumbnails.

## Flow

- **Props in**: ReactFlow passes `id`, `data: NodeData`, `selected`, and geometry; everything else is hook-derived.
- **Data flow (generation)**: user edits local draft → action handler writes `updateNodeData(id, …)` → `usePipelineRunner` resolves upstream node outputs via `resolveInputs` over `edges` → runs provider call → writes results back into `data` → `useGeneratingBorderAnimation` + `MissingInputWarning` reflect status; `browserNotify`/`requestNotificationPermission` fire on completion.
- **Events**: resize (`CornerResizer` → ReactFlow resize callback → `lastNodeSize` in store), toolbar actions (`NodeActionBar` → store actions), handle connections (ReactFlow → `insertEdge`), dynamic handles (`useUpdateNodeInternals`), popups (`useAnimatedPopup` enter/leave).
- **Read-only**: `useReadOnly()` short-circuits mutation handlers so shared/readonly workflows render but don't edit.

## Integration

- **Stores**: `lib/store.ts` — `useWorkflowStore`, `NodeData` (primary), plus undo/redo, `nodeCounters`, `lastNodeSize` indirectly via store actions. Read-only flag via `lib/readOnlyContext` (React context, not zustand).
- **lib/** consumed: `store` (11 files), `readOnlyContext` (6), `useGeneratingBorderAnimation` (5), `modelConfig` (5), `useAnimatedPopup` (3), `executor` (2), `assetHash` (2), and one-off: `usePipelineRunner`, `textFormat`, `providers`, `makeZip`, `galleryUtils`, `browserNotify`, `arrangeNodes`, `systemPrompt` (AssistantNode), `nodeTypes` (`NODE_SIZE`/default sizing).
- **Sibling components**: helpers are cross-imported within this folder (`GenerateButton`, `NodeActionBar`, `CornerResizer`, `MissingInputWarning`); nothing here imports parent-folder components.
- **Consumed by**: `components/WorkflowCanvas.tsx` `nodeTypes` registry (all 11 node keys above); edge dimming/error state in `components/edges/CuttableEdge` is driven by selection/error propagation originating from these nodes.
- **External**: `@xyflow/react`, `next/image`, `lucide-react`.

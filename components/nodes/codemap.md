# components/nodes/

## Responsibility

All ReactFlow node renderers plus their shared chrome helpers. Every workflow node type the canvas can instantiate lives here and is registered in `WorkflowCanvas`'s `nodeTypes` map.

**Registered node types** (export `default`, keyed in `nodeTypes`):

| File | Node type key | Role |
|---|---|---|
| `CommentNode.tsx` (88 L) | `commentNode` | Annotation node (readOnly-aware) |
| `PromptNode.tsx` (1306 L) | `promptNode` | Text prompt + prompt-library/assist integration |
| `AssistantNode.tsx` (447 L) | `assistantNode` | Streaming assistant turn: prompt → optimized prompt |
| `GenerateNode.tsx` (1640 L) | `generateNode` | Primary text→image generation node |
| `VideoGeneratorNode.tsx` (2392 L) | `videoGeneratorNode` | Full-featured video pipeline node (largest) |
| `ImageInputNode.tsx` (540 L) | `imageInputNode` | Image source/upload node |
| `VideoInputNode.tsx` (1473 L) | `videoInputNode` | Video source/upload node |
| `GroupNode.tsx` (825 L) | `groupNode` | Container node: color-coded grouping, ancestor collection, pipeline run, arrange/zip export |

**Helpers** (default exports, *not* registered as node types): `CornerResizer.tsx`, `GenerateButton.tsx`, `NodeActionBar.tsx`, `MissingInputWarning.tsx`.

**Removed (do not reintroduce)**: `ImageGenNode.tsx` (`imageGenNode`) and `VideoGenNode.tsx` (`videoGenNode`) — the thin image/video variants were deleted in the provider-refactor cleanup; image generation is `generateNode`, video generation is `videoGeneratorNode`. No store/NODES/`nodeTypes` entry remains for either key. `NoteNode.tsx` (`noteNode`) also still exists but is **not** registered in `nodeTypes`/`NODES` — treat it as dead unless re-registered deliberately. (`test` in this directory is an empty stray file, not a test folder.)

## Design

- **React patterns**: each node is a self-contained `"use client"` functional component typed `NodeProps`/`Node<NodeData, "…">`; heavy nodes hold local `useState` for editor/UI drafts and read canonical data from the store with `useWorkflowStore` (9 files). Shared chrome is factored into `NodeActionBar`, `GenerateButton`, `CornerResizer`, `MissingInputWarning`. `GroupNode` defines its own local `Btn` primitive and `collectAncestors` BFS helper.
- **Provider / model UI**: `GenerateNode` and `VideoGeneratorNode` import the consolidated `components/ui/ProviderIcon` marks — `ProviderBrandIcon` for the backend pill, `NodeProviderIcon` for model-brand rows (the old in-node copies are gone). Pickers are filtered by `isModelEnabled(model, disabledModels)`, provider pills by `enabledProvidersForModel(..., disabledProviders)`, and defaults skip hidden models via `defaultModelId`. `isModelReady(model, provider)` gates generation on hydrated credentials. Switching a model's backend calls `setModelProvider` and is offered only when `modelHasProviderChoice` (≥2 enabled bindings).
- **Run log**: both generation nodes render `components/JobLogViewer` behind a "Run log" disclosure, fed by `logTaskId = data.taskId ?? data.lastTaskId` (`lastTaskId` survives settle so the trail stays readable). The viewer is read-only and never touches the node's status machine.
- **@xyflow usage**: `<Handle type="source|target" position={Position.…}>` for connection points (input nodes declare multiple typed handles), `NodeToolbar` via `NodeActionBar`/`GroupNode`, `NodeResizeControl` via `CornerResizer` (or directly in `GroupNode`), `useUpdateNodeInternals` when the dynamic handle set changes, `useViewport` for viewport-relative popups, `useReactFlow` for programmatic node ops (GroupNode: `arrangeNodes`, zip export via `lib/makeZip`).
- **GenerateNode specifics**: capability map derived from `IMAGE_MODELS` (`supportsImages`, ratios, max images, quality options, Azure resolutions); CSS `aspectRatio` from the chosen ratio (natural ratio wins once an image exists); Azure manual width/height validated with `validateAzureCustomSize`; multi-generation history slots (`generations`, `currentGenIdx`) with per-slot errors; idle caption hint (ratio · quality); missing-input warnings for prompt/image.
- **VideoGeneratorNode specifics**: per-model handle matrix (`cfg.handles` → `BASE_HANDLES`/`HANDLE_ORDER`), bottom-anchored stacking, mutual exclusivity between frames and reference media (Veo `frames`/`references` modes), dynamic typed source handles (`startFrameOut`, `endFrameOut`, `imagePickOut`, `videoRefOut`, `audioRefOut`) with `useUpdateNodeInternals`, frame extraction/eager frame previews, and an adaptive-framing fallback of `16 / 9` so non-ratio models don't collapse the card.
- **AssistantNode specifics**: input/output toggle (auto-switches to output on run), SSE streaming from `/api/assistant` with an inline prompt-engineer system prompt, abortable Stop, model dropdown filtered by `isModelEnabled`; output handle `textOut` (brain icon).
- **shadcn/ui**: node internals use inline `style={{}}` + Tailwind utility classes (matching the rest of the app outside `components/ui`); media via `next/image`; popups/animations via `lib/useAnimatedPopup`, `lib/useGeneratingBorderAnimation`.
- **zustand**: `useWorkflowStore` + `NodeData` from `lib/store.ts` is the single source of truth — nodes read their own `data` by id and call `updateNodeData`/generation actions; never keep long-lived copies of workflow state in local state.
- **Read-only mode**: 6 nodes (`Assistant`, `Comment`, `Generate`, `Group`, `Prompt`, `VideoGenerator`) gate editing via `useReadOnly()` from `lib/readOnlyContext`.

## Flow

- **Props in**: ReactFlow passes `id`, `data: NodeData`, `selected`, and geometry; everything else is hook-derived.
- **Data flow (generation)**: user edits local draft → action handler writes `updateNodeData(id, …)` → the node resolves upstream outputs with `resolveInputs` over `edges` → `GenerateNode` POSTs `/api/generate`, `VideoGeneratorNode` POSTs `/api/generate-video` → `taskId` + `lastTaskId` written to `data` → completion writes results back and appends to `generations`; `useGeneratingBorderAnimation` + `MissingInputWarning` reflect status; `browserNotify` fires on completion (`GenerateNode`).
- **Completion transport**: `GenerateNode` polls `/api/job-status?taskId=` every 3 s (plus an immediate poll on `visibilitychange`) and handles `done`/`error`/`not_found`; `VideoGeneratorNode` subscribes to `/api/job-stream?taskId=` (SSE, callback-driven, no polling). Both clear `taskId` on settle while keeping `lastTaskId`.
- **Events**: resize (`CornerResizer` → ReactFlow resize callback → `lastNodeSize` in store), toolbar actions (`NodeActionBar` → store actions), handle connections (ReactFlow → `insertEdge`; `killEdgesForHandles`/`remapTargetHandle` when the active handle set changes), dynamic handles (`useUpdateNodeInternals`), popups (`useAnimatedPopup` enter/leave), group pipeline (`usePipelineRunner` over `memberIds`).
- **Read-only**: `useReadOnly()` short-circuits mutation handlers so shared/readonly workflows render but don't edit.

## Integration

- **Stores**: `lib/store.ts` — `useWorkflowStore`, `NodeData` (primary), plus undo/redo, `nodeCounters`, `lastNodeSize`, `disabledModels`/`disabledProviders`, provider maps. Read-only flag via `lib/readOnlyContext` (React context, not zustand).
- **lib/** consumed: `store` (9 files), `readOnlyContext` (6), `modelConfig` (5), `providers` (3), `useGeneratingBorderAnimation` (3), `useAnimatedPopup` (3), `executor` (`resolveInputs`, 2), `assetHash` (2), and one-off: `usePipelineRunner`, `textFormat`, `makeZip`, `galleryUtils`, `browserNotify`, `arrangeNodes`.
- **Sibling components**: helpers are cross-imported within this folder (`GenerateButton`, `NodeActionBar`, `CornerResizer`, `MissingInputWarning`); nodes also import `components/ui/ProviderIcon` and `components/JobLogViewer`. Nothing here imports other parent-folder components.
- **Consumed by**: `components/WorkflowCanvas.tsx` `nodeTypes` registry (8 keys above); edge dimming/error state in `components/edges/CuttableEdge` is driven by selection/error propagation originating from these nodes.
- **External**: `@xyflow/react`, `next/image`, `lucide-react`.

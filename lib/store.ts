import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { edgeStyle } from "./edgeStyles";
import { VIDEO_MODELS } from "./modelConfig";
import { requestWorkflowSync } from "./workflowSyncBus";
// TYPE-ONLY import: `lib/providers.ts` imports this store at runtime, so the
// dependency must not be a runtime edge (it would be a cycle). The `ProviderId`
// type is erased at compile time.
import type { ProviderId } from "./providers";
import {
  Node,
  Edge,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  NodeChange,
  EdgeChange,
  Connection,
} from "@xyflow/react";

export type NodeStatus = "idle" | "pending" | "running" | "done" | "error";
export type GenerateMode = "t2i" | "t2v" | "i2i" | "i2v";

export interface NodeData extends Record<string, unknown> {
  label: string;
  status?: NodeStatus;
  // shared
  prompt?: string;
  textMode?: "text" | "json" | "yaml"; // initial JSON/YAML toggle state for promptNode (seeded on creation)
  // comment / sticky-note node
  comment?: string;
  // generate node
  mode?: GenerateMode;
  model?: string;
  aspectRatio?: string;
  duration?: number;
  // image (input or output)
  imageUrl?: string;
  inputImage?: string;      // base64 data URL — only kept while session is active
  r2Url?: string;           // R2 CDN URL — durable, used instead of inputImage after upload
  imageNaturalRatio?: string;
  // generation settings
  quality?: string;
  azureQuality?: string;
  azureResolution?: string;
  azureCustomWidth?: number;
  azureCustomHeight?: number;
  // video output
  videoUrl?: string;
  // video model
  videoModel?: string;
  // kling 3.0 settings
  sound?: boolean;
  klingMode?: string;
  count?: number;
  veoMode?: "frames" | "references";
  // grok imagine settings

  grokMode?: string;
  grokResolution?: string;
  // seed (for models that support it)
  seed?: number;
  // error
  errorMsg?: string;
  // validation
  hasError?: boolean;
  locked?: boolean;
  // pending job
  taskId?: string;
}

/** Pick only the listed keys from an object; returns null if none are present. */
function filterKeys<T extends object>(obj: T, keys: (keyof T)[]): Partial<T> | null {
  const result: Partial<T> = {};
  let found = false;
  for (const k of keys) {
    if (k in obj) { result[k] = obj[k]; found = true; }
  }
  return found ? result : null;
}

/** Human-readable label for each node type, including the counter */
export function getNodeLabel(type: string, n: number): string {
  if (type === "assistantNode") return "ASSISTANT";
  const map: Record<string, string> = {
    promptNode:          `Text #${n}`,
    imageInputNode:      `Image #${n}`,
    generateNode:        `Image Generator #${n}`,
    videoGeneratorNode:  `Video Generator #${n}`,
    commentNode:         `Comment #${n}`,
  };
  return map[type] ?? `Node #${n}`;
}

// ── Space ─────────────────────────────────────────────────────────────────────

export interface Space {
  id: string;
  name: string;
  nodes: Node<NodeData>[];
  edges: Edge[];
  nodeCounters: Record<string, number>;
  createdAt: number;
  updatedAt?: number;
  viewport?: { x: number; y: number; zoom: number };
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function makeSpace(name: string, partial?: Partial<Space>): Space {
  return {
    id:           uid(),
    name,
    nodes:        [],
    edges:        [],
    nodeCounters: {},
    createdAt:    Date.now(),
    ...partial,
  };
}

// Sync the current nodes/edges/nodeCounters back into the spaces array.
// Call this inside every action that mutates those fields.
function syncSpace(
  spaces: Space[],
  activeId: string,
  nodes: Node<NodeData>[],
  edges: Edge[],
  nodeCounters: Record<string, number>,
): Space[] {
  return spaces.map((sp) =>
    sp.id === activeId ? { ...sp, nodes, edges, nodeCounters, updatedAt: Date.now() } : sp
  );
}

// ── Undo / Redo snapshot ───────────────────────────────────────────────────────

interface Snapshot { nodes: Node<NodeData>[]; edges: Edge[] }

const MAX_UNDO = 50;

// ── Store interface ────────────────────────────────────────────────────────────

export interface Toast {
  id:       string;
  message:  string;
  type:     "error" | "success" | "info";
  href?:    string;
  title?:   string;
  preview?: string;
}

/**
 * One provider's non-secret readiness (GET /api/settings/providers →
 * `providers[id]`, design §3.3). `hasKey` doubles as the chat-compat
 * kieKeySet/azureKeySet source (§3.4).
 */
export interface ProviderStatusEntry {
  hasKey:    boolean;
  ready:     boolean;
  deployments: Record<string, string>;
  baseUrl?:  string | null;
  keySource?: string;
  /** The provider-level param preset id (compat-plan §c) — "" when unset. */
  presetId?: string;
}

export type ProviderStatusMap = Record<string, ProviderStatusEntry>;

/**
 * One stored param preset (GET /api/settings/providers → `presets`).
 * The Settings picker lists the ids and previews the params JSON — v1 has no
 * preset editor (compat-plan §d).
 */
export interface ProviderPresetInfo {
  id: string;
  family: string;
  params: Record<string, unknown>;
}

interface WorkflowStore {
  // ── Provider/model visibility toggles (declutter) — persisted client-side.
  //    A disabled provider/model is hidden from every model picker; the
  //    Settings lists still show it (greyed) so it can be re-enabled.
  disabledProviders: ProviderId[];
  disabledModels: string[];
  setProviderEnabled: (id: ProviderId, enabled: boolean) => void;
  setModelEnabled: (id: string, enabled: boolean) => void;

  // ── Custom assistant system prompt (client-side, overrides the built-in
  //    lib/systemPrompt.ts default when non-empty).
  customSystemPrompt: string;
  setCustomSystemPrompt: (v: string) => void;

  // ── Toasts
  toasts:      Toast[];
  addToast:    (message: string, type?: Toast["type"], href?: string, title?: string, preview?: string) => void;
  removeToast: (id: string) => void;

  // ── Kie key status (null = unknown, true = set, false = not set)
  kieKeySet:    boolean | null;
  setKieKeySet: (v: boolean | null) => void;

  // ── Azure key status (null = unknown, true = set, false = not set)
  azureKeySet:    boolean | null;
  setAzureKeySet: (v: boolean | null) => void;

  // ── Provider readiness bootstrap (Phase 5, design §3.4) — hydrated from
  //    GET /api/settings/providers by AppSidebar; NOT persisted (server-authoritative).
  providerStatus:    ProviderStatusMap;
  modelProviders:    Record<string, string>;   // modelId → active providerId (modelPrefs)
  bindingsByModel:   Record<string, string[]>; // C8 union: static bindings ∪ rows
  providersHydrated: boolean;
  /** The stored param presets (compat-plan §c) — the Settings picker's data. */
  presets:           ProviderPresetInfo[];
  setProviderBootstrap: (payload: {
    providers?: Record<string, {
      hasKey?: boolean;
      ready?: boolean;
      deployments?: Record<string, string>;
      baseUrl?: string | null;
      keySource?: string;
      presetId?: string;
    }>;
    modelPrefs?: Record<string, string>;
    bindingsByModel?: Record<string, string[]>;
    presets?: ProviderPresetInfo[];
  }) => void;

  // ── Spaces
  spaces:        Space[];
  activeSpaceId: string;

  // ── Live state (mirrors the active space; kept in sync on every mutation)
  nodes:        Node<NodeData>[];
  edges:        Edge[];
  isRunning:    boolean;
  debugMode:    boolean;
  nodeCounters: Record<string, number>;

  // ── Undo / Redo
  undoStack: Snapshot[];
  redoStack: Snapshot[];
  pushUndoSnapshot: () => void;
  undo: () => void;
  redo: () => void;

  // ── Space actions
  createSpace:    (name: string, template?: { nodes: Node<NodeData>[]; edges: Edge[]; nodeCounters: Record<string, number> }) => void;
  switchSpace:    (id: string)   => void;
  renameSpace:    (id: string, name: string) => void;
  deleteSpace:    (id: string)   => void;
  duplicateSpace: (id: string)   => void;

  // ── Workflow actions
  onNodesChange:      (changes: NodeChange[]) => void;
  onEdgesChange:      (changes: EdgeChange[]) => void;
  onConnect:          (connection: Connection) => void;
  addNode:            (node: Node<NodeData>) => void;
  insertEdge:         (edge: Edge) => void;
  removeEdgesForHandle: (nodeId: string, handleId: string) => void;
  killEdgesForHandles:  (nodeId: string, handleIds: string[]) => void;
  remapTargetHandle:    (nodeId: string, fromHandle: string, toHandle: string) => void;
  flashEdgeError:       (edgeId: string) => void;
  updateNodeData:     (id: string, data: Partial<NodeData>) => void;
  updateNodeSize:     (id: string, width: number, height: number) => void;
  setIsRunning:       (v: boolean) => void;
  toggleDebug:        () => void;
  /** The type being dragged during an active connection ("prompt" | "image" | "video" | null) */
  connectingHandleType: string | null;
  setConnectingHandleType: (type: string | null) => void;
  settingsOpen:              boolean;
  setSettingsOpen:           (v: boolean) => void;
  showDashboard:             boolean;
  setShowDashboard:          (v: boolean) => void;
  globalMuted:               boolean;
  setGlobalMuted:            (v: boolean) => void;
  sidebarCollapsed:          boolean;
  setSidebarCollapsed:       (v: boolean) => void;
  saveViewport: (viewport: { x: number; y: number; zoom: number }) => void;
  loadSpacesFromDB: (spaces: Space[]) => void;
  clearLocalData: () => void;

  // ── Per-type node defaults (last-used params)
  nodeDefaults: {
    generateNode:        Partial<NodeData>;
    videoGeneratorNode:  Partial<NodeData>;
  };

  /** Last manually-resized {w,h} per node type — new nodes of that type inherit it. */
  lastNodeSize: Record<string, { w: number; h: number }>;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useWorkflowStore = create<WorkflowStore>()(
  persist(
    (set, get) => {
      const defaultSpace = makeSpace("Space 1");

      return {
        spaces:        [defaultSpace],
        activeSpaceId: defaultSpace.id,

        nodes:        [],
        edges:        [],
        isRunning:    false,
        debugMode:    false,
        nodeCounters: {},

        nodeDefaults: { generateNode: {}, videoGeneratorNode: {} },
        lastNodeSize: {},

        undoStack: [],
        redoStack: [],

        pushUndoSnapshot: () =>
          set((s) => ({
            undoStack: [...s.undoStack.slice(-(MAX_UNDO - 1)), { nodes: s.nodes, edges: s.edges }],
            redoStack: [],
          })),

        undo: () =>
          set((s) => {
            if (s.undoStack.length === 0) return {};
            const snap = s.undoStack[s.undoStack.length - 1];
            return {
              nodes:     snap.nodes,
              edges:     snap.edges,
              undoStack: s.undoStack.slice(0, -1),
              redoStack: [...s.redoStack, { nodes: s.nodes, edges: s.edges }],
              spaces:    syncSpace(s.spaces, s.activeSpaceId, snap.nodes, snap.edges, s.nodeCounters),
            };
          }),

        redo: () =>
          set((s) => {
            if (s.redoStack.length === 0) return {};
            const snap = s.redoStack[s.redoStack.length - 1];
            return {
              nodes:     snap.nodes,
              edges:     snap.edges,
              undoStack: [...s.undoStack, { nodes: s.nodes, edges: s.edges }],
              redoStack: s.redoStack.slice(0, -1),
              spaces:    syncSpace(s.spaces, s.activeSpaceId, snap.nodes, snap.edges, s.nodeCounters),
            };
          }),

        // ── Space actions ──────────────────────────────────────────────────

        createSpace: (name, template) =>
          set((s) => {
            const sp = makeSpace(name, template ? {
              nodes:        template.nodes,
              edges:        template.edges,
              nodeCounters: template.nodeCounters,
            } : undefined);
            const spaces = [
              ...syncSpace(s.spaces, s.activeSpaceId, s.nodes, s.edges, s.nodeCounters),
              sp,
            ];
            return {
              spaces,
              activeSpaceId: sp.id,
              nodes:         template?.nodes        ?? [],
              edges:         template?.edges        ?? [],
              nodeCounters:  template?.nodeCounters ?? {},
              undoStack:     [],
              redoStack:     [],
            };
          }),

        switchSpace: (id) =>
          set((s) => {
            if (id === s.activeSpaceId) return {};
            const target = s.spaces.find((sp) => sp.id === id);
            if (!target) return {};
            const spaces = syncSpace(s.spaces, s.activeSpaceId, s.nodes, s.edges, s.nodeCounters);
            return {
              spaces,
              activeSpaceId: id,
              nodes:         target.nodes,
              edges:         target.edges,
              nodeCounters:  target.nodeCounters,
              undoStack:     [],
              redoStack:     [],
            };
          }),

        renameSpace: (id, name) =>
          set((s) => ({
            spaces: s.spaces.map((sp) => (sp.id === id ? { ...sp, name } : sp)),
          })),

        deleteSpace: (id) =>
          set((s) => {
            if (s.spaces.length <= 1) return {}; // must have at least one
            const remaining = s.spaces.filter((sp) => sp.id !== id);
            if (s.activeSpaceId !== id) return { spaces: remaining };
            const next = remaining[0];
            return {
              spaces:        remaining,
              activeSpaceId: next.id,
              nodes:         next.nodes,
              edges:         next.edges,
              nodeCounters:  next.nodeCounters,
            };
          }),

        duplicateSpace: (id) =>
          set((s) => {
            const original = s.spaces.find((sp) => sp.id === id);
            if (!original) return {};
            const copy = makeSpace(`${original.name} (copy)`, {
              nodes:        original.nodes,
              edges:        original.edges,
              nodeCounters: original.nodeCounters,
            });
            const spaces = syncSpace(s.spaces, s.activeSpaceId, s.nodes, s.edges, s.nodeCounters);
            return { spaces: [...spaces, copy] };
          }),

        // ── Workflow actions (each syncs back to spaces) ────────────────────

        onNodesChange: (changes) => {
          set((s) => {
            const nodes = applyNodeChanges(changes, s.nodes) as Node<NodeData>[];
            const removedIds = new Set(
              changes
                .filter((c): c is Extract<NodeChange, { type: "remove" }> => c.type === "remove")
                .map((c) => c.id)
            );
            const edges = removedIds.size > 0
              ? s.edges.filter((e) => !removedIds.has(e.source) && !removedIds.has(e.target))
              : s.edges;

            // A "dimensions" change with resizing === false is the final size of a
            // manual corner-drag resize (as opposed to auto-measurement, which omits
            // `resizing`). Remember it per node type so new nodes inherit the last size.
            let lastNodeSize = s.lastNodeSize;
            for (const c of changes) {
              if (c.type !== "dimensions" || c.resizing !== false || !c.dimensions) continue;
              const nodeType = s.nodes.find((n) => n.id === c.id)?.type;
              if (!nodeType) continue;
              lastNodeSize = {
                ...lastNodeSize,
                [nodeType]: { w: c.dimensions.width, h: c.dimensions.height },
              };
            }

            return {
              nodes,
              edges,
              lastNodeSize,
              spaces: syncSpace(s.spaces, s.activeSpaceId, nodes, edges, s.nodeCounters),
            };
          });
          // Persist discrete edits (node removed, or a manual resize finished)
          // right away; drag/auto-measure churn still rides the debounce.
          const discrete = changes.some(
            (c) => c.type === "remove" || (c.type === "dimensions" && c.resizing === false),
          );
          if (discrete) requestWorkflowSync();
        },

        onEdgesChange: (changes) => {
          set((s) => {
            const edges = applyEdgeChanges(changes, s.edges);
            return {
              edges,
              spaces: syncSpace(s.spaces, s.activeSpaceId, s.nodes, edges, s.nodeCounters),
            };
          });
          if (changes.some((c) => c.type === "remove")) requestWorkflowSync();
        },

        onConnect: (connection) => {
          set((s) => {
            const undoStack = [...s.undoStack.slice(-(MAX_UNDO - 1)), { nodes: s.nodes, edges: s.edges }];
            let colorKey: string | undefined;
            if (connection.targetHandle === "startFrame") {
              const targetNode = s.nodes.find((n) => n.id === connection.target);
              const videoModelId = (targetNode?.data?.videoModel as string | undefined) ?? "";
              const videoModelCfg = VIDEO_MODELS.find((m) => m.id === videoModelId);
              if (videoModelCfg?.apiInput.useMotionControl) colorKey = "character";
            }
            const edges = addEdge(
              {
                ...connection,
                animated: false,
                style: edgeStyle(connection.targetHandle),
                ...(colorKey ? { data: { colorKey } } : {}),
              },
              s.edges
            );
            return {
              edges,
              undoStack,
              redoStack: [],
              spaces: syncSpace(s.spaces, s.activeSpaceId, s.nodes, edges, s.nodeCounters),
            };
          });
          requestWorkflowSync();
        },

        addNode: (node) => {
          set((s) => {
            const undoStack    = [...s.undoStack.slice(-(MAX_UNDO - 1)), { nodes: s.nodes, edges: s.edges }];
            const type         = node.type ?? "unknown";
            const count        = (s.nodeCounters[type] ?? 0) + 1;
            const label        = getNodeLabel(type, count);
            const savedDefaults =
              type === "generateNode"       ? s.nodeDefaults.generateNode :
              type === "videoGeneratorNode" ? s.nodeDefaults.videoGeneratorNode : {};
            const data = { ...savedDefaults, ...node.data, label };
            // A hidden model must never be the default of a NEW node: the
            // remembered last-used model (nodeDefaults / getLastNodeSettings)
            // and the picker's own defaults are dropped when hidden. The node
            // then falls back to its own enabled default.
            if (typeof data.model === "string" && s.disabledModels.includes(data.model)) {
              delete data.model;
            }
            if (typeof data.videoModel === "string" && s.disabledModels.includes(data.videoModel)) {
              delete data.videoModel;
            }
            const nodes        = [
              ...s.nodes.map((n) => n.selected ? { ...n, selected: false } : n),
              { ...node, selected: true, data },
            ];
            const nodeCounters = { ...s.nodeCounters, [type]: count };
            return {
              nodes,
              nodeCounters,
              undoStack,
              redoStack: [],
              spaces: syncSpace(s.spaces, s.activeSpaceId, nodes, s.edges, nodeCounters),
            };
          });
          requestWorkflowSync();
        },

        insertEdge: (edge) => {
          set((s) => {
            const undoStack = [...s.undoStack.slice(-(MAX_UNDO - 1)), { nodes: s.nodes, edges: s.edges }];
            const edges = [...s.edges, edge];
            return {
              edges,
              undoStack,
              redoStack: [],
              spaces: syncSpace(s.spaces, s.activeSpaceId, s.nodes, edges, s.nodeCounters),
            };
          });
          requestWorkflowSync();
        },

        removeEdgesForHandle: (nodeId, handleId) =>
          set((s) => {
            const edges = s.edges.filter(
              (e) => !(e.target === nodeId && e.targetHandle === handleId)
            );
            return {
              edges,
              spaces: syncSpace(s.spaces, s.activeSpaceId, s.nodes, edges, s.nodeCounters),
            };
          }),

        killEdgesForHandles: (nodeId, handleIds) => {
          const handleSet = new Set(handleIds);
          // Mark matching edges as dying
          set((s) => ({
            edges: s.edges.map((e) =>
              e.target === nodeId && handleSet.has(e.targetHandle ?? "")
                ? { ...e, data: { ...e.data, dying: true } }
                : e
            ),
          }));
          // Remove after animation
          setTimeout(() => {
            set((s) => {
              const edges = s.edges.filter(
                (e) => !(e.target === nodeId && handleSet.has(e.targetHandle ?? ""))
              );
              return {
                edges,
                spaces: syncSpace(s.spaces, s.activeSpaceId, s.nodes, edges, s.nodeCounters),
              };
            });
          }, 450);
        },

        remapTargetHandle: (nodeId, fromHandle, toHandle) =>
          set((s) => {
            const edges = s.edges.map((e) =>
              e.target === nodeId && e.targetHandle === fromHandle
                ? { ...e, targetHandle: toHandle }
                : e
            );
            return { edges, spaces: syncSpace(s.spaces, s.activeSpaceId, s.nodes, edges, s.nodeCounters) };
          }),

        flashEdgeError: (edgeId) => {
          const setError = (val: boolean) =>
            set((s) => ({
              edges: s.edges.map((e) =>
                e.id === edgeId ? { ...e, data: { ...e.data, error: val } } : e
              ),
            }));
          setError(true);
          setTimeout(() => setError(false), 1400);
        },

        updateNodeData: (id, data) =>
          set((s) => {
            const nodes = s.nodes.map((n) =>
              n.id === id ? { ...n, data: { ...n.data, ...data } } : n
            );

            // Capture param changes into per-type defaults so new nodes inherit them
            const nodeType = s.nodes.find((n) => n.id === id)?.type;
            let nodeDefaults = s.nodeDefaults;
            if (nodeType === "generateNode") {
              const pick = filterKeys(data, ["model", "aspectRatio", "quality", "azureQuality", "azureResolution"]);
              if (pick) nodeDefaults = { ...nodeDefaults, generateNode: { ...nodeDefaults.generateNode, ...pick } };
            } else if (nodeType === "videoGeneratorNode") {
              const pick = filterKeys(data, ["videoModel", "klingMode", "duration", "aspectRatio", "sound", "grokResolution"]);
              if (pick) nodeDefaults = { ...nodeDefaults, videoGeneratorNode: { ...nodeDefaults.videoGeneratorNode, ...pick } };
            }

            return {
              nodes,
              nodeDefaults,
              spaces: syncSpace(s.spaces, s.activeSpaceId, nodes, s.edges, s.nodeCounters),
            };
          }),

        updateNodeSize: (id, width, height) => {
          // Ignore junk sizes — the ResizeObserver that drives this can fire
          // mid-teardown / mid-transition with a collapsed (0 / non-finite)
          // measurement, which must never be persisted as the node's real size.
          if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;

          // Skip no-op updates — the observer also fires on every layout tick
          // (image loads, CSS transitions); re-writing an identical size just
          // churns `spaces` and keeps re-arming the sync debounce so it never
          // actually flushes.
          const current = get().nodes.find((n) => n.id === id);
          if (current && current.width === width && current.height === height) return;

          set((s) => {
            const GROUP_PADDING = 24;

            // Update the resized node first
            let nodes = s.nodes.map((n) =>
              n.id === id
                ? { ...n, width, height, style: { ...n.style, width, height } }
                : n
            );

            // Expand the group if the resized node now exceeds its bounds (never shrink)
            nodes = nodes.map((g) => {
              if (g.type !== "groupNode") return g;
              const memberIds = g.data?.memberIds as string[] | undefined;
              if (!memberIds?.includes(id)) return g;

              const node = nodes.find((n) => n.id === id);
              if (!node) return g;

              const gx = g.position.x;
              const gy = g.position.y;
              const gw = (g.style?.width  as number | undefined) ?? 0;
              const gh = (g.style?.height as number | undefined) ?? 0;

              // Right and bottom edges the node now occupies
              const nodeR = node.position.x + width;
              const nodeB = node.position.y + height;

              // Required group extents to contain the node (with padding)
              const reqX = Math.min(gx, node.position.x - GROUP_PADDING);
              const reqY = Math.min(gy, node.position.y - GROUP_PADDING);
              const reqR = Math.max(gx + gw, nodeR + GROUP_PADDING);
              const reqB = Math.max(gy + gh, nodeB + GROUP_PADDING);

              if (reqX === gx && reqY === gy && reqR === gx + gw && reqB === gy + gh) return g;

              return {
                ...g,
                position: { x: reqX, y: reqY },
                style: { ...g.style, width: reqR - reqX, height: reqB - reqY },
              };
            });

            return {
              nodes,
              spaces: syncSpace(s.spaces, s.activeSpaceId, nodes, s.edges, s.nodeCounters),
            };
          });
        },

        setIsRunning:     (v) => set({ isRunning: v }),
        toggleDebug:      () => set((s) => ({ debugMode: !s.debugMode })),

        connectingHandleType: null,
        setConnectingHandleType: (type) => set({ connectingHandleType: type }),

        saveViewport: (viewport) =>
          set((s) => ({
            spaces: s.spaces.map((sp) =>
              sp.id === s.activeSpaceId ? { ...sp, viewport } : sp
            ),
          })),

        loadSpacesFromDB: (dbSpaces) =>
          set((s) => {
            if (!dbSpaces.length) return {};

            // Build a lookup of local spaces by id
            const localById = new Map(s.spaces.map((sp) => [sp.id, sp]));

            // For each DB space, prefer whichever version is newer (local wins on tie).
            const merged = dbSpaces.map((dbSp) => {
              const local = localById.get(dbSp.id);
              if (!local) return dbSp;
              const localTs = local.updatedAt ?? local.createdAt ?? 0;
              const dbTs    = dbSp.updatedAt  ?? dbSp.createdAt  ?? 0;
              return localTs >= dbTs ? local : dbSp;
            });

            // Add local-only spaces (not yet in DB).
            // Always keep the active space (it may have just been created and is empty).
            // Skip other empty spaces — those are initialization placeholders.
            const dbIds = new Set(dbSpaces.map((sp) => sp.id));
            for (const sp of s.spaces) {
              if (!dbIds.has(sp.id)) {
                if (sp.id === s.activeSpaceId || sp.nodes.length > 0 || sp.edges.length > 0) {
                  merged.push(sp);
                }
              }
            }

            // If the current active space isn't in the merged set (e.g. it was an
            // empty placeholder), fall back to the first real DB space.
            const activeId = merged.find((sp) => sp.id === s.activeSpaceId)?.id ?? merged[0].id;
            const active   = merged.find((sp) => sp.id === activeId)!;
            return {
              spaces:        merged,
              activeSpaceId: activeId,
              nodes:         active.nodes,
              edges:         active.edges,
              nodeCounters:  active.nodeCounters,
            };
          }),

        clearLocalData: () => {
          const fresh = makeSpace("Space 1");
          set({
            spaces:        [fresh],
            activeSpaceId: fresh.id,
            nodes:         [],
            edges:         [],
            nodeCounters:  {},
            undoStack:     [],
            redoStack:     [],
          });
        },

        toasts: [],
        addToast: (message, type = "error", href, title, preview) =>
          set((s) => {
            const id = Math.random().toString(36).slice(2);
            return { toasts: [...s.toasts, { id, message, type, href, title, preview }] };
          }),
        removeToast: (id) =>
          set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

        // ── Visibility toggles (declutter) ────────────────────────────────
        disabledProviders: [],
        disabledModels: [],
        setProviderEnabled: (id, enabled) =>
          set((s) => ({
            disabledProviders: enabled
              ? s.disabledProviders.filter((p) => p !== id)
              : s.disabledProviders.includes(id)
                ? s.disabledProviders
                : [...s.disabledProviders, id],
          })),
        setModelEnabled: (id, enabled) =>
          set((s) => ({
            disabledModels: enabled
              ? s.disabledModels.filter((m) => m !== id)
              : s.disabledModels.includes(id)
                ? s.disabledModels
                : [...s.disabledModels, id],
          })),

        // ── Custom assistant system prompt (client-side override) ────────
        customSystemPrompt: "",
        setCustomSystemPrompt: (v) => set({ customSystemPrompt: v }),

        kieKeySet:    null,
        setKieKeySet: (v) => set({ kieKeySet: v }),

        azureKeySet:    null,
        setAzureKeySet: (v) => set({ azureKeySet: v }),

        // Phase 5 (design §3.4): server-authoritative provider readiness.
        providerStatus:    {},
        modelProviders:    {},
        bindingsByModel:   {},
        providersHydrated: false,
        presets:           [],
        setProviderBootstrap: (payload) =>
          set(() => {
            const providerStatus: ProviderStatusMap = {};
            for (const [id, p] of Object.entries(payload.providers ?? {})) {
              providerStatus[id] = {
                hasKey:      !!p.hasKey,
                ready:       !!p.ready,
                deployments: p.deployments ?? {},
                baseUrl:     p.baseUrl ?? null,
                keySource:   p.keySource,
                presetId:    p.presetId ?? "",
              };
            }
            return {
              providerStatus,
              modelProviders:    payload.modelPrefs    ?? {},
              bindingsByModel:   payload.bindingsByModel ?? {},
              providersHydrated: true,
              presets:           payload.presets       ?? [],
              // Chat compatibility (§3.4): the legacy key flags are DERIVED
              // from the same bootstrap instead of the kie-key/azure-key routes.
              kieKeySet:   payload.providers?.kie   ? !!payload.providers.kie.hasKey   : null,
              azureKeySet: payload.providers?.azure ? !!payload.providers.azure.hasKey : null,
            };
          }),

        settingsOpen:              false,
        setSettingsOpen:           (v) => set({ settingsOpen: v }),
        showDashboard:             true,
        setShowDashboard:          (v) => set({ showDashboard: v }),
        globalMuted:               true,
        setGlobalMuted:            (v) => set({ globalMuted: v }),
        sidebarCollapsed:          false,
        setSidebarCollapsed:       (v: boolean) => set({ sidebarCollapsed: v }),
      };
    },
    {
      name: "heliosgen-guest",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        spaces: s.spaces.map((sp) => ({
          ...sp,
          viewport: sp.viewport,
          // Strip base64 inputImage — only the durable r2Url survives reload
          nodes: sp.nodes.map((n) => ({
            ...n,
            data: { ...n.data, inputImage: undefined },
          })),
        })),
        activeSpaceId: s.activeSpaceId,
        // Also persist the live copies so a page refresh rehydrates correctly
        nodes: s.nodes.map((n) => ({
          ...n,
          data: { ...n.data, inputImage: undefined },
        })),
        edges:        s.edges,
        nodeCounters: s.nodeCounters,
        debugMode:    s.debugMode,
        sidebarCollapsed: s.sidebarCollapsed,
        nodeDefaults: s.nodeDefaults,
        lastNodeSize: s.lastNodeSize,
        // ── Client-side settings (persisted in localStorage) ──────────────
        disabledProviders: s.disabledProviders,
        disabledModels: s.disabledModels,
        customSystemPrompt: s.customSystemPrompt,
      }),

      // Migration: v0 had flat nodes/edges/nodeCounters; wrap them in a space
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Ensure nodeDefaults exists for old stored data
        if (!state.nodeDefaults) {
          state.nodeDefaults = { generateNode: {}, videoGeneratorNode: {} };
        }
        // Ensure lastNodeSize exists for old stored data
        if (!state.lastNodeSize) {
          state.lastNodeSize = {};
        }
        // Ensure the visibility toggles exist for old stored data
        if (!Array.isArray(state.disabledProviders)) state.disabledProviders = [];
        if (!Array.isArray(state.disabledModels)) state.disabledModels = [];
        if (typeof state.customSystemPrompt !== "string") state.customSystemPrompt = "";
        // If there are no spaces (old format), migrate
        if (!state.spaces || state.spaces.length === 0) {
          const sp = makeSpace("Space 1", {
            nodes:        state.nodes        ?? [],
            edges:        state.edges        ?? [],
            nodeCounters: state.nodeCounters ?? {},
          });
          state.spaces        = [sp];
          state.activeSpaceId = sp.id;
        }
      },
    }
  )
);

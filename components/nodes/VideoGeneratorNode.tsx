"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState, Fragment } from "react";
import { useAnimatedPopup } from "@/lib/useAnimatedPopup";
import { createPortal } from "react-dom";
import GenerateButton from "@/components/nodes/GenerateButton";
import JobLogViewer from "@/components/JobLogViewer";
import { Handle, Position, NodeProps, Node, useUpdateNodeInternals } from "@xyflow/react";
import CornerResizer from "./CornerResizer";
import NodeActionBar from "./NodeActionBar";
import { useWorkflowStore, NodeData } from "@/lib/store";
import { PROVIDERS, getModelProvider, setModelProvider, modelHasProviderChoice, enabledProvidersForModel, isModelReady, isModelEnabled, defaultModelId } from "@/lib/providers";
import { ProviderBrandIcon, NodeProviderIcon } from "@/components/ui/ProviderIcon";
import { resolveInputs } from "@/lib/executor";
import { useReadOnly } from "@/lib/readOnlyContext";
import { ShieldBan } from "lucide-react";
import { VIDEO_MODELS as VIDEO_MODEL_CFG } from "@/lib/modelConfig";
import { useGeneratingBorderAnimation } from "@/lib/useGeneratingBorderAnimation";
import MissingInputWarning from "./MissingInputWarning";

type VideoGeneratorNodeType = Node<NodeData, "videoGeneratorNode">;

// ── Handles ───────────────────────────────────────────────────────────────────

type HandleDef = { id: string; label: string; className: string };

const BASE_HANDLES: HandleDef[] = [
  { id: "prompt", label: "Text prompt", className: "node-handle-icon node-handle-icon-prompt" },
  { id: "startFrame", label: "Start frame", className: "node-handle-icon node-handle-icon-image" },
  { id: "endFrame", label: "End frame", className: "node-handle-icon node-handle-icon-image" },
  { id: "resource", label: "Reference images (up to 3)", className: "node-handle-icon node-handle-icon-resource" },
  { id: "videoRef", label: "Reference video", className: "node-handle-icon node-handle-icon-videoref" },
  { id: "referenceVideo", label: "Reference videos (up to 3)", className: "node-handle-icon node-handle-icon-refvideo" },
  { id: "audioRef", label: "Reference audios (up to 3)", className: "node-handle-icon node-handle-icon-audioref" },
];

// Fixed order for bottom-anchored stacking (top-most first, bottom-most last)
const HANDLE_ORDER = ["prompt", "startFrame", "endFrame", "resource", "videoRef", "referenceVideo", "audioRef"];

// Which handle IDs are connectable for each dragged output type
const CONNECTABLE_FOR_TYPE: Record<string, Set<string>> = {
  prompt: new Set(["prompt"]),
  image: new Set(["startFrame", "endFrame", "resource"]),
  video: new Set(["videoRef", "referenceVideo"]),
  audio: new Set(["audioRef"]),
};
const HANDLE_SPACING = 38; // px between handles

const HANDLE_COLORS: Record<string, string> = {
  prompt: "#2DD4BF",
  startFrame: "#2DD4BF",
  endFrame: "#2DD4BF",
  resource: "#fb923c",
  videoRef: "#22d3ee",
  referenceVideo: "#38bdf8",
  audioRef: "#5EEAD4",
};

const SOURCE_HANDLE_COLORS: Record<string, string> = {
  image: "#2DD4BF",
  video: "#22d3ee",
  audio: "#5EEAD4",
};

const SOURCE_HANDLES = [
  { id: "startFrameOut", type: "image", label: "Start frame", icon: <SrcFrameStartIcon /> },
  { id: "endFrameOut", type: "image", label: "End frame", icon: <SrcFrameEndIcon /> },
  { id: "imagePickOut", type: "image", label: "Image pick", icon: <SrcImagePickIcon /> },
  { id: "videoRefOut", type: "video", label: "Reference video", icon: <SrcVideoIcon /> },
  { id: "audioRefOut", type: "audio", label: "Reference audio", icon: <SrcAudioIcon /> },
] as const;
const SOURCE_HANDLE_SPACING = 32; // px between source handles
// Fixed slot offset from the node's vertical center — keeps the whole stack centered
// while every handle keeps its own slot, so edges don't jump when frame handles hide.
const sourceHandleCenterOffset = (i: number) => (i - (SOURCE_HANDLES.length - 1) / 2) * SOURCE_HANDLE_SPACING;

const STATUS_DOT: Record<string, string> = {
  idle: "bg-[#1E1E1E]",
  running: "bg-amber-400 animate-pulse",
  done: "bg-[#34d399]",
  error: "bg-red-500",
};

// ── @mention → <<<image N>>> replacement (same logic as GenerateNode) ─────────

function resolveMentions(
  prompt: string,
  labels: string[],
  imageUrls: string[],
  tagFormat: "default" | "grok" = "default",
): { resolvedPrompt: string; orderedUrls: string[] } {
  if (!labels.length) return { resolvedPrompt: prompt, orderedUrls: imageUrls };

  type Span = { start: number; end: number; labelIdx: number | null };
  const spans: Span[] = [];
  const claimed = new Set<number>();

  const sortedLabels = labels
    .map((label, i) => ({ label, i }))
    .filter(({ label }) => !!label)
    .sort((a, b) => b.label.length - a.label.length);

  for (const { label, i } of sortedLabels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`@${escaped}`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(prompt)) !== null) {
      if (!claimed.has(m.index)) {
        spans.push({ start: m.index, end: m.index + m[0].length, labelIdx: i });
        claimed.add(m.index);
      }
    }
  }

  const fallback = /@\S+(?:\s+#\d+)?/g;
  let fm: RegExpExecArray | null;
  while ((fm = fallback.exec(prompt)) !== null) {
    if (!claimed.has(fm.index)) {
      spans.push({ start: fm.index, end: fm.index + fm[0].length, labelIdx: null });
      claimed.add(fm.index);
    }
  }

  spans.sort((a, b) => a.start - b.start);
  if (spans.length === 0) return { resolvedPrompt: prompt, orderedUrls: imageUrls };

  const spanUrls: (string | null)[] = [];
  const usedIdxs = new Set<number>();

  for (const span of spans) {
    let url: string | null = null;
    if (span.labelIdx !== null && !usedIdxs.has(span.labelIdx) && imageUrls[span.labelIdx]) {
      url = imageUrls[span.labelIdx];
      usedIdxs.add(span.labelIdx);
    } else {
      const next = imageUrls.findIndex((_, j) => !usedIdxs.has(j));
      if (next !== -1) { url = imageUrls[next]; usedIdxs.add(next); }
      // No fallback to imageUrls[0] — unresolvable @mentions stay as plain text
    }
    spanUrls.push(url);
  }

  const orderedUrls = spanUrls.filter((u): u is string => u !== null);

  let resolvedPrompt = "";
  let lastEnd = 0;
  let imageNum = 1;
  for (let i = 0; i < spans.length; i++) {
    resolvedPrompt += prompt.slice(lastEnd, spans[i].start);
    if (spanUrls[i] !== null) {
      resolvedPrompt += tagFormat === "grok" ? `@image${imageNum++} ` : `<<<image ${imageNum++}>>>`;
    } else {
      resolvedPrompt += prompt.slice(spans[i].start, spans[i].end);
    }
    lastEnd = spans[i].end;
  }
  resolvedPrompt += prompt.slice(lastEnd);

  return { resolvedPrompt, orderedUrls };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function VideoGeneratorNode({ id, data, selected }: NodeProps<VideoGeneratorNodeType>) {
  const readOnly = useReadOnly();
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const updateNodeSize = useWorkflowStore((s) => s.updateNodeSize);
  const killEdgesForHandles = useWorkflowStore((s) => s.killEdgesForHandles);
  const remapTargetHandle = useWorkflowStore((s) => s.remapTargetHandle);
  const flashEdgeError = useWorkflowStore((s) => s.flashEdgeError);
  const addToast = useWorkflowStore((s) => s.addToast);
  // Subscribed purely for re-render invalidation — isModelReady /
  // availableProvidersForModel read these from the store imperatively at
  // render time (lib/providers.ts).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const modelProviders = useWorkflowStore((s) => s.modelProviders);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const providerStatus = useWorkflowStore((s) => s.providerStatus);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const bindingsByModel = useWorkflowStore((s) => s.bindingsByModel);
  // Visibility toggles (declutter) — hidden models/providers are not offered
  // in the pickers and are never picked as a default.
  const disabledModels = useWorkflowStore((s) => s.disabledModels);
  const disabledProviders = useWorkflowStore((s) => s.disabledProviders);
  const onNodesChange = useWorkflowStore((s) => s.onNodesChange);
  const onEdgesChange = useWorkflowStore((s) => s.onEdgesChange);
  const addNode = useWorkflowStore((s) => s.addNode);
  const insertEdge = useWorkflowStore((s) => s.insertEdge);
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const debugMode = useWorkflowStore((s) => s.debugMode);
  const connectingHandleType = useWorkflowStore((s) => s.connectingHandleType);
  const parentGroupSelected = useWorkflowStore((s) => {
    const self = s.nodes.find((n) => n.id === id);
    if (!self?.parentId) return false;
    return s.nodes.find((n) => n.id === self.parentId)?.selected ?? false;
  });
  const multiSelected = useWorkflowStore((s) => s.nodes.filter((n) => n.selected).length > 1);

  const updateNodeInternals = useUpdateNodeInternals();
  const cardRef = useRef<HTMLDivElement>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Instant hide on deselect — no delay when clicking outside the node
  const prevSelectedRef = useRef(selected);
  useEffect(() => {
    const was = prevSelectedRef.current;
    prevSelectedRef.current = selected;
    if (was && !selected && cardRef.current) {
      const el = cardRef.current;
      el.classList.add("handles-no-delay");
      const t = setTimeout(() => el.classList.remove("handles-no-delay"), 200);
      return () => { clearTimeout(t); el.classList.remove("handles-no-delay"); };
    }
  }, [selected]);

  const [loading, setLoading] = useState(false);
  const [genCount, setGenCount] = useState(1);
  const [logOpen, setLogOpen] = useState(false);
  const [hoveredHand, setHoveredHand] = useState<string | null>(null);
  const [hoveredSourceHandle, setHoveredSourceHandle] = useState<string | null>(null);
  const [errorHandles, setErrorHandles] = useState<Set<string>>(new Set());
  const [modelOpen, setModelOpen] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const [ratioOpen, setRatioOpen] = useState(false);
  const [durOpen, setDurOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [grokResOpen, setGrokResOpen] = useState(false);
  const muted = useWorkflowStore((s) => s.globalMuted);
  const setGlobalMuted = useWorkflowStore((s) => s.setGlobalMuted);
  const [hovering, setHovering] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentSec, setCurrentSec] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxVisible, setLightboxVisible] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [scrubPos, setScrubPos] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [captureErr, setCaptureErr] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"video" | "frame">("video");
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoRefs = useRef<Map<number, HTMLVideoElement>>(new Map());
  const durLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controlBarRef = useRef<HTMLDivElement>(null);

  // ── Elevate the RF node z-index while any dropdown is open ──────────────────
  useEffect(() => {
    const rfNode = cardRef.current?.closest<HTMLElement>(".react-flow__node");
    if (!rfNode) return;
    const anyOpen = modelOpen || providerOpen || ratioOpen || durOpen || modeOpen || grokResOpen;
    if (anyOpen) {
      rfNode.style.zIndex = "10000";
    } else {
      rfNode.style.zIndex = "";
    }
    return () => { rfNode.style.zIndex = ""; };
  }, [modelOpen, providerOpen, ratioOpen, durOpen, modeOpen, grokResOpen]);

  useEffect(() => {
    const anyOpen = modelOpen || providerOpen || ratioOpen || durOpen || modeOpen || grokResOpen;
    if (!anyOpen) return;
    const handler = (e: MouseEvent) => {
      if (controlBarRef.current && !controlBarRef.current.contains(e.target as unknown as globalThis.Node)) {
        setModelOpen(false); setProviderOpen(false); setRatioOpen(false); setDurOpen(false);
        setModeOpen(false); setGrokResOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [modelOpen, providerOpen, ratioOpen, durOpen, modeOpen, grokResOpen]);

  const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  // ── Lightbox ──────────────────────────────────────────────────────────────
  const openLightbox = useCallback(() => {
    if (!(data.videoUrl as string | undefined)) return;
    setLightboxOpen(true);
    requestAnimationFrame(() => setLightboxVisible(true));
  }, [data.videoUrl]);

  const closeLightbox = useCallback(() => {
    setLightboxVisible(false);
    setTimeout(() => setLightboxOpen(false), 220);
  }, []);

  useEffect(() => {
    if (!lightboxOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") closeLightbox(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [lightboxOpen, closeLightbox]);

  // ── Toolbar actions ───────────────────────────────────────────────────────
  const handleDelete = useCallback(() => {
    onNodesChange([{ type: "remove", id }]);
  }, [id, onNodesChange]);

  const handleDuplicate = useCallback(() => {
    const state = useWorkflowStore.getState();
    const src = state.nodes.find((n) => n.id === id);
    if (!src) return;
    const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    onNodesChange([{ type: "select", id, selected: false }]);
    addNode({
      ...src,
      id: newId,
      position: { x: src.position.x + 20, y: src.position.y + 20 },
      selected: true,
      data: { ...src.data, status: "idle" as const, taskId: undefined, lastTaskId: undefined, hasError: false },
    });
    state.edges
      .filter((e) => (e.source === id || e.target === id) && e.deletable !== false)
      .forEach((e) => insertEdge({
        ...e,
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        source: e.source === id ? newId : e.source,
        target: e.target === id ? newId : e.target,
      }));
  }, [id, addNode, insertEdge, onNodesChange]);

  const handleSave = useCallback(async () => {
    const url = data.videoUrl as string | undefined;
    if (!url || isSaving) return;
    const filename = `video-${Date.now()}.mp4`;
    setIsSaving(true);
    try {
      const resp = await fetch(`/api/download?url=${encodeURIComponent(url)}&filename=${filename}`);
      const blob = await resp.blob();
      const obj = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = obj; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(obj);
    } finally {
      setIsSaving(false);
    }
  }, [data.videoUrl, isSaving]);

  const deleteGen = useCallback((idx: number) => {
    const storeNode = useWorkflowStore.getState().nodes.find((n) => n.id === id);
    const gens = [...((storeNode?.data?.generations as GenEntry[] | undefined) ?? [])] as GenEntry[];
    const meta = [...((storeNode?.data?.generationsMeta as (GenMeta | null)[] | undefined) ?? [])];
    const cur = (storeNode?.data?.currentGenIdx as number | undefined) ?? Math.max(0, gens.length - 1);
    gens.splice(idx, 1);
    meta.splice(idx, 1);
    if (gens.length === 0) {
      updateNodeData(id, { generations: [], generationsMeta: [], currentGenIdx: 0, videoUrl: undefined, status: "idle", errorMsg: undefined });
      return;
    }
    const newIdx = Math.max(0, Math.min(gens.length - 1, idx <= cur ? cur - 1 : cur));
    const entry = gens[newIdx];
    updateNodeData(id, {
      generations: gens,
      generationsMeta: meta,
      currentGenIdx: newIdx,
      videoUrl: typeof entry === "string" ? entry : undefined,
      status: typeof entry === "string" ? "done" : typeof entry === "object" && entry !== null ? "error" : "idle",
      errorMsg: typeof entry === "object" && entry !== null ? (entry as { error: string }).error : undefined,
    });
  }, [id, updateNodeData]);

  const handleCancel = useCallback(() => {
    if (pendingTimerRef.current !== null) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    setLoading(false);
    const storeNode = useWorkflowStore.getState().nodes.find((n) => n.id === id);
    const rawGens = (storeNode?.data?.generations as GenEntry[] | undefined) ?? [];
    const rawMeta = (storeNode?.data?.generationsMeta as (GenMeta | null)[] | undefined) ?? [];
    const gens = rawGens.filter((g): g is string | { error: string } => g !== null);
    const meta = rawMeta.filter((_, i) => rawGens[i] !== null);
    const newIdx = Math.max(0, gens.length - 1);
    const lastEntry = gens[newIdx];
    updateNodeData(id, {
      status: gens.length > 0 ? "done" : "idle",
      taskId: undefined,
      generations: gens,
      generationsMeta: meta,
      currentGenIdx: newIdx,
      videoUrl: typeof lastEntry === "string" ? lastEntry : undefined,
      errorMsg: undefined,
    });
  }, [id, updateNodeData]);

  // ── Data ──────────────────────────────────────────────────────────────────
  // The model's fallback default skips hidden models (declutter).
  const videoModelId = (data.videoModel as string) ?? defaultModelId(VIDEO_MODEL_CFG, "kling-3.0", disabledModels);
  const cfg = VIDEO_MODEL_CFG.find((m) => m.id === videoModelId) ?? VIDEO_MODEL_CFG[0];
  // The models offered in the picker — hidden ones are not selectable.
  const visibleVideoModels = useMemo(
    () => VIDEO_MODEL_CFG.filter((m) => isModelEnabled(m.id, disabledModels)),
    [disabledModels],
  );

  // P5: active provider for this video model (most video models are Kie-only;
  // the pill renders only when the model's binding union has ≥2 entries).
  // Derived from the store at render (modelProviders subscribed above drives
  // re-render on pref change).
  const currentProvider = getModelProvider(videoModelId);
  /** The backends offered for this model (the current one stays visible). */
  const providerChoices = useMemo(
    () => enabledProvidersForModel(videoModelId, disabledProviders, currentProvider),
    [videoModelId, disabledProviders, currentProvider],
  );
  // Design §3.4 readiness: hydrated store decides; pre-hydration passes.
  const modelReady = isModelReady(videoModelId, currentProvider);

  const mode = (data.klingMode as string) ?? cfg.defaultMode ?? "";
  const resolution = (data.grokResolution as string) ?? cfg.defaultResolution ?? "";
  const duration = (data.duration as number) ?? cfg.defaultDuration;
  const aspectRatio = (data.aspectRatio as string) ?? cfg.defaultRatio;
  const sound = (data.sound as boolean) ?? false;
  const seed = (data.seed as number | undefined) ?? 0;
  const status = (data.status as string) ?? "idle";
  const prompt = (data.prompt as string) ?? "";
  const isVeo = videoModelId === "veo3" || videoModelId === "veo3_fast" || videoModelId === "veo3_lite";
  const veoMode = (data.veoMode as "frames" | "references" | undefined) ?? "frames";
  const isPending = status === "pending";
  const animBusy = loading || status === "running";
  const busy = animBusy || isPending;
  const isQueued = !busy && !!data.pipelineQueued;
  // The job the run log shows: the live task while it runs, the last one
  // after it settled (`lastTaskId` outlives `taskId`, which is cleared on
  // settle). Read-only — it never touches the node's status machine.
  const logTaskId = (data.taskId as string | undefined) ?? (data.lastTaskId as string | undefined);
  useGeneratingBorderAnimation(cardRef, animBusy);
  const videoUrl = data.videoUrl as string | undefined;
  const capturedFrameUrl = data.capturedFrameUrl as string | undefined;
  const eagerStartFrameUrl = data.eagerStartFrameUrl as string | undefined;
  const eagerEndFrameUrl = data.eagerEndFrameUrl as string | undefined;

  // displayFrameUrl is computed after connectedFrameOutHandles is defined (see below).

  const promptOverLimit = (() => {
    const promptEdge = edges.find((e) => e.target === id && e.targetHandle === "prompt");
    if (!promptEdge) return false;
    const promptNode = nodes.find((n) => n.id === promptEdge.source);
    const text = (promptNode?.data?.prompt as string) ?? "";
    const limit = cfg.apiInput.promptMaxLength ?? Infinity;
    return text.length > limit;
  })();

  // ── Generation history ────────────────────────────────────────────────────
  type GenEntry = string | null | { error: string };
  type GenMeta = { videoModel: string; aspectRatio: string; duration: number; klingMode: string; grokResolution: string; sound: boolean };

  const generations: GenEntry[] = Array.isArray(data.generations)
    ? (data.generations as GenEntry[])
    : (videoUrl ? [videoUrl] : []);
  const generationsMeta: (GenMeta | null)[] = Array.isArray(data.generationsMeta)
    ? (data.generationsMeta as (GenMeta | null)[])
    : [];
  const currentGenIdx = Math.min((data.currentGenIdx as number | undefined) ?? Math.max(0, generations.length - 1), Math.max(0, generations.length - 1));
  const generationsRef = useRef(generations);
  generationsRef.current = generations;

  const goToGen = useCallback((idx: number) => {
    const gens = generationsRef.current;
    const clamped = Math.max(0, Math.min(gens.length - 1, idx));
    const entry = gens[clamped];
    // Restore the settings used for this generation slot
    const meta = (useWorkflowStore.getState().nodes.find((n) => n.id === id)?.data?.generationsMeta as (GenMeta | null)[] | undefined)?.[clamped];
    const metaUpdate = meta ? {
      videoModel: meta.videoModel,
      aspectRatio: meta.aspectRatio,
      duration: meta.duration,
      klingMode: meta.klingMode,
      grokResolution: meta.grokResolution,
      sound: meta.sound,
    } : {};
    if (entry === null) {
      updateNodeData(id, { currentGenIdx: clamped, videoUrl: undefined, status: "running", errorMsg: undefined, ...metaUpdate });
    } else if (typeof entry === "object") {
      updateNodeData(id, { currentGenIdx: clamped, videoUrl: undefined, status: "error", errorMsg: entry.error, ...metaUpdate });
    } else {
      updateNodeData(id, { currentGenIdx: clamped, videoUrl: entry, status: "done", errorMsg: undefined, ...metaUpdate });
    }
  }, [id, updateNodeData]);

  // Play current, pause all others
  useEffect(() => {
    videoRefs.current.forEach((v, i) => {
      if (i === currentGenIdx) v.play().catch(() => { });
      else v.pause();
    });
  }, [currentGenIdx]);

  const handleVideoMeta = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    if (!v.videoWidth || !v.videoHeight) return;
    updateNodeData(id, { imageNaturalRatio: `${v.videoWidth} / ${v.videoHeight}` });
    // Sizing is handled by the useEffect below once the DOM reflects the new state
  };

  // Persistent ResizeObserver — fires throughout CSS transitions so group
  // expansion in the store always gets the final measured dimensions.
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      updateNodeSize(id, el.offsetWidth, el.offsetHeight);
      updateNodeInternals(id);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [id, updateNodeSize, updateNodeInternals]);

  // When the model changes the active handle set and their CSS positions change.
  // React Flow needs updateNodeInternals after the DOM has repainted with the new layout.
  useEffect(() => {
    const raf = requestAnimationFrame(() => updateNodeInternals(id));
    return () => cancelAnimationFrame(raf);
  }, [id, videoModelId, veoMode, updateNodeInternals]);

  // ── Wait for job completion via SSE (callback-driven, no polling) ─────────
  useEffect(() => {
    const taskId = data.taskId as string | undefined;
    if (!taskId || status !== "running") return;

    const es = new EventSource(`/api/job-stream?taskId=${taskId}`);

    es.onmessage = (event) => {
      es.close();
      let json: { status: string; videoUrl?: string; error?: string };
      try { json = JSON.parse(event.data); } catch { return; }

      const storeNode = useWorkflowStore.getState().nodes.find((n) => n.id === id);
      const gens = [...((storeNode?.data?.generations as GenEntry[] | undefined) ?? [])] as GenEntry[];
      const slot = (storeNode?.data?.currentGenIdx as number | undefined) ?? gens.length - 1;

      if (json.status === "done" && json.videoUrl) {
        gens[slot] = json.videoUrl;
        updateNodeData(id, { status: "done", videoUrl: json.videoUrl, taskId: undefined, generations: gens, currentGenIdx: slot });
      } else {
        const errMsg = json.error ?? "Generation failed";
        gens[slot] = { error: errMsg };
        updateNodeData(id, { status: "error", errorMsg: errMsg, taskId: undefined, generations: gens, currentGenIdx: slot });
      }
    };

    es.onerror = () => es.close();

    return () => es.close();
  }, [data.taskId, status, id, updateNodeData]);

  const activeHandles = new Set<string>(cfg.handles);

  if (isVeo) {
    if (veoMode === "frames") {
      activeHandles.delete("resource");
    } else if (veoMode === "references") {
      activeHandles.delete("startFrame");
      activeHandles.delete("endFrame");
    }
  }

  const connectedHandles = new Set(
    edges.filter((e) => e.target === id).map((e) => e.targetHandle).filter(Boolean) as string[]
  );

  const MEDIA_INPUT_HANDLES = new Set(["startFrame", "endFrame", "resource", "videoRef", "referenceVideo", "audioRef"]);
  const hasFailedMediaInput = edges.some(
    (e) => e.target === id && MEDIA_INPUT_HANDLES.has(e.targetHandle ?? "") &&
      (nodes.find((n) => n.id === e.source)?.data?.status as string | undefined) === "error"
  );

  // HappyHorse: startFrame and resource are mutually exclusive — hide the other once one is connected
  if (cfg.id === "happyhorse") {
    if (connectedHandles.has("startFrame")) activeHandles.delete("resource");
    if (connectedHandles.has("resource")) activeHandles.delete("startFrame");
  }

  // Seedance / MiniMax H3: first/last frames and multimodal references are mutually exclusive scenarios
  if (cfg.id === "seedance-2-fast" || cfg.id === "minimax-h3") {
    const hasFrame = connectedHandles.has("startFrame") || connectedHandles.has("endFrame");
    const hasRef = connectedHandles.has("resource") || connectedHandles.has("referenceVideo") || connectedHandles.has("audioRef");
    if (hasFrame) {
      activeHandles.delete("resource");
      activeHandles.delete("referenceVideo");
      activeHandles.delete("audioRef");
    }
    if (hasRef) {
      activeHandles.delete("startFrame");
      activeHandles.delete("endFrame");
    }
  }

  // When the mutual-exclusion above shifts handle positions, edges stay anchored to stale
  // coords until React Flow re-measures. Re-measure after the DOM repaints.
  const hhConnKey = `${connectedHandles.has("startFrame") ? 1 : 0}${connectedHandles.has("endFrame") ? 1 : 0}${connectedHandles.has("resource") ? 1 : 0}${connectedHandles.has("referenceVideo") ? 1 : 0}${connectedHandles.has("audioRef") ? 1 : 0}`;
  useEffect(() => {
    const raf = requestAnimationFrame(() => updateNodeInternals(id));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, hhConnKey, updateNodeInternals]);

  // Once a generation has completed, an already-connected input can't be silently
  // swapped by dragging a new edge onto it (must disconnect first) — but every handle
  // stays visible so a freshly emptied (or never-used) slot can always accept a new
  // connection. Hiding unconnected handles post-generation used to strand them
  // permanently (compounded by page reloads, which drop any in-memory "was connected"
  // state), so visibility no longer depends on generation history at all.
  const hasGeneration = generations.some((g) => typeof g === "string" && !!g && !g.startsWith("blob:"));

  // Compute center-anchored positions — active handles stack together, centered on the
  // node's vertical middle, with no gaps.
  const activeInOrder = HANDLE_ORDER.filter((hid) => activeHandles.has(hid));
  const N = activeInOrder.length;
  const handleCenterOffsetMap = new Map(
    activeInOrder.map((hid, idx) => [hid, (idx - (N - 1) / 2) * HANDLE_SPACING])
  );

  // Apply model-specific label/class overrides.
  const handles = BASE_HANDLES.map((h) => {
    let label = h.label;
    let className = h.className;
    if (h.id === "resource" && cfg.maxResources)
      label = cfg.id === "happyhorse"
        ? `Characters (up to ${cfg.maxResources})`
        : `Reference images (up to ${cfg.maxResources})`;
    if (h.id === "referenceVideo" && cfg.maxReferenceVideos)
      label = `Reference videos (up to ${cfg.maxReferenceVideos})`;
    if (h.id === "audioRef" && cfg.maxReferenceAudios)
      label = `Reference audios (up to ${cfg.maxReferenceAudios})`;
    if (h.id === "startFrame" && cfg.apiInput.useMotionControl) {
      label = "Character";
      className = "node-handle-icon node-handle-icon-character";
    }
    return { ...h, label, className };
  });
  const ratios = cfg.ratios;
  const durations = cfg.durations;

  const closeAll = () => {
    setModelOpen(false); setRatioOpen(false); setDurOpen(false);
    setModeOpen(false); setGrokResOpen(false);
    setLogOpen(false);
    setHovering(false);
  };

  // Auto-open picker when connected to a downstream image handle via imagePickOut
  const IMAGE_HANDLES = new Set(["startFrame", "endFrame", "resource", "image"]);
  const imagePickEdges = edges.filter(
    (e) => e.source === id &&
      (IMAGE_HANDLES.has(e.targetHandle as string) || !e.targetHandle) &&
      e.sourceHandle === "imagePickOut"
  );
  const imagePickEdgeCount = imagePickEdges.length;
  const prevEdgeCountRef = useRef(imagePickEdgeCount);
  const lastEdgeIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (imagePickEdgeCount > prevEdgeCountRef.current) {
      const v = videoRef.current;
      if (v) { v.pause(); setScrubPos(v.currentTime / (v.duration || 1)); }
      setPickerOpen(true);
      // Track the ID of the edge that just triggered the picker
      lastEdgeIdRef.current = imagePickEdges[imagePickEdges.length - 1]?.id ?? null;
    }
    prevEdgeCountRef.current = imagePickEdgeCount;
  }, [imagePickEdgeCount, imagePickEdges]);

  useEffect(() => {
    if (!imagePickEdgeCount) {
      setPickerOpen(false);
      setViewMode("video");
    }
  }, [imagePickEdgeCount]);

  // Derive extracting state from any connected source node that is currently extracting
  const frameSourceNodeIds = new Set(
    edges
      .filter((e) => e.target === id && (e.targetHandle === "startFrame" || e.targetHandle === "endFrame"))
      .map((e) => e.source)
  );
  const isExtractingFrames = nodes.some(
    (n) => frameSourceNodeIds.has(n.id) && !!(n.data.extractingFrame as boolean | undefined)
  );

  // ── Mutual exclusivity + eager extraction for this node's output frame handles ─
  const FRAME_OUT_IDS = new Set(["startFrameOut", "endFrameOut", "imagePickOut"]);
  const connectedFrameOutHandles = new Set(
    edges.filter((e) => e.source === id && FRAME_OUT_IDS.has(e.sourceHandle ?? "")).map((e) => e.sourceHandle!)
  );
  const visibleSourceHandles = SOURCE_HANDLES.filter(
    (h) => !FRAME_OUT_IDS.has(h.id) || connectedFrameOutHandles.size === 0 || connectedFrameOutHandles.has(h.id)
  );

  const eagerFrameUrl = connectedFrameOutHandles.has("endFrameOut")
    ? eagerEndFrameUrl
    : connectedFrameOutHandles.has("startFrameOut")
    ? eagerStartFrameUrl
    : (eagerEndFrameUrl ?? eagerStartFrameUrl);
  const displayFrameUrl = connectedFrameOutHandles.has("imagePickOut")
    ? capturedFrameUrl
    : connectedFrameOutHandles.has("endFrameOut")
    ? eagerEndFrameUrl
    : connectedFrameOutHandles.has("startFrameOut")
    ? eagerStartFrameUrl
    : (capturedFrameUrl ?? eagerEndFrameUrl ?? eagerStartFrameUrl);

  // Current generated video URL (first non-null, non-error generation)
  const currentGenUrl = (() => {
    const genEntry = generations[currentGenIdx];
    if (typeof genEntry === "string" && genEntry && !genEntry.startsWith("blob:")) return genEntry;
    return typeof videoUrl === "string" && videoUrl && !videoUrl.startsWith("blob:") ? videoUrl : undefined;
  })();

  // Determine which temporal frames need extracting — source handle decides.
  const outFrameEdges = edges.filter((e) => e.source === id && (e.sourceHandle === "startFrameOut" || e.sourceHandle === "endFrameOut"));
  const needsStartFrame = outFrameEdges.some((e) => e.sourceHandle === "startFrameOut");
  const needsEndFrame   = outFrameEdges.some((e) => e.sourceHandle === "endFrameOut");
  const sfVGKey = needsStartFrame && currentGenUrl ? `sf:${currentGenUrl}` : "";
  const efVGKey = needsEndFrame && currentGenUrl ? `ef:${currentGenUrl}` : "";
  const prevSfVGKeyRef = useRef("");
  const prevEfVGKeyRef = useRef("");
  const activeVGExtRef = useRef(0);

  const runVGExtract = useCallback(async (isLastFrame: boolean, url: string) => {
    activeVGExtRef.current++;
    updateNodeData(id, { extractingFrame: true });
    addToast("Extracting frame…", "info");
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const body = isLastFrame ? { videoUrl: url, lastFrame: true } : { videoUrl: url, timeSeconds: 0 };
      const r = await fetch("/api/extract-frame", { method: "POST", headers, body: JSON.stringify(body) });
      const j = await r.json();
      if (j.cdnUrl) {
        updateNodeData(id, { [isLastFrame ? "eagerEndFrameUrl" : "eagerStartFrameUrl"]: j.cdnUrl });
        addToast("Frame extracted.", "success");
      }
    } catch { /* silent */ } finally {
      activeVGExtRef.current--;
      if (activeVGExtRef.current === 0) updateNodeData(id, { extractingFrame: false });
    }
  }, [id, updateNodeData, addToast]);

  useEffect(() => {
    if (!sfVGKey) {
      if (prevSfVGKeyRef.current) { prevSfVGKeyRef.current = ""; updateNodeData(id, { eagerStartFrameUrl: undefined }); }
      return;
    }
    if (prevSfVGKeyRef.current === sfVGKey) return;
    prevSfVGKeyRef.current = sfVGKey;
    updateNodeData(id, { eagerStartFrameUrl: undefined });
    runVGExtract(false, currentGenUrl!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sfVGKey]);

  useEffect(() => {
    if (!efVGKey) {
      if (prevEfVGKeyRef.current) { prevEfVGKeyRef.current = ""; updateNodeData(id, { eagerEndFrameUrl: undefined }); }
      return;
    }
    if (prevEfVGKeyRef.current === efVGKey) return;
    prevEfVGKeyRef.current = efVGKey;
    updateNodeData(id, { eagerEndFrameUrl: undefined });
    runVGExtract(true, currentGenUrl!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [efVGKey]);

  const openPicker = useCallback(() => {
    const v = videoRef.current;
    if (v) {
      v.pause();
      setScrubPos(v.currentTime / (v.duration || 1));
    }
    setPickerOpen(true);
  }, []);

  const captureFrame = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    setCaptureErr(null);
    setCapturing(true);
    updateNodeData(id, { extractingFrame: true });
    try {
      const seekTime = v.currentTime;
      const srcUrl = v.src;
      if (!srcUrl) throw new Error("No video source");

      const extractHeaders: Record<string, string> = { "Content-Type": "application/json" };
      const res = await fetch("/api/extract-frame", {
        method: "POST",
        headers: extractHeaders,
        body: JSON.stringify({ videoUrl: srcUrl, timeSeconds: seekTime }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Extraction failed");

      if (j.cdnUrl) {
        updateNodeData(id, { capturedFrameUrl: j.cdnUrl });
        setViewMode("frame");
        // Also update any connected ImageInputNodes
        const pickEdges = edges.filter((e) => e.source === id && e.sourceHandle === "imagePickOut");
        for (const pe of pickEdges) {
          const tgt = nodes.find((n) => n.id === pe.target);
          if (tgt?.type === "imageInputNode") {
            updateNodeData(tgt.id, { r2Url: j.cdnUrl, inputImage: j.cdnUrl });
          }
        }
      }
      setPickerOpen(false);
    } catch (e: any) {
      setCaptureErr(e.message || "Failed to capture frame");
    } finally {
      setCapturing(false);
      updateNodeData(id, { extractingFrame: false });
    }
  }, [id, updateNodeData, edges, nodes]);

  const textEdge = edges.find((e) => e.target === id && e.targetHandle === "prompt");
  const textNode = textEdge ? nodes.find((n) => n.id === textEdge.source) : undefined;
  const hasResource = edges.some((e) => e.target === id && e.targetHandle === "resource");

  // ── Generate ──────────────────────────────────────────────────────────────
  const generate = useCallback(async () => {
    const accessToken = "guest";

    const upstream = resolveInputs(id, nodes as Node<NodeData>[], edges);
    const maxRes = cfg.maxResources ?? 3;
    const maxRefVideos = cfg.maxReferenceVideos ?? 3;
    const maxRefAudios = cfg.maxReferenceAudios ?? 3;
    const limitedResources = upstream.resources.slice(0, maxRes);
    const { resolvedPrompt, orderedUrls } = resolveMentions(
      upstream.prompt ?? prompt,
      limitedResources.map((r) => r.label),
      limitedResources.map((r) => r.url),
      cfg.resourceTagFormat ?? "default",
    );
    const finalPrompt = resolvedPrompt;
    const orderedResources = orderedUrls.map(
      (url) => limitedResources.find((r) => r.url === url) ?? { url, label: "element" }
    );

    const requiredHandleHasContent = (handle: string): boolean => {
      if (handle === "prompt") return Boolean(finalPrompt.trim());
      if (handle === "startFrame") return Boolean(upstream.startFrameUrl);
      if (handle === "endFrame") return Boolean(upstream.endFrameUrl);
      if (handle === "resource") return orderedResources.length > 0;
      if (handle === "videoRef") return Boolean(upstream.videoRefUrl);
      if (handle === "referenceVideo") return upstream.referenceVideoUrls.length > 0;
      if (handle === "audioRef") return upstream.referenceAudioUrls.length > 0;
      return true;
    };
    const missingRequiredHandles = (cfg.requiredHandles ?? []).filter(
      (handle) => !requiredHandleHasContent(handle)
    );
    if (missingRequiredHandles.length > 0) {
      setErrorHandles(new Set(missingRequiredHandles));
      setTimeout(() => setErrorHandles(new Set()), 1400);
      updateNodeData(id, { hasError: true });
      addToast("Connect all required inputs for this model.", "error");
      return;
    }

    if (!cfg.promptOptional && !finalPrompt.trim()) {
      setErrorHandles(new Set(["prompt"]));
      setTimeout(() => setErrorHandles(new Set()), 1400);
      updateNodeData(id, { hasError: true });
      addToast("A prompt is required to generate a video.", "error");
      if (textEdge) {
        updateNodeData(textEdge.source, { hasError: true });
        flashEdgeError(textEdge.id);
      }
      return;
    }

    // ── Motion-control: validate mandatory image + video handles ──────────────
    if (cfg.apiInput.useMotionControl) {
      const imageEdge = edges.find((e) => e.target === id && e.targetHandle === "startFrame");
      const videoEdge = edges.find((e) => e.target === id && e.targetHandle === "videoRef");

      const flashSet = new Set<string>();
      let hasError = false;

      // startFrame: not connected → flash handle; connected but empty → flash handle + edge + source node
      if (!imageEdge) {
        flashSet.add("startFrame");
        hasError = true;
      } else if (!upstream.startFrameUrl) {
        flashSet.add("startFrame");
        const srcNode = nodes.find((n) => n.id === imageEdge.source);
        if (srcNode) updateNodeData(srcNode.id, { hasError: true });
        flashEdgeError(imageEdge.id);
        hasError = true;
      }

      // videoRef: not connected → flash handle; connected but empty → flash handle + edge + source node
      if (!videoEdge) {
        flashSet.add("videoRef");
        hasError = true;
      } else if (!upstream.videoRefUrl) {
        flashSet.add("videoRef");
        const srcNode = nodes.find((n) => n.id === videoEdge.source);
        if (srcNode) updateNodeData(srcNode.id, { hasError: true });
        flashEdgeError(videoEdge.id);
        hasError = true;
      }

      if (flashSet.size > 0) {
        setErrorHandles(flashSet);
        setTimeout(() => setErrorHandles(new Set()), 1400);
      }
      if (hasError) {
        updateNodeData(id, { hasError: true });
        addToast("Connect all required inputs for this model.", "error");
        return;
      }
    }

    // All models: any connected handle whose source has no content → block + blink.
    // Linked = required, regardless of whether the handle is optional when unlinked.
    {
      type HandleSpec = { handle: string; getUrl: (d: Record<string, unknown>) => string | undefined };
      const handleSpecs: HandleSpec[] = [
        { handle: "startFrame", getUrl: (d) => (d.eagerStartFrameUrl ?? d.eagerEndFrameUrl ?? d.capturedFrameUrl ?? d.r2Url ?? d.inputImage ?? d.imageUrl) as string | undefined },
        { handle: "endFrame", getUrl: (d) => (d.eagerEndFrameUrl ?? d.eagerStartFrameUrl ?? d.capturedFrameUrl ?? d.r2Url ?? d.inputImage ?? d.imageUrl) as string | undefined },
        { handle: "resource", getUrl: (d) => (d.capturedFrameUrl ?? d.r2Url ?? d.inputImage ?? d.imageUrl) as string | undefined },
        { handle: "videoRef", getUrl: (d) => (d.videoUrl) as string | undefined },
        { handle: "referenceVideo", getUrl: (d) => (d.videoUrl ?? d.r2Url) as string | undefined },
        { handle: "audioRef", getUrl: (d) => (d.audioUrl ?? d.r2Url) as string | undefined },
      ];

      const flashSet = new Set<string>();
      let hasEmpty = false;

      for (const { handle, getUrl } of handleSpecs) {
        const emptyEdges = edges
          .filter((e) => e.target === id && e.targetHandle === handle)
          .filter((e) => {
            const src = nodes.find((n) => n.id === e.source);
            return !src || !getUrl(src.data as Record<string, unknown>);
          });
        if (emptyEdges.length > 0) {
          flashSet.add(handle);
          for (const e of emptyEdges) {
            const src = nodes.find((n) => n.id === e.source);
            if (src) updateNodeData(src.id, { hasError: true });
            flashEdgeError(e.id);
          }
          hasEmpty = true;
        }
      }

      if (flashSet.size > 0) {
        setErrorHandles(flashSet);
        setTimeout(() => setErrorHandles(new Set()), 1400);
      }
      if (hasEmpty) {
        updateNodeData(id, { hasError: true });
        addToast("Some connected inputs have no content yet.", "error");
        return;
      }
    }

    // Trim videoRef if the source node has trim points applied
    let finalVideoRefUrl = upstream.videoRefUrl;
    if (finalVideoRefUrl) {
      const videoRefEdge = edges.find((e) => e.target === id && e.targetHandle === "videoRef");
      if (videoRefEdge) {
        const videoSrcNode = nodes.find((n) => n.id === videoRefEdge.source);
        const tStart = videoSrcNode?.data.trimStart as number | undefined;
        const tEnd = videoSrcNode?.data.trimEnd as number | undefined;
        if (tStart !== undefined && tEnd !== undefined) {
          try {
            const trimHeaders: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` };
            const trimRes = await fetch("/api/trim-video", {
              method: "POST",
              headers: trimHeaders,
              body: JSON.stringify({ videoUrl: finalVideoRefUrl, startTime: tStart, endTime: tEnd }),
            });
            if (trimRes.ok) {
              const trimJson = await trimRes.json();
              if (trimJson.cdnUrl) finalVideoRefUrl = trimJson.cdnUrl;
            }
          } catch {
            // trim failed — proceed with original URL
          }
        }
      }
    }

    // Extract first/last frames from VideoInputNode sources connected via startFrameOut/endFrameOut
    let finalStartFrameUrl = upstream.startFrameUrl;
    let finalEndFrameUrl = upstream.endFrameUrl;
    const frameHeaders: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` };

    // Fallback: if eager extraction didn't run (e.g. blob URL at connect time), extract now.
    // Frame type is determined by the SOURCE handle on A, not the target handle on B.
    const frameEdges = edges.filter(
      (e) => e.target === id &&
        (e.targetHandle === "startFrame" || e.targetHandle === "endFrame") &&
        (e.sourceHandle === "startFrameOut" || e.sourceHandle === "endFrameOut")
    );
    for (const fe of frameEdges) {
      const isLast = fe.sourceHandle === "endFrameOut";
      const targetSlotFilled = fe.targetHandle === "startFrame" ? !!finalStartFrameUrl : !!finalEndFrameUrl;
      if (targetSlotFilled) continue;
      const feSrc = nodes.find((n) => n.id === fe.source);
      if (feSrc?.type !== "videoInputNode") continue;
      const vUrl = feSrc.data.videoUrl as string | undefined;
      if (!vUrl || vUrl.startsWith("blob:")) continue;
      const tStart = feSrc.data.trimStart as number | undefined;
      const tEnd = feSrc.data.trimEnd as number | undefined;
      try {
        const body = isLast
          ? { videoUrl: vUrl, ...(tEnd !== undefined ? { timeSeconds: tEnd } : { lastFrame: true }) }
          : { videoUrl: vUrl, timeSeconds: tStart ?? 0 };
        const r = await fetch("/api/extract-frame", { method: "POST", headers: frameHeaders, body: JSON.stringify(body) });
        const j = await r.json();
        if (j.cdnUrl) {
          if (fe.targetHandle === "startFrame") finalStartFrameUrl = j.cdnUrl;
          else finalEndFrameUrl = j.cdnUrl;
        }
      } catch { /* proceed without */ }
    }

    // One normalized payload for every video family (design §4.1) — the
    // server-side adapter branches on the model's apiInput flags; the old
    // isVeo alternate body is gone.
    const payload: Record<string, unknown> = {
      videoModel: videoModelId,
      // Explicit backend — read fresh from the store at submit time (always
      // current; keeps this callback's deps compiler-memoizable).
      providerId: getModelProvider(videoModelId),
      prompt: finalPrompt,
      aspectRatio,
      duration,
      ...(cfg.modes?.length ? { mode } : {}),
      resolution,
      ...(cfg.sound ? { sound } : {}),
      veoMode,
      startFrameUrl: finalStartFrameUrl,
      endFrameUrl: finalEndFrameUrl,
      videoRefUrl: finalVideoRefUrl,
      resources: orderedResources,
      referenceImageUrls: orderedResources.length > 0
        ? orderedResources.map((r) => r.url)
        : undefined,
      referenceVideoUrls: upstream.referenceVideoUrls.slice(0, maxRefVideos),
      referenceAudioUrls: upstream.referenceAudioUrls.slice(0, maxRefAudios),
      ...(cfg.supportsSeeds && seed ? { seed } : {}),
    };

    if (debugMode) {
      // Simulate a 5-second generation and log payload to backend console
      const storeNode0 = useWorkflowStore.getState().nodes.find((n) => n.id === id);
      const prevGens = [...((storeNode0?.data?.generations as GenEntry[] | undefined) ?? [])] as GenEntry[];
      const prevMeta = [...((storeNode0?.data?.generationsMeta as (GenMeta | null)[] | undefined) ?? [])];
      const thisMeta: GenMeta = { videoModel: videoModelId, aspectRatio, duration, klingMode: mode, grokResolution: resolution, sound };
      updateNodeData(id, { status: "running", generations: [...prevGens, null] as GenEntry[], generationsMeta: [...prevMeta, thisMeta], currentGenIdx: prevGens.length });
      setLoading(true);
      try {
        await fetch("/api/generate-video", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ ...payload, debugOnly: true }),
        });
        await new Promise((r) => setTimeout(r, 5000));
      } finally {
        const storeNode1 = useWorkflowStore.getState().nodes.find((n) => n.id === id);
        const gens = [...((storeNode1?.data?.generations as GenEntry[] | undefined) ?? [])];
        gens[prevGens.length] = undefined as unknown as GenEntry;
        updateNodeData(id, { status: "idle", generations: gens.filter((g) => g !== undefined) as GenEntry[] });
        setLoading(false);
      }
      return;
    }

    // Set PENDING state — gives user 3 seconds to cancel before the API call
    const storeNode0 = useWorkflowStore.getState().nodes.find((n) => n.id === id);
    const prevGens2 = [...((storeNode0?.data?.generations as GenEntry[] | undefined) ?? [])] as GenEntry[];
    const prevMeta2 = [...((storeNode0?.data?.generationsMeta as (GenMeta | null)[] | undefined) ?? [])];
    const loadingGens2 = [...prevGens2, null] as GenEntry[];
    const thisMeta: GenMeta = { videoModel: videoModelId, aspectRatio, duration, klingMode: mode, grokResolution: resolution, sound };
    const loadingMeta2 = [...prevMeta2, thisMeta];
    updateNodeData(id, { status: "pending", videoUrl: undefined, imageNaturalRatio: undefined, errorMsg: undefined, taskId: undefined, generations: loadingGens2, generationsMeta: loadingMeta2, currentGenIdx: loadingGens2.length - 1 });

    pendingTimerRef.current = setTimeout(async () => {
      pendingTimerRef.current = null;
      setLoading(true);
      updateNodeData(id, { status: "running" });
      try {
        const res = await fetch("/api/generate-video", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify(payload),
        });
        const text = await res.text();
        let json: { taskId?: string; error?: string } = {};
        try { json = JSON.parse(text); } catch { throw new Error(res.ok ? "Invalid server response" : `Server error ${res.status}`); }
        if (!res.ok) throw new Error(json.error ?? `Server error ${res.status}`);
        // Store taskId — the polling useEffect above will wait for completion.
        // `lastTaskId` keeps the id after the job settles, so the run log
        // stays readable; `taskId` keeps its existing lifecycle.
        updateNodeData(id, { taskId: json.taskId, lastTaskId: json.taskId });
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        const storeNode = useWorkflowStore.getState().nodes.find((n) => n.id === id);
        const gens = [...((storeNode?.data?.generations as GenEntry[] | undefined) ?? [])] as GenEntry[];
        const slot = (storeNode?.data?.currentGenIdx as number | undefined) ?? Math.max(0, gens.length - 1);
        gens[slot] = { error: errMsg };
        updateNodeData(id, { status: "error", errorMsg: errMsg, generations: gens, currentGenIdx: slot });
      } finally {
        setLoading(false);
      }
    }, 3000);
  }, [id, nodes, edges, prompt, sound, seed, duration, aspectRatio, videoModelId, veoMode, isVeo,
    mode, resolution, cfg, debugMode, textEdge, updateNodeData, flashEdgeError, addToast]);

  const handleGenerateBatch = useCallback(() => {
    generate();
    if (genCount <= 1) return;

    const state = useWorkflowStore.getState();
    const src = state.nodes.find((n) => n.id === id);
    if (!src) return;

    const nodeW = cardRef.current?.offsetWidth ?? 320;
    const nodeH = cardRef.current?.offsetHeight ?? 320;
    const { x, y } = src.position;
    const GAP = 24;
    const POSITIONS = [
      { col: 1, row: 0 },
      { col: 0, row: 1 },
      { col: 1, row: 1 },
    ];

    const newIds: string[] = [];
    for (let i = 0; i < genCount - 1; i++) {
      const pos = POSITIONS[i];
      const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      newIds.push(newId);
      addNode({
        ...src,
        id: newId,
        position: { x: x + pos.col * (nodeW + GAP), y: y + pos.row * (nodeH + GAP) },
        selected: false,
        data: {
          ...src.data,
          status: "idle",
          videoUrl: undefined,
          generations: [],
          generationsMeta: [],
          currentGenIdx: 0,
          imageNaturalRatio: undefined,
          taskId: undefined,
          lastTaskId: undefined,
          hasError: false,
          pendingGenerate: true,
        },
      });
      state.edges
        .filter((e) => e.target === id && e.deletable !== false)
        .forEach((e) => insertEdge({
          ...e,
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          target: newId,
        }));
    }

    // Select the original node and all spawned siblings
    onNodesChange([id, ...newIds].map((nid) => ({ type: "select" as const, id: nid, selected: true })));
  }, [generate, genCount, id, addNode, insertEdge, onNodesChange]);

  // Pipeline runner trigger — called by Run Pipeline button
  const generateRef = useRef(generate);
  useEffect(() => { generateRef.current = generate; }, [generate]);
  useEffect(() => {
    if (!data.pendingGenerate) return;
    updateNodeData(id, { pendingGenerate: false });
    generateRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.pendingGenerate]);

  const hoveredDef = hoveredHand && activeHandles.has(hoveredHand)
    ? handles.find((h) => h.id === hoveredHand)
    : null;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      ref={cardRef}
      className={`video-node-card node-card w-full${animBusy ? " node-generating" : ""}${isQueued ? " node-queued" : ""}${(data.hasError as boolean) ? " node-error-blink" : ""}`}
      style={{
        minWidth: 320,
        aspectRatio: (data.imageNaturalRatio as string | undefined) ?? aspectRatio.replace(":", " / "),
      }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={closeAll}
      onAnimationEnd={(e) => { if (e.animationName === "node-error-blink") updateNodeData(id, { hasError: false }); }}
    >
      <CornerResizer minWidth={280} minHeight={80} keepAspectRatio={!!data.videoUrl} />
      <NodeActionBar
        visible={!!selected && !data.locked && !parentGroupSelected && !multiSelected && !readOnly}
        hasContent={!!data.videoUrl}
        isSaving={isSaving}
        onPreview={openLightbox}
        onDelete={handleDelete}
        onSave={handleSave}
        onDuplicate={handleDuplicate}
      />
      {data.locked && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20" style={{ borderRadius: 8 }}>
          <div className="w-9 h-9 rounded-full flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
        </div>
      )}

      <span className="node-above-label" style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <VideoNodeIcon />
        {data.label as string}
      </span>
      {(!connectedHandles.has("prompt") && !cfg.promptOptional || hasFailedMediaInput) && status !== "running" && !data.locked && (
        <MissingInputWarning messages={[
          ...(!connectedHandles.has("prompt") && !cfg.promptOptional ? ["A text node is required"] : []),
          ...(hasFailedMediaInput ? ["A connected image/video input has no valid content"] : []),
        ]} />
      )}

      {/* ── Source (output) handles — top-right ──────────────────────── */}
      {/* Render all handles at fixed positions so edges don't jump when frame handles hide. */}
      {SOURCE_HANDLES.map((h, i) => {
        const visible = visibleSourceHandles.some((v) => v.id === h.id);
        return (
          <Handle
            key={h.id}
            type="source"
            position={Position.Right}
            id={h.id}
            style={{ top: `calc(50% + ${sourceHandleCenterOffset(i)}px)`, visibility: visible ? undefined : "hidden", pointerEvents: visible ? undefined : "none" }}
            className={`node-handle-icon node-handle-icon-out-${h.type}${edges.some((e) => e.source === id && e.sourceHandle === h.id) ? " node-handle-connected" : ""}${(data.hasError as boolean) ? " node-handle-error" : ""}`}
            onMouseEnter={() => { if (visible) setHoveredSourceHandle(h.id); }}
            onMouseLeave={() => setHoveredSourceHandle(null)}
          >
            {h.icon}
          </Handle>
        );
      })}

      {/* Source handle tooltip */}
      {hoveredSourceHandle && (() => {
        const idx = SOURCE_HANDLES.findIndex((h) => h.id === hoveredSourceHandle);
        const def = SOURCE_HANDLES[idx];
        if (!def) return null;
        const color = SOURCE_HANDLE_COLORS[def.type];
        return (
          <div
            className="absolute pointer-events-none z-[1001] text-[10px] px-2.5 py-1 rounded-lg whitespace-nowrap shadow-xl"
            style={{
              top: `calc(50% + ${sourceHandleCenterOffset(idx)}px)`,
              right: 0,
              transform: "translate(calc(100% + 34px), -50%)",
              background: "#1A1A1A",
              border: `1px solid ${color}33`,
              color: "#CCCCCC",
            }}
          >
            <span style={{ color }} className="mr-1.5">●</span>
            {def.label}
          </div>
        );
      })()}

      {/* ── Handles ──────────────────────────────────────────────────── */}
      {handles.map((h) => {
        const hidden = !activeHandles.has(h.id);
        const centerOffset = handleCenterOffsetMap.get(h.id) ?? 0;
        const isMotionStartFrame = h.id === "startFrame" && cfg.apiInput.useMotionControl;
        const compatible = !connectingHandleType
          || (CONNECTABLE_FOR_TYPE[connectingHandleType]?.has(h.id) ?? false);
        // Once a generation has completed, an already-connected handle can't be
        // silently swapped — but an empty (or never-used) slot is always connectable.
        const connectable = !hidden && compatible && (!hasGeneration || !connectedHandles.has(h.id));
        return (
          <Handle
            key={h.id}
            type="target"
            position={Position.Left}
            id={h.id}
            isConnectable={connectable}
            style={{ top: `calc(50% + ${centerOffset}px)`, visibility: hidden ? "hidden" : undefined, pointerEvents: hidden ? "none" : undefined }}
            className={`${h.className}${errorHandles.has(h.id) ? " node-handle-error" : ""}${connectedHandles.has(h.id) ? " node-handle-connected" : ""}`}
            onMouseEnter={() => { if (!hidden && compatible) setHoveredHand(h.id); }}
            onMouseLeave={() => setHoveredHand(null)}
          >
            {h.id === "prompt" && <PromptIcon />}
            {h.id === "startFrame" && !isMotionStartFrame && <FrameStartIcon />}
            {isMotionStartFrame && <CharacterIcon />}
            {h.id === "endFrame" && <FrameEndIcon />}
            {h.id === "resource" && <ResourceIcon />}
            {h.id === "videoRef" && <VideoRefIcon />}
            {h.id === "referenceVideo" && <RefVideoIcon />}
            {h.id === "audioRef" && <AudioRefIcon />}
          </Handle>
        );
      })}

      {/* Handle tooltip */}
      {hoveredDef && (() => {
        const centerOffset = handleCenterOffsetMap.get(hoveredDef.id) ?? 0;
        const tooltipColor =
          hoveredDef.id === "startFrame" && cfg.apiInput.useMotionControl
            ? "#f472b6"
            : HANDLE_COLORS[hoveredDef.id] ?? "#888";
        return (
          <div
            className="absolute pointer-events-none z-[1001] text-[10px] px-2.5 py-1 rounded-lg whitespace-nowrap shadow-xl"
            style={{
              top: `calc(50% + ${centerOffset}px)`,
              left: 0,
              transform: "translate(calc(-100% - 34px), -50%)",
              background: "#1A1A1A",
              border: `1px solid ${tooltipColor}33`,
              color: "#CCCCCC",
            }}
          >
            <span style={{ color: tooltipColor }} className="mr-1.5">●</span>
            {hoveredDef.label}
          </div>
        );
      })()}

      {/* ── Full-card media container — all controls overlaid inside ── */}
      <div
        className="relative bg-[#2a2d35] group/player group/gen"
        style={{
          aspectRatio: (data.imageNaturalRatio as string | undefined) ?? aspectRatio.replace(":", " / "),
          width: "100%",
          transition: "aspect-ratio 0.35s cubic-bezier(0.4, 0, 0.2, 1)",
        }}
      >
        {/* Clipped media layer */}
        <div className="absolute inset-0 overflow-hidden rounded-[8px] z-0">
          {/* Video carousel strip */}
          {generations.length > 0 ? (
            <div
              style={{
                display: "flex",
                position: "absolute",
                inset: 0,
                transform: `translateX(${-currentGenIdx * 100}%)`,
                transition: "transform 320ms cubic-bezier(0.4, 0, 0.2, 1)",
                willChange: "transform",
              }}
            >
              {generations.map((entry, i) => (
                <div key={i} style={{ minWidth: "100%", height: "100%", flexShrink: 0, position: "relative", background: "#2a2d35" }}>
                  {entry === null ? (
                    <div className="absolute inset-0" style={{ background: "#2a2d35" }} />
                  ) : typeof entry === "object" ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center z-20" style={{ background: "#2a2427" }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" fill="#1a0a0a" stroke="#5a1a1a" strokeWidth="1.5" />
                        <path d="M12 7v5" stroke="#c04040" strokeWidth="2" strokeLinecap="round" />
                        <circle cx="12" cy="16" r="1" fill="#c04040" />
                      </svg>
                      {(entry.error === "moderation_blocked" || entry.error?.includes?.("moderation_blocked") || entry.error?.includes?.("flagged as sensitive")) ? (
                        <div className="flex items-center justify-center gap-1.5 text-[10px] text-[#f87171]">
                          <ShieldBan size={12} strokeWidth={1.5} className="shrink-0" />
                          <span>NSFW content detected</span>
                        </div>
                      ) : (
                        <p className="text-[10px] text-[#f87171] leading-snug break-words w-full">{entry.error}</p>
                      )}
                      <button
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); deleteGen(i); }}
                        className="flex items-center gap-1.5 h-7 px-3 rounded-full transition-all hover:bg-red-900/60"
                        style={{ background: "rgba(40,0,0,0.7)", backdropFilter: "blur(10px)", border: "1px solid rgba(200,50,50,0.35)" }}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="stroke-red-400">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          <path d="M10 11v6M14 11v6" />
                          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                        </svg>
                        <span className="text-[11px] font-medium text-red-400">Delete</span>
                      </button>
                    </div>
                  ) : (
                    // eslint-disable-next-line jsx-a11y/media-has-caption
                    <video
                      ref={(el) => {
                        if (el) { videoRefs.current.set(i, el); if (i === currentGenIdx) (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el; }
                        else videoRefs.current.delete(i);
                      }}
                      src={entry}
                      className="absolute inset-0 block"
                      style={{ width: "100%", height: "100%", objectFit: "fill" }}
                      loop
                      playsInline
                      muted={i !== currentGenIdx || muted || !hovering}
                      onPlay={i === currentGenIdx ? () => setIsPlaying(true) : undefined}
                      onPause={i === currentGenIdx ? () => setIsPlaying(false) : undefined}
                      onLoadedMetadata={i === currentGenIdx ? handleVideoMeta : undefined}
                      onTimeUpdate={i === currentGenIdx ? (e) => {
                        const v = e.currentTarget;
                        setCurrentSec(v.currentTime);
                        if (v.duration) setProgress(v.currentTime / v.duration);
                      } : undefined}
                    />
                  )}
                </div>
              ))}
            </div>
          ) : status === "error" ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center px-5 gap-2.5 text-center">
              <div className="flex items-center gap-2.5">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="shrink-0">
                  <circle cx="12" cy="12" r="10" fill="#1a0a0a" stroke="#5a1a1a" strokeWidth="1.5" />
                  <path d="M12 7v5" stroke="#c04040" strokeWidth="2" strokeLinecap="round" />
                  <circle cx="12" cy="16" r="1" fill="#c04040" />
                </svg>
                <span className="text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap" style={{ border: "1px solid rgba(74,222,128,0.2)", color: "#4ade80", background: "rgba(74,222,128,0.07)" }}>
                  Credits refunded
                </span>
              </div>
              <p className="text-white text-[12px] font-semibold leading-snug">Oops! Something went wrong.</p>
              {(() => {
                const msg = (data.errorMsg as string) ?? "Generation failed";
                const isNsfw = msg === "moderation_blocked" || msg.includes("moderation_blocked") || msg.includes("flagged as sensitive");
                return isNsfw ? (
                  <div className="flex items-center gap-1.5 text-[#f87171] text-[10px]">
                    <ShieldBan size={12} strokeWidth={1.5} className="shrink-0" />
                    <span>NSFW content detected</span>
                  </div>
                ) : (
                  <p className="text-[#f87171] text-[10px] leading-[1.5] break-words">{msg}</p>
                );
              })()}
            </div>
          ) : (
            <div className="w-full h-full">
              {textNode && (
                <div className="absolute bottom-12 left-4 flex items-center gap-1.5 z-10">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#2DD4BF] shrink-0" />
                  <span className="text-[11px] text-[#555]">{textNode.data.label as string}</span>
                </div>
              )}
            </div>
          )}

          {/* Frame view overlay — shown when toggle is set to "frame" */}
          {viewMode === "frame" && displayFrameUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={displayFrameUrl}
              alt="Captured frame"
              className="absolute inset-0 w-full h-full block"
              style={{ objectFit: "fill", zIndex: 5 }}
            />
          )}
        </div>

        {/* ── Normal player controls (hidden while picker is open) ── */}
        {!pickerOpen && (
          <>
            {/* Video / Frame toggle switch — top-left, visible on hover */}
            {!busy && displayFrameUrl && (
              <div
                className="absolute top-2 left-2 z-10 flex items-center p-1 rounded-full gap-0.5 opacity-0 group-hover/player:opacity-100 transition-opacity node-slide-reveal"
                style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(8px)" }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {/* Sliding active indicator */}
                <div style={{
                  position: "absolute",
                  top: 4, left: 4,
                  width: 28, height: 28,
                  borderRadius: "50%",
                  background: viewMode === "frame" ? "transparent" : "rgba(255,255,255,0.18)",
                  border: "1.5px solid rgba(255,255,255,0.45)",
                  transform: `translateX(${viewMode === "frame" ? 30 : 0}px)`,
                  transition: "transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1)",
                  pointerEvents: "none",
                  zIndex: 20,
                }} />
                <button
                  onClick={(e) => { e.stopPropagation(); setViewMode("video"); }}
                  className="w-7 h-7 rounded-full flex items-center justify-center relative z-10"
                  title="Show video"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={viewMode === "video" ? "white" : "#777"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transition: "stroke 220ms" }}>
                    <rect width="15" height="14" x="2" y="5" rx="2" />
                    <path d="m17 8 5-3v14l-5-3V8Z" />
                  </svg>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setViewMode("frame"); }}
                  className="w-7 h-7 rounded-full flex items-center justify-center relative z-10"
                  title="Show frame"
                >
                  <div style={{
                    width: 20, height: 20, borderRadius: "50%",
                    backgroundImage: `url(${displayFrameUrl})`,
                    backgroundSize: "cover", backgroundPosition: "center",
                    flexShrink: 0,
                    border: "1px solid rgba(255,255,255,0.15)",
                  }} />
                </button>
              </div>
            )}

            {/* Mute button — top right, shown on hover when video is ready */}
            {typeof generations[currentGenIdx] === "string" && (
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); setGlobalMuted(!muted); }}
                className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center opacity-0 group-hover/player:opacity-100 transition-opacity pointer-events-auto z-20 node-slide-reveal"
                title={muted ? "Unmute" : "Mute"}
              >
                {muted ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <line x1="23" y1="9" x2="17" y2="15" />
                    <line x1="17" y1="9" x2="23" y2="15" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 5L6 9H2V15H6L11 19V5Z" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                  </svg>
                )}
              </button>
            )}

            {/* Carousel indicators */}
            {generations.length > 1 && (
              <div className="absolute top-2 left-1/2 -translate-x-1/2 flex gap-1.5 z-20 pointer-events-none opacity-0 group-hover/player:opacity-100 transition-opacity duration-200">
                {generations.map((_, i) => (
                  <div
                    key={i}
                    className={`h-1 rounded-full transition-all duration-300 ${i === currentGenIdx ? "w-4 bg-white" : "w-1 bg-white/30"}`}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* ── Frame picker overlay ─────────────────────────────────── */}
        {pickerOpen && (
          <div
            className="nodrag absolute inset-0 flex flex-col z-30 bg-transparent"
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {/* Scrubber + time */}
            <div className="mt-auto px-3 pb-3 flex flex-col gap-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-white font-mono tabular-nums">{fmtTime(currentSec)}</span>
                {captureErr
                  ? <span className="text-[10px] text-red-400">{captureErr}</span>
                  : <span className="text-[10px] text-white/40">drag to seek</span>
                }
              </div>
              <input
                type="range" min={0} max={1} step={0.0001}
                value={scrubPos}
                onChange={(e) => {
                  const pct = parseFloat(e.target.value);
                  setScrubPos(pct);
                  const v = videoRef.current;
                  if (v && v.duration) v.currentTime = pct * v.duration;
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                className="nodrag w-full cursor-pointer accent-white"
              />
              <div className="flex gap-2">
                <button
                  onMouseDown={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); captureFrame(); }}
                  disabled={capturing}
                  className="nodrag flex-1 h-7 rounded-full bg-white/90 text-black text-[11px] font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer"
                >
                  {capturing ? (
                    <>
                      <svg width="11" height="11" viewBox="0 0 22 22" fill="none" style={{ animation: "spin 0.9s linear infinite" }}>
                        <circle cx="11" cy="11" r="8" stroke="#333" strokeWidth="2.5" />
                        <path d="M11 3A8 8 0 0 1 19 11" stroke="#000" strokeWidth="2.5" strokeLinecap="round" />
                      </svg>
                      Capturing…
                    </>
                  ) : (
                    <>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="3" /><path d="M20 7h-3.2L15 5H9L7.2 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z" />
                      </svg>
                      Use this frame
                    </>
                  )}
                </button>
                <button
                  onMouseDown={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    videoRef.current?.play().catch(() => { });
                    if (lastEdgeIdRef.current) onEdgesChange([{ type: "remove", id: lastEdgeIdRef.current }]);
                    setPickerOpen(false);
                    lastEdgeIdRef.current = null;
                  }}
                  className="nodrag h-7 px-3 rounded-full bg-white/10 text-white text-[11px] flex items-center justify-center cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Queued badge */}
        {isQueued && (
          <div
            className="absolute top-2 left-2 flex items-center gap-1.5 h-7 px-3 rounded-full z-20 pointer-events-none select-none"
            style={{ background: "rgba(0,0,0,0.58)", backdropFilter: "blur(10px)", border: "1px solid rgba(148,163,184,0.2)" }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(148,163,184,0.65)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 3" />
            </svg>
            <span className="text-[11px] font-medium" style={{ color: "rgba(148,163,184,0.8)" }}>Queued</span>
          </div>
        )}

        {/* Generating badge + cancel */}
        {busy && generations[currentGenIdx] === null && (
          <div className="absolute top-2 left-2 right-2 flex flex-wrap gap-1.5 z-20" style={{ alignItems: "flex-start" }}>
            <div
              className="flex items-center gap-1.5 h-7 px-3 rounded-full pointer-events-none select-none"
              style={{ background: "rgba(0,0,0,0.58)", backdropFilter: "blur(10px)", border: isPending ? "1px solid rgba(255,255,255,0.08)" : "1px solid rgba(45,212,191,0.25)", flexShrink: 0 }}
            >
              {isPending ? (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ animation: "spin 0.9s linear infinite", flexShrink: 0 }}>
                  <circle cx="5" cy="5" r="4" stroke="rgba(255,255,255,0.18)" strokeWidth="1.5" />
                  <path d="M5 1 A4 4 0 0 1 9 5" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ animation: "spin 0.9s linear infinite", flexShrink: 0 }}>
                  <circle cx="5" cy="5" r="4" stroke="rgba(45,212,191,0.25)" strokeWidth="1.5" />
                  <path d="M5 1 A4 4 0 0 1 9 5" stroke="#2DD4BF" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              )}
              <span className="text-[11px] font-medium" style={{ color: isPending ? "#888" : "#2DD4BF" }}>
                {isPending ? "Pending" : "Generating…"}
              </span>
            </div>
            {isPending && (
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); handleCancel(); }}
                className="ml-auto flex items-center gap-1.5 h-7 px-3 rounded-full transition-colors hover:bg-white/10"
                style={{ background: "rgba(0,0,0,0.58)", backdropFilter: "blur(10px)", border: "1px solid rgba(255,255,255,0.08)", flexShrink: 0 }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="2" strokeLinecap="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="m6 6 12 12" />
                </svg>
                <span className="text-[11px] text-[#ccc] font-medium">Cancel</span>
              </button>
            )}
          </div>
        )}

        {/* Mute button — top right, shown on hover when video is ready */}
        {!pickerOpen && typeof generations[currentGenIdx] === "string" && (
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setGlobalMuted(!muted); }}
            className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center opacity-0 group-hover/player:opacity-100 transition-opacity pointer-events-auto z-20 node-slide-reveal"
            title={muted ? "Unmute" : "Mute"}
          >
            {muted ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              </svg>
            )}
          </button>
        )}

        {/* Player bar — timer + progress + play/pause at very bottom */}
        {!pickerOpen && typeof generations[currentGenIdx] === "string" && (
          <div
            className="absolute bottom-0 left-0 right-0 flex items-center gap-2 px-2.5 h-9 opacity-0 group-hover/player:opacity-100 transition-opacity z-20"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <span className="text-[10px] text-white/60 font-mono tabular-nums shrink-0">{fmtTime(currentSec)}</span>
            <div
              className="flex-1 h-[2px] bg-white/15 rounded-full cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                const pct = (e.clientX - rect.left) / rect.width;
                const v = videoRef.current;
                if (v && v.duration) v.currentTime = pct * v.duration;
              }}
            >
              <div className="h-full bg-white/60 rounded-full transition-none" style={{ width: `${progress * 100}%` }} />
            </div>
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                const v = videoRef.current;
                if (!v) return;
                if (v.paused) v.play().catch(() => { }); else v.pause();
              }}
              className="shrink-0 pointer-events-auto opacity-70 hover:opacity-100 transition-opacity"
              title={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
                  <rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              )}
            </button>
          </div>
        )}

        {/* ── Bottom overlay control bar ── */}
        {(() => {
          const modePicker = cfg.modes ? (
            <div className="relative shrink-0">
              <div className="flex items-center rounded-full" style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", border: "1px solid rgba(255,255,255,0.07)" }}>
                <button
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => { setModeOpen((o) => !o); setModelOpen(false); setRatioOpen(false); setDurOpen(false); setGrokResOpen(false); }}
                  className="flex items-center gap-1.5 pl-2 pr-1.5 py-1 hover:brightness-125 transition-all whitespace-nowrap"
                >
                  <span className="text-[11px] text-white/70">{cfg.modes.find((m) => m.value === mode)?.label ?? mode}</span>
                  <ChevronIcon open={modeOpen} />
                </button>
                {cfg.apiInput.useMotionControl && (
                  <>
                    <span className="w-px h-3 bg-white/10 shrink-0" />
                    <div className="relative group/orient-info flex items-center px-1.5 py-1">
                      <div className="w-3.5 h-3.5 rounded-full border border-white/20 flex items-center justify-center text-white/40 hover:text-white/70 hover:border-white/40 transition-colors cursor-default select-none">
                        <span className="text-[8px] font-semibold leading-none">i</span>
                      </div>
                      <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 px-3 py-2 rounded-lg text-[10px] leading-[1.6] text-[#AAA] opacity-0 group-hover/orient-info:opacity-100 transition-opacity z-50 node-slide-reveal" style={{ background: "#111317", border: "1px solid #2A2A2A" }}>
                        When Character Orientation matches the video, complex motions perform better; when it matches the image, camera movements are better supported.
                      </div>
                    </div>
                  </>
                )}
              </div>
              <FloatMenu open={modeOpen}>
                {cfg.modes.map((m) => (
                  <FloatItem key={m.value} active={mode === m.value} onClick={() => { updateNodeData(id, { klingMode: m.value }); setModeOpen(false); }}>
                    {m.label}
                  </FloatItem>
                ))}
              </FloatMenu>
            </div>
          ) : null;

          const resPicker = cfg.resolutions ? (
            <div className="relative shrink-0">
              <Pill onClick={() => { setGrokResOpen((o) => !o); setModelOpen(false); setRatioOpen(false); setDurOpen(false); setModeOpen(false); }}>
                <span className="text-[11px] text-white/70">{resolution}</span>
                <ChevronIcon open={grokResOpen} />
              </Pill>
              <FloatMenu open={grokResOpen}>
                {cfg.resolutions.map((r) => (
                  <FloatItem key={r} active={resolution === r} onClick={() => { updateNodeData(id, { grokResolution: r }); setGrokResOpen(false); }}>
                    {r}
                  </FloatItem>
                ))}
              </FloatMenu>
            </div>
          ) : null;

          return (
            <div
              ref={controlBarRef}
              className={`absolute left-0 right-0 flex items-end gap-2 px-2.5 pb-2 pt-1 z-[1001] transition-opacity duration-150 ${(hovering || selected) && !pickerOpen ? "opacity-100" : "opacity-0 pointer-events-none"}`}
              style={{ bottom: 36 }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {/* Pills — wrap freely */}
              <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">

                {/* Run log — read-only disclosure over the job's event trail */}
                {logTaskId && (
                  <div className="relative">
                    <Pill onClick={() => { setLogOpen((o) => !o); setModelOpen(false); setRatioOpen(false); setDurOpen(false); setModeOpen(false); setGrokResOpen(false); }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 4h16v16H4z" />
                        <path d="M8 9h8M8 13h8M8 17h5" />
                      </svg>
                      <span className="text-[11px] text-white/70">Run log</span>
                    </Pill>
                    <FloatMenu open={logOpen}>
                      <div className="px-2.5 py-2 w-72" onMouseDown={(e) => e.stopPropagation()}>
                        <JobLogViewer taskId={logTaskId} maxHeight={200} />
                      </div>
                    </FloatMenu>
                  </div>
                )}

                {/* Model */}
                <div className="relative">
                  <Pill onClick={() => { setModelOpen((o) => !o); setRatioOpen(false); setDurOpen(false); setModeOpen(false); setGrokResOpen(false); }}>
                    <span className="shrink-0 text-white/60" style={{ lineHeight: 0 }}>
                      <NodeProviderIcon provider={cfg.provider} />
                    </span>
                    <span className="text-[11px] text-white/70">{cfg.name}</span>
                    <ChevronIcon open={modelOpen} />
                  </Pill>
                  <FloatMenu open={modelOpen}>
                    {[...new Set(visibleVideoModels.map(m => m.provider))].map((provider, pi) => (
                      <Fragment key={provider}>
                        {pi > 0 && <div style={{ height: "1px", background: "rgba(255,255,255,0.06)", margin: "4px 8px" }} />}
                        <div style={{ padding: "5px 10px 3px", fontSize: "10px", color: "rgba(255,255,255,0.22)", textTransform: "uppercase", letterSpacing: "0.09em", fontWeight: 500 }}>
                          {provider}
                        </div>
                        {visibleVideoModels.filter(m => m.provider === provider).map(m => (
                          <button
                            key={m.id}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={() => {
                              const validRatio = m.ratios.includes(aspectRatio) ? aspectRatio : m.defaultRatio;
                              const validDur = m.durations.includes(duration) ? duration : m.defaultDuration;
                              const validRes = m.resolutions
                                ? (m.resolutions.includes(resolution) ? resolution : (m.defaultResolution ?? m.resolutions[0]))
                                : undefined;
                              updateNodeData(id, { videoModel: m.id, aspectRatio: validRatio, duration: validDur, ...(validRes !== undefined && { grokResolution: validRes }) });
                              const removedHandles = (cfg.handles as string[]).filter((h) => !(m.handles as string[]).includes(h));
                              const wasMotionControl = cfg.apiInput.useMotionControl;
                              const isMotionControl = m.apiInput.useMotionControl;
                              if (wasMotionControl !== isMotionControl && !removedHandles.includes("startFrame")) {
                                removedHandles.push("startFrame");
                              }
                              const oldHasVideoRef = (cfg.handles as string[]).includes("videoRef");
                              const newHasVideoRef = (m.handles as string[]).includes("videoRef");
                              const oldHasRefVideo = (cfg.handles as string[]).includes("referenceVideo");
                              const newHasRefVideo = (m.handles as string[]).includes("referenceVideo");
                              if (oldHasVideoRef && !newHasVideoRef && newHasRefVideo) {
                                remapTargetHandle(id, "videoRef", "referenceVideo");
                                removedHandles.splice(removedHandles.indexOf("videoRef"), 1);
                              } else if (oldHasRefVideo && !newHasRefVideo && newHasVideoRef) {
                                remapTargetHandle(id, "referenceVideo", "videoRef");
                                removedHandles.splice(removedHandles.indexOf("referenceVideo"), 1);
                              }
                              if (removedHandles.length) killEdgesForHandles(id, removedHandles);
                              setModelOpen(false);
                            }}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-[11px] hover:bg-[#141C28] transition-colors ${videoModelId === m.id ? "text-white font-medium" : "text-[#A0A0A0]"}`}
                          >
                            <span className="shrink-0 text-white/50" style={{ lineHeight: 0 }}>
                              <NodeProviderIcon provider={m.provider} />
                            </span>
                            <span className="flex-1 text-left whitespace-nowrap">{m.name}</span>
                          </button>
                        ))}
                      </Fragment>
                    ))}
                  </FloatMenu>
                </div>

                {/* Provider pill — any video model with ≥2 bound backends (P5 C7) */}
                {modelHasProviderChoice(videoModelId) && providerChoices.length >= 2 && (
                  <div className="relative">
                    <Pill onClick={() => { setProviderOpen((o) => !o); setModelOpen(false); setRatioOpen(false); setDurOpen(false); setModeOpen(false); setGrokResOpen(false); }}>
                      <span className="flex items-center gap-1.5 text-[11px] text-white/70">
                        <ProviderBrandIcon id={currentProvider} size={11} />
                        {PROVIDERS.find((p) => p.id === currentProvider)?.label ?? "Kie.ai"}
                      </span>
                      <ChevronIcon open={providerOpen} />
                    </Pill>
                    <FloatMenu open={providerOpen}>
                      {providerChoices.map((id) => {
                        const p = PROVIDERS.find((q) => q.id === id);
                        if (!p) return null;
                        return (
                          <button
                            key={p.id}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={() => { setModelProvider(videoModelId, p.id); setProviderOpen(false); }}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-[11px] hover:bg-[#141C28] transition-colors ${currentProvider === p.id ? "text-white font-medium" : "text-[#A0A0A0]"}`}
                          >
                            <ProviderBrandIcon id={p.id} size={11} />
                            <span className="flex-1 text-left whitespace-nowrap">{p.label}</span>
                          </button>
                        );
                      })}
                    </FloatMenu>
                  </div>
                )}

                {/* Duration */}
                {durations.length > 0 && (
                  <div className="relative flex items-center gap-1">
                    <button
                      type="button"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        const idx = Math.max(0, (durations as readonly number[]).indexOf(duration));
                        if (idx > 0) updateNodeData(id, { duration: (durations as readonly number[])[idx - 1] });
                      }}
                      disabled={Math.max(0, (durations as readonly number[]).indexOf(duration)) <= 0}
                      className="shrink-0 flex items-center justify-center w-[20px] h-[20px] rounded-full border border-white/[0.07] bg-black/45 text-white/75 text-xs leading-none disabled:opacity-35 disabled:cursor-not-allowed hover:brightness-125 transition-all"
                      style={{ backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)" }}
                    >−</button>
                    <Pill onClick={() => { setDurOpen((o) => !o); setModelOpen(false); setRatioOpen(false); setModeOpen(false); setGrokResOpen(false); }}>
                      <span className="text-[11px] text-white/70 tabular-nums">{duration}s</span>
                      <ChevronIcon open={durOpen} />
                    </Pill>
                    <button
                      type="button"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        const idx = Math.max(0, (durations as readonly number[]).indexOf(duration));
                        if (idx < (durations as readonly number[]).length - 1) updateNodeData(id, { duration: (durations as readonly number[])[idx + 1] });
                      }}
                      disabled={Math.max(0, (durations as readonly number[]).indexOf(duration)) >= (durations as readonly number[]).length - 1}
                      className="shrink-0 flex items-center justify-center w-[20px] h-[20px] rounded-full border border-white/[0.07] bg-black/45 text-white/75 text-xs leading-none disabled:opacity-35 disabled:cursor-not-allowed hover:brightness-125 transition-all"
                      style={{ backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)" }}
                    >+</button>
                    <FloatMenu open={durOpen}>
                      <div className="p-3 min-w-[200px]" onMouseDown={(e) => e.stopPropagation()}>
                        <p className="text-[12px] text-white font-medium mb-2.5">Choose duration</p>
                        <div
                          className="nodrag flex items-center gap-2.5 pl-3 pr-4 py-2 rounded-lg"
                          style={{ background: "#141C28" }}
                          onMouseDown={(e) => e.stopPropagation()}
                          onPointerDown={(e) => e.stopPropagation()}
                        >
                          <span className="text-[11px] text-[#AAA] tabular-nums shrink-0 w-6">{duration}s</span>
                          <div className="w-px h-3.5 shrink-0" style={{ background: "#2A2A2A" }} />
                          <input
                            type="range"
                            min={0}
                            max={(durations as readonly number[]).length - 1}
                            step={1}
                            value={Math.max(0, (durations as readonly number[]).indexOf(duration))}
                            onChange={(e) => {
                              const idx = parseInt(e.target.value);
                              updateNodeData(id, { duration: (durations as readonly number[])[idx] });
                            }}
                            className="dur-slider"
                          />
                        </div>
                      </div>
                    </FloatMenu>
                  </div>
                )}

                {/* Ratio */}
                {ratios.length > 0 && (
                  <div className="relative">
                    <Pill onClick={() => { setRatioOpen((o) => !o); setModelOpen(false); setDurOpen(false); setModeOpen(false); setGrokResOpen(false); }}>
                      <AspectIcon ratio={aspectRatio} />
                      <span className="text-[11px] text-white/70">{aspectRatio}</span>
                      <ChevronIcon open={ratioOpen} />
                    </Pill>
                    <FloatMenu open={ratioOpen}>
                      {(ratios as readonly string[]).map((r) => (
                        <FloatItem key={r} active={aspectRatio === r} onClick={() => { updateNodeData(id, { aspectRatio: r }); setRatioOpen(false); }}>
                          {r}
                        </FloatItem>
                      ))}
                    </FloatMenu>
                  </div>
                )}

                {modePicker}
                {resPicker}

                {/* Sound toggle */}
                {cfg.sound && (
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => updateNodeData(id, { sound: !sound })}
                    className="flex items-center gap-1.5 rounded-full px-2 py-1 transition-colors"
                    style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", border: "1px solid rgba(255,255,255,0.07)" }}
                  >
                    <ToggleSwitch on={sound} activeColor="#2dd4bf" />
                    <span className="text-[11px] text-white/70">Sound</span>
                  </button>
                )}

                {/* Veo mode toggle */}
                {isVeo && (videoModelId === "veo3" || videoModelId === "veo3_fast") && (
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      const next = veoMode === "frames" ? "references" : "frames";
                      updateNodeData(id, { veoMode: next });
                      if (next === "references") {
                        killEdgesForHandles(id, ["startFrame", "endFrame"]);
                      } else {
                        killEdgesForHandles(id, ["resource"]);
                      }
                    }}
                    className="flex items-center gap-1.5 rounded-full px-2 py-1 transition-colors"
                    style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", border: "1px solid rgba(255,255,255,0.07)" }}
                  >                  <ToggleSwitch on={veoMode === "references"} activeColor="#fb923c" />
                    <span className="text-[11px] text-white/70">{veoMode === "references" ? "References" : "Frames"}</span>
                  </button>
                )}
                {/* Seed input */}
                {cfg.supportsSeeds && (
                  <div
                    className="flex items-center gap-1.5 rounded-full px-2 py-1"
                    style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", border: "1px solid rgba(255,255,255,0.07)" }}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <span className="text-[11px] text-white/70 shrink-0 select-none">Seed</span>
                    <input
                      type="number"
                      min={0}
                      max={2147483647}
                      placeholder="—"
                      value={seed}
                      readOnly={readOnly}
                      onChange={(e) => {
                        const v = e.target.value === "" ? 0 : Math.max(0, Math.min(2147483647, parseInt(e.target.value, 10)));
                        updateNodeData(id, { seed: isNaN(v) ? 0 : v });
                      }}
                      className="nodrag w-12 bg-transparent border-none outline-none text-[11px] text-white/90 text-right tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                  </div>
                )}

                {/* Img ref indicator */}
                {activeHandles.has("resource") && hasResource && (
                  <div className="flex items-center gap-1 px-2 py-1 rounded-full" style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", border: "1px solid rgba(255,255,255,0.07)" }}>
                    <span className="w-1.5 h-1.5 rounded-full bg-[#fb923c] shrink-0" />
                    <span className="text-[10px] text-white/60">Img ref</span>
                  </div>
                )}

              </div>{/* end pills wrapper */}

              {/* Batch count selector */}
              {!readOnly && (
                <div
                  className="flex items-center shrink-0"
                  onMouseDown={(e) => e.stopPropagation()}
                  style={{ height: 26, borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.05)", overflow: "hidden" }}
                >
                  <button
                    onClick={(e) => { e.stopPropagation(); setGenCount(c => Math.max(1, c - 1)); }}
                    disabled={busy || genCount <= 1}
                    style={{ width: 24, height: "100%", border: "none", background: "transparent", color: genCount <= 1 ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.55)", cursor: busy || genCount <= 1 ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, transition: "color 140ms" }}
                  >−</button>
                  <span style={{ fontSize: 11, color: "#fff", minWidth: 28, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
                    {genCount}/4
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); setGenCount(c => Math.min(4, c + 1)); }}
                    disabled={busy || genCount >= 4}
                    style={{ width: 24, height: "100%", border: "none", background: "transparent", color: genCount >= 4 ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.55)", cursor: busy || genCount >= 4 ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, transition: "color 140ms" }}
                  >+</button>
                </div>
              )}

              {/* Generate button — always right */}
              {!readOnly && <GenerateButton onClick={handleGenerateBatch} busy={animBusy} extracting={isExtractingFrames} disabled={promptOverLimit || !modelReady.ready || busy || isExtractingFrames || hasFailedMediaInput} warningMessages={hasFailedMediaInput ? ["A connected image/video input has no valid content"] : undefined} />}
            </div>
          );
        })()}
      </div>

      {/* ── Carousel nav — floats below the node card ── */}
      {generations.length > 1 && (
        <div
          className="absolute left-0 right-0 flex items-center justify-center gap-1.5"
          style={{ top: "calc(100% + 16px)" }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            onClick={(e) => { e.stopPropagation(); goToGen(currentGenIdx - 1); }}
            disabled={currentGenIdx === 0}
            className="absolute left-0 w-7 h-7 flex items-center justify-center rounded-full transition-opacity disabled:opacity-20"
            style={{ background: "rgba(0,0,0,0.45)" }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
          </button>
          {generations.length <= 8 ? generations.map((_, i) => (
            <button
              key={i}
              onClick={(e) => { e.stopPropagation(); goToGen(i); }}
              className={`rounded-full transition-all ${i === currentGenIdx ? "w-3 h-1.5 bg-white" : "w-1.5 h-1.5 bg-white/40 hover:bg-white/70"}`}
            />
          )) : (
            <span className="text-[10px] text-white/60 font-mono tabular-nums">
              {currentGenIdx + 1} / {generations.length}
            </span>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); goToGen(currentGenIdx + 1); }}
            disabled={currentGenIdx === generations.length - 1}
            className="absolute right-0 w-7 h-7 flex items-center justify-center rounded-full transition-opacity disabled:opacity-20"
            style={{ background: "rgba(0,0,0,0.45)" }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
          </button>
        </div>
      )}

      {/* ── Video lightbox ───────────────────────────────────────────── */}
      {lightboxOpen && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center transition-opacity duration-200 ease-in-out"
          style={{ backgroundColor: `rgba(0,0,0,${lightboxVisible ? 0.9 : 0})`, opacity: lightboxVisible ? 1 : 0 }}
          onClick={closeLightbox}
        >
          <div
            className="relative transition-all duration-200 ease-in-out rounded-2xl overflow-hidden"
            style={{ transform: lightboxVisible ? "scale(1)" : "scale(0.95)", boxShadow: "0 0 0 8px #3a3a3a" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              src={data.videoUrl as string}
              controls
              autoPlay
              loop
              playsInline
              className="block max-w-[90vw] max-h-[90vh]"
            />
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Pill({
  children, onClick, interactive = true, fullWidth = false, disabled = false,
}: {
  children: React.ReactNode; onClick?: () => void;
  interactive?: boolean; fullWidth?: boolean; disabled?: boolean;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onMouseDown={onClick ? (e: React.MouseEvent) => e.stopPropagation() : undefined}
      onClick={disabled ? undefined : onClick}
      disabled={disabled && Tag === "button" ? true : undefined}
      className={`flex items-center gap-1.5 rounded-full px-2.5 py-1.5 whitespace-nowrap shrink-0 ${fullWidth ? "w-full justify-between" : ""} ${disabled ? "opacity-40 cursor-not-allowed" : interactive && onClick ? "hover:brightness-125 transition-all cursor-pointer" : ""
        }`}
      style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", border: "1px solid rgba(255,255,255,0.07)" }}
    >
      {children}
    </Tag>
  );
}

function FloatMenu({ children, fullWidth = false, open }: { children: React.ReactNode; fullWidth?: boolean; open: boolean }) {
  const { visible, className } = useAnimatedPopup(open);
  if (!visible) return null;
  return (
    <div className={`absolute bottom-full left-0 mb-1.5 bg-[#111622] border border-[#222] rounded-xl overflow-hidden z-[1002] shadow-2xl ${className}`}>
      {children}
    </div>
  );
}

function FloatItem({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onClick}
      className={`w-full px-3 py-2 text-left text-[11px] hover:bg-[#141C28] transition-colors ${active ? "text-white font-medium" : "text-[#A0A0A0]"}`}
    >
      {children}
    </button>
  );
}

function AspectIcon({ ratio }: { ratio: string }) {
  const [w, h] = ratio === "16:9" ? [11, 7] : ratio === "9:16" ? [7, 11] : ratio === "2:3" ? [7, 11] : ratio === "3:2" ? [11, 7] : [9, 9];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="none" stroke="#666" strokeWidth="1.2">
      <rect x="0.6" y="0.6" width={w - 1.2} height={h - 1.2} rx="0.8" />
    </svg>
  );
}

function ChevronIcon({ open = false }: { open?: boolean }) {
  return (
    <svg width="7" height="7" viewBox="0 0 8 8" fill="none" stroke="#555" strokeWidth="1.5" strokeLinecap="round"
      className={`shrink-0 transition-transform duration-100 ${open ? "rotate-180" : ""}`}>
      <path d="M1 2.5 4 5.5 7 2.5" />
    </svg>
  );
}

function ToggleSwitch({ on, activeColor = "#4ade80" }: { on: boolean; activeColor?: string }) {
  return (
    <div className="relative shrink-0 rounded-full transition-colors" style={{ width: 32, height: 18, background: on ? "#3A3A3A" : "#2A2A2A" }}>
      <div className="absolute top-[3px] rounded-full transition-transform" style={{ width: 12, height: 12, background: on ? activeColor : "#555", transform: on ? "translateX(17px)" : "translateX(3px)" }} />
    </div>
  );
}


function VideoNodeIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <rect width="18" height="14" x="3" y="5" rx="2" />
      <path d="m16 10-4-2.5v5L16 10z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function PromptIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="white">
      <path d="M1.5 2h11v2H8.5v8H5.5V4H1.5V2z" />
    </svg>
  );
}

function VideoRefIcon() {
  return (
    <svg width="13" height="11" viewBox="0 0 14 12" fill="none" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="0.7" y="0.7" width="12.6" height="10.6" rx="1.3" />
      <path d="M5.5 4.5v3l3-1.5-3-1.5z" fill="white" stroke="none" />
    </svg>
  );
}

function FrameStartIcon() {
  return (
    <svg width="13" height="11" viewBox="0 0 14 12" fill="none" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="0.7" y="0.7" width="12.6" height="10.6" rx="1.3" />
      <path d="M4.5 6h5M7 4l2.5 2L7 8" />
    </svg>
  );
}

function FrameEndIcon() {
  return (
    <svg width="13" height="11" viewBox="0 0 14 12" fill="none" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="0.7" y="0.7" width="12.6" height="10.6" rx="1.3" />
      <path d="M9.5 6h-5M7 4 4.5 6 7 8" />
    </svg>
  );
}

function ResourceIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <circle cx="9" cy="9" r="2" fill="white" stroke="none" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </svg>
  );
}

function RefVideoIcon() {
  return (
    <svg width="13" height="11" viewBox="0 0 14 12" fill="none" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="0.7" y="0.7" width="12.6" height="10.6" rx="1.3" />
      <path d="M5.5 4.5v3l3-1.5-3-1.5z" fill="white" stroke="none" />
      <path d="M11.5 3v1.5M11.5 7.5v1.5" strokeWidth="1.1" />
    </svg>
  );
}

function AudioRefIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 5v4M4.5 3v8M7 4.5v5M9.5 3v8M12 5v4" />
    </svg>
  );
}

function CharacterIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7" cy="4.5" r="2.5" />
      <path d="M1.5 13c0-2.8 2.46-5 5.5-5s5.5 2.2 5.5 5" />
    </svg>
  );
}

function SrcFrameStartIcon() {
  return (
    <svg width="13" height="11" viewBox="0 0 14 12" fill="none" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="0.7" y="0.7" width="12.6" height="10.6" rx="1.3" />
      <path d="M4.5 6h5M7 4l2.5 2L7 8" />
    </svg>
  );
}

function SrcFrameEndIcon() {
  return (
    <svg width="13" height="11" viewBox="0 0 14 12" fill="none" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="0.7" y="0.7" width="12.6" height="10.6" rx="1.3" />
      <path d="M9.5 6h-5M7 4 4.5 6 7 8" />
    </svg>
  );
}

function SrcImagePickIcon() {
  return (
    <svg width="13" height="11" viewBox="0 0 14 12" fill="none" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="0.7" y="0.7" width="12.6" height="10.6" rx="1.3" />
      <circle cx="4.5" cy="4" r="1.2" fill="white" stroke="none" />
      <path d="m0.7 9 3.5-3.5 2.5 2.5 2-2 5 4" />
    </svg>
  );
}

function SrcVideoIcon() {
  return (
    <svg width="13" height="11" viewBox="0 0 14 12" fill="none" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="0.7" y="0.7" width="12.6" height="10.6" rx="1.3" />
      <path d="M5.5 4.5v3l3-1.5-3-1.5z" fill="white" stroke="none" />
    </svg>
  );
}

function SrcAudioIcon() {
  return (
    <svg width="12" height="11" viewBox="0 0 13 12" fill="none" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4v4M4.5 2v8M6.5 3.5v5M9 2v8M11 4v4" />
    </svg>
  );
}

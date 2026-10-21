"use client";
import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from "react";
import { useAnimatedPopup } from "@/lib/useAnimatedPopup";
import { createPortal } from "react-dom";
import GenerateButton from "@/components/nodes/GenerateButton";
import JobLogViewer from "@/components/JobLogViewer";
import Image from "next/image";
import { Handle, Position, NodeProps, Node, useUpdateNodeInternals } from "@xyflow/react";
import CornerResizer from "./CornerResizer";
import NodeActionBar from "./NodeActionBar";
import { useWorkflowStore, NodeData } from "@/lib/store";
import { resolveInputs } from "@/lib/executor";
import { useReadOnly } from "@/lib/readOnlyContext";
import { browserNotify, requestNotificationPermission } from "@/lib/browserNotify";

type GenerateNodeType = Node<NodeData, "generateNode">;

import { ShieldBan, Sparkles } from "lucide-react";
import { IMAGE_MODELS, AZURE_POPULAR_SIZES, validateAzureCustomSize } from "@/lib/modelConfig";
import { PROVIDERS, getModelProvider, setModelProvider, modelHasProviderChoice, enabledProvidersForModel, isModelReady, isModelEnabled, defaultModelId } from "@/lib/providers";
import { ProviderBrandIcon, NodeProviderIcon } from "@/components/ui/ProviderIcon";
import { useGeneratingBorderAnimation } from "@/lib/useGeneratingBorderAnimation";
import MissingInputWarning from "./MissingInputWarning";

// Derived from config — no hardcoding needed
const MODELS = IMAGE_MODELS.map((m) => ({ id: m.id, name: m.name, meta: m.provider }));
const MODEL_CAPS = Object.fromEntries(
  IMAGE_MODELS.map((m) => [m.id, {
    supportsImages: m.supportsImages,
    supportsQuality: m.supportsQuality,
    ratios: m.ratios,
    maxImages: m.maxImages,
    qualityOptions: m.apiInput.qualityOptions,
    qualityKey: m.apiInput.qualityKey,
    azureQualityOptions: m.azureQualityOptions,
    azureResolutionOptions: m.azureResolutionOptions,
  }])
);
const DEFAULT_CAPS = MODEL_CAPS["nano-banana-2"];

// ── Aspect ratios ─────────────────────────────────────────────────────────────

// (each model defines its own subset — see MODEL_CAPS above)

function ratioRect(value: string) {
  // "auto" doesn't have a fixed ratio — render as a square preview
  if (value === "auto") return { rw: 14, rh: 14, x: 3, y: 0 };
  const [w, h] = value.split(":").map(Number);
  const maxW = 20, maxH = 14;
  const scale = Math.min(maxW / w, maxH / h);
  const rw = Math.round(w * scale);
  const rh = Math.round(h * scale);
  return { rw, rh, x: Math.round((maxW - rw) / 2), y: Math.round((maxH - rh) / 2) };
}

// ── Status dot ────────────────────────────────────────────────────────────────

const STATUS_DOT: Record<string, string> = {
  idle: "bg-[#1E2840]",
  pending: "bg-gray-500",
  running: "bg-amber-400 animate-pulse",
  done: "bg-[#2DD4BF]",
  error: "bg-red-500",
};

/**
 * Replace @mentions with <<<image N>>> placeholders AND reorder imageUrls so
 * that imageUrls[N-1] always corresponds to <<<image N>>> in the prompt.
 *
 * Numbers are assigned by left-to-right appearance in the prompt, not by the
 * order images were connected. This ensures "<<<image 1>>>" always refers to
 * the first @tag the user typed, regardless of edge creation order.
 *
 * Algorithm:
 *  1. Find every @mention position using known labels (longest-first) then
 *     the "@Word #N" / "@word" fallback pattern.
 *  2. Sort all matches by position → assign <<<image 1>>>, <<<image 2>>>, …
 *  3. Build orderedUrls so orderedUrls[i] is the URL for <<<image i+1>>>.
 */
function resolveMentions(
  prompt: string,
  labels: string[],
  imageUrls: string[],
): { resolvedPrompt: string; orderedUrls: string[] } {
  if (!labels.length) return { resolvedPrompt: prompt, orderedUrls: imageUrls };

  type Span = { start: number; end: number; labelIdx: number | null };
  const spans: Span[] = [];
  const claimed = new Set<number>();

  // Pass 1 — find known-label matches (longest label first, case-insensitive)
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

  // Pass 2 — fallback: any remaining @Word #N or @word
  const fallback = /@\S+(?:\s+#\d+)?/g;
  let fm: RegExpExecArray | null;
  while ((fm = fallback.exec(prompt)) !== null) {
    if (!claimed.has(fm.index)) {
      spans.push({ start: fm.index, end: fm.index + fm[0].length, labelIdx: null });
      claimed.add(fm.index);
    }
  }

  // Sort spans by position in the prompt (left → right)
  spans.sort((a, b) => a.start - b.start);

  // No @mentions in prompt — pass all images through as-is
  if (spans.length === 0) return { resolvedPrompt: prompt, orderedUrls: imageUrls };

  // Assign orderedUrls in prompt appearance order; track per-span URL (null = unresolvable)
  const spanUrls: (string | null)[] = [];
  const usedIdxs = new Set<number>();

  for (const span of spans) {
    let url: string | null = null;
    if (span.labelIdx !== null && !usedIdxs.has(span.labelIdx) && imageUrls[span.labelIdx]) {
      url = imageUrls[span.labelIdx];
      usedIdxs.add(span.labelIdx);
    } else {
      const next = imageUrls.findIndex((_, j) => !usedIdxs.has(j));
      if (next !== -1) {
        url = imageUrls[next];
        usedIdxs.add(next);
      }
      // No fallback to imageUrls[0] — unresolvable @mentions stay as plain text
    }
    spanUrls.push(url);
  }

  const orderedUrls = spanUrls.filter((u): u is string => u !== null);

  // Build resolved prompt: spans with a URL become <<<image N>>>, others keep original text
  let resolvedPrompt = "";
  let lastEnd = 0;
  let imageNum = 1;
  for (let i = 0; i < spans.length; i++) {
    resolvedPrompt += prompt.slice(lastEnd, spans[i].start);
    if (spanUrls[i] !== null) {
      resolvedPrompt += `<<<image ${imageNum++}>>>`;
    } else {
      resolvedPrompt += prompt.slice(spans[i].start, spans[i].end);
    }
    lastEnd = spans[i].end;
  }
  resolvedPrompt += prompt.slice(lastEnd);

  return { resolvedPrompt, orderedUrls };
}

// ── Component ────────────────────────────────────────────────────────────────

export default function GenerateNode({ id, data, selected }: NodeProps<GenerateNodeType>) {
  const readOnly = useReadOnly();
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const updateNodeSize = useWorkflowStore((s) => s.updateNodeSize);
  const removeEdgesForHandle = useWorkflowStore((s) => s.removeEdgesForHandle);
  const flashEdgeError = useWorkflowStore((s) => s.flashEdgeError);
  const onNodesChange = useWorkflowStore((s) => s.onNodesChange);
  const addNode = useWorkflowStore((s) => s.addNode);
  const insertEdge = useWorkflowStore((s) => s.insertEdge);
  const addToast   = useWorkflowStore((s) => s.addToast);
  // Subscribed purely for re-render invalidation — isModelReady /
  // availableProvidersForModel read these from the store imperatively at
  // render time (lib/providers.ts).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const modelProviders = useWorkflowStore((s) => s.modelProviders);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const providerStatus = useWorkflowStore((s) => s.providerStatus);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const bindingsByModel = useWorkflowStore((s) => s.bindingsByModel);
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const debugMode = useWorkflowStore((s) => s.debugMode);
  const parentGroupSelected = useWorkflowStore((s) => {
    const self = s.nodes.find((n) => n.id === id);
    if (!self?.parentId) return false;
    return s.nodes.find((n) => n.id === self.parentId)?.selected ?? false;
  });
  const multiSelected = useWorkflowStore((s) => s.nodes.filter((n) => n.selected).length > 1);

  const updateNodeInternals = useUpdateNodeInternals();
  const cardRef = useRef<HTMLDivElement>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Instant hide on deselect
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

  const [hovering, setHovering] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const [ratioOpen, setRatioOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [azureQualityOpen, setAzureQualityOpen] = useState(false);
  const [azureResolutionOpen, setAzureResolutionOpen] = useState(false);
  const [azureCustomSizeOpen, setAzureCustomSizeOpen] = useState(false);
  const [customWidthDraft, setCustomWidthDraft] = useState(1024);
  const [customHeightDraft, setCustomHeightDraft] = useState(1024);
  const [customSizeError, setCustomSizeError] = useState<string | null>(null);
  const modelPopup = useAnimatedPopup(modelOpen && !data.imageUrl);
  const providerPopup = useAnimatedPopup(providerOpen);
  const ratioPopup = useAnimatedPopup(ratioOpen);
  const qualityPopup = useAnimatedPopup(qualityOpen);
  const azureQualityPopup = useAnimatedPopup(azureQualityOpen);
  const azureResolutionPopup = useAnimatedPopup(azureResolutionOpen);
  const [loading, setLoading] = useState(false);
  const [genCount, setGenCount] = useState(1);
  const [logOpen, setLogOpen] = useState(false);
  const [errorHandles, setErrorHandles] = useState<Set<string>>(new Set());
  const [hoveredHandle, setHoveredHandle] = useState<"prompt" | "image" | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxVisible, setLightboxVisible] = useState(false);
  const [lightboxImgLoaded, setLightboxImgLoaded] = useState(false);
  const [blurSrc, setBlurSrc] = useState<string | null>(null);
  const nodeImgRef = useRef<HTMLImageElement>(null);
  const controlBarRef = useRef<HTMLDivElement>(null);

  // ── Elevate the RF node z-index while any dropdown is open ──────────────────
  useEffect(() => {
    const rfNode = cardRef.current?.closest<HTMLElement>(".react-flow__node");
    if (!rfNode) return;
    const anyOpen = modelOpen || providerOpen || ratioOpen || qualityOpen || azureQualityOpen || azureResolutionOpen;
    if (anyOpen) {
      rfNode.style.zIndex = "10000";
    } else {
      rfNode.style.zIndex = "";
    }
    return () => { rfNode.style.zIndex = ""; };
  }, [modelOpen, providerOpen, ratioOpen, qualityOpen, azureQualityOpen]);

  useEffect(() => {
    const anyOpen = modelOpen || providerOpen || ratioOpen || qualityOpen || azureQualityOpen || azureResolutionOpen;
    if (!anyOpen) return;
    const handler = (e: MouseEvent) => {
      if (controlBarRef.current && !controlBarRef.current.contains(e.target as unknown as globalThis.Node)) {
        setModelOpen(false); setProviderOpen(false); setRatioOpen(false); setQualityOpen(false); setAzureQualityOpen(false); setAzureResolutionOpen(false); setAzureCustomSizeOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [modelOpen, providerOpen, ratioOpen, qualityOpen, azureQualityOpen]);

  // Reset the custom-size subpanel whenever the ratio dropdown itself closes
  useEffect(() => {
    if (!ratioOpen) { setAzureCustomSizeOpen(false); setCustomSizeError(null); }
  }, [ratioOpen]);

  const openLightbox = useCallback(() => {
    setLightboxImgLoaded(false);
    const imgEl = nodeImgRef.current;
    if (imgEl && imgEl.naturalWidth > 0) {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = imgEl.naturalWidth;
        canvas.height = imgEl.naturalHeight;
        canvas.getContext("2d")?.drawImage(imgEl, 0, 0);
        setBlurSrc(canvas.toDataURL());
      } catch {
        setBlurSrc(imgEl.currentSrc ?? null);
      }
    } else {
      setBlurSrc(null);
    }
    setLightboxOpen(true);
    requestAnimationFrame(() => setLightboxVisible(true));
  }, []);

  const closeLightbox = useCallback(() => {
    setLightboxVisible(false);
    setTimeout(() => setLightboxOpen(false), 220);
  }, []);

  // Close lightbox on Escape
  useEffect(() => {
    if (!lightboxOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") closeLightbox(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [lightboxOpen, closeLightbox]);

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
    const url = data.imageUrl as string | undefined;
    if (!url || isSaving) return;
    const filename = `image-${Date.now()}.png`;
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
  }, [data.imageUrl, isSaving]);

  const handleCancel = useCallback(() => {
    if (pendingTimerRef.current !== null) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    setLoading(false);
    const storeNode = useWorkflowStore.getState().nodes.find((n) => n.id === id);
    const gens = ((storeNode?.data?.generations as GenEntry[] | undefined) ?? [])
      .filter((g): g is string | { error: string } => g !== null);
    const newIdx = Math.max(0, gens.length - 1);
    const lastEntry = gens[newIdx];
    updateNodeData(id, {
      status: gens.length > 0 ? "done" : "idle",
      taskId: undefined,
      generations: gens,
      currentGenIdx: newIdx,
      imageUrl: typeof lastEntry === "string" ? lastEntry : undefined,
      errorMsg: undefined,
    });
  }, [id, updateNodeData]);

  const handleDeleteSlot = useCallback((idx: number) => {
    const storeNode = useWorkflowStore.getState().nodes.find((n) => n.id === id);
    const gens = ((storeNode?.data?.generations as GenEntry[] | undefined) ?? []);
    const next = gens.filter((_, i) => i !== idx);
    const newIdx = Math.max(0, Math.min(idx, next.length - 1));
    const newEntry = next[newIdx];
    updateNodeData(id, {
      generations: next,
      currentGenIdx: next.length > 0 ? newIdx : 0,
      status: next.length > 0 ? "done" : "idle",
      imageUrl: typeof newEntry === "string" ? newEntry : undefined,
    });
  }, [id, updateNodeData]);

  // Visibility toggles (declutter) — hidden models/providers are not offered
  // in the pickers and are never picked as a default. The store subscription
  // makes the node re-render when a toggle flips.
  const disabledModels = useWorkflowStore((s) => s.disabledModels);
  const disabledProviders = useWorkflowStore((s) => s.disabledProviders);
  const visibleModels = useMemo(
    () => MODELS.filter((m) => isModelEnabled(m.id, disabledModels)),
    [disabledModels],
  );

  // The model's fallback default skips hidden models (declutter).
  const model = (data.model as string) ?? defaultModelId(IMAGE_MODELS, "nano-banana-2", disabledModels);
  const caps = MODEL_CAPS[model] ?? DEFAULT_CAPS;
  const modelInfo = MODELS.find((m) => m.id === model) ?? MODELS[0];
  const quality = (data.quality as string) ?? "1k";
  const status = data.status ?? "idle";

  // Derived from the store at render (modelProviders subscribed above drives
  // re-render on pref change) — no effect-based state sync needed.
  const currentProvider = getModelProvider(model);
  const isAzureProvider = currentProvider === "azure";
  /** The backends offered for this model (the current one stays visible). */
  const providerChoices = useMemo(
    () => enabledProvidersForModel(model, disabledProviders, currentProvider),
    [model, disabledProviders, currentProvider],
  );
  // Design §3.4 readiness: hydrated store decides; pre-hydration passes (the
  // old `kieKeySet === null` semantics).
  const modelReady = isModelReady(model, currentProvider);

  const promptInfo = (() => {
    const promptEdge = edges.find((e) => e.target === id && e.targetHandle === "prompt");
    if (!promptEdge) return null;
    const promptNode = nodes.find((n) => n.id === promptEdge.source);
    const text = (promptNode?.data?.prompt as string) ?? "";
    const cfg = IMAGE_MODELS.find((m) => m.id === model);
    const hasImages = edges.some((e) => e.target === id && e.targetHandle === "image");
    const limit = (!hasImages && cfg?.textOnlyPromptMaxLength)
      ? cfg.textOnlyPromptMaxLength
      : (cfg?.apiInput.promptMaxLength ?? Infinity);
    return { len: text.length, limit, over: text.length > limit };
  })();
  const promptOverLimit = promptInfo?.over ?? false;

  // Azure gpt-image-2 lets the user pick a manual width/height instead of a ratio
  const allowAzureCustomSize = isAzureProvider && !!caps.azureResolutionOptions;

  // If current ratio isn't valid for this model, fall back to first valid ratio (or 1:1)
  const rawRatio = (data.aspectRatio as string) ?? "9:16";
  const aspectRatio = caps.ratios.includes(rawRatio) || (allowAzureCustomSize && rawRatio === "custom")
    ? rawRatio
    : (caps.ratios[0] ?? "1:1");

  // "auto" has no fixed pixel dimensions — treat as 1:1 for the CSS ratio
  const [rw, rh] = aspectRatio === "auto" ? [1, 1]
    : aspectRatio === "custom" ? [Number(data.azureCustomWidth) || 1024, Number(data.azureCustomHeight) || 1024]
    : aspectRatio.split(":").map(Number);
  const cssRatio = `${rw} / ${rh}`;
  const isPending = status === "pending";
  const animBusy = loading || status === "running";
  const busy = animBusy || isPending;
  const isQueued = !busy && !!data.pipelineQueued;
  const idleCaption = (() => {
    const parts: string[] = [];
    if (caps.ratios.length > 0 || aspectRatio === "custom") {
      parts.push(
        aspectRatio === "custom"
          ? `${(data.azureCustomWidth as number | undefined) ?? 1024}×${(data.azureCustomHeight as number | undefined) ?? 1024}`
          : aspectRatio.toUpperCase(),
      );
    }
    if (caps.azureQualityOptions && isAzureProvider) {
      parts.push(((data.azureQuality as string | undefined) ?? "auto").toUpperCase());
    } else if (caps.supportsQuality && quality) {
      parts.push(quality.toUpperCase());
    }
    return parts.join(" · ") || "IMAGE";
  })();
  // The job the run log shows: the live task while it runs, the last one
  // after it settled (`lastTaskId` outlives `taskId`, which is cleared on
  // settle). Read-only — it never touches the node's status machine.
  const logTaskId = (data.taskId as string | undefined) ?? (data.lastTaskId as string | undefined);
  useGeneratingBorderAnimation(cardRef, animBusy);

  const [natW, natH] = (() => {
    const r = data.imageNaturalRatio as string | undefined;
    if (!r) return [0, 0];
    const parts = r.split("/").map((s) => parseInt(s.trim(), 10));
    return parts.length === 2 ? parts : [0, 0];
  })();

  // ── Generation history ────────────────────────────────────────────────────
  type GenEntry = string | null | { error: string };
  const rawGens = data.generations;
  const generations: GenEntry[] = Array.isArray(rawGens)
    ? (rawGens as GenEntry[])
    : (data.imageUrl ? [data.imageUrl as string] : []);
  const currentGenIdx = Math.min(
    (data.currentGenIdx as number | undefined) ?? Math.max(0, generations.length - 1),
    Math.max(0, generations.length - 1)
  );

  const slideDir = useRef<"left" | "right">("right");

  const goToGen = useCallback((idx: number) => {
    const storeNode = useWorkflowStore.getState().nodes.find(n => n.id === id);
    const gens: GenEntry[] = Array.isArray(storeNode?.data?.generations)
      ? storeNode!.data.generations as GenEntry[]
      : generations;
    const curr = (storeNode?.data?.currentGenIdx as number | undefined) ?? 0;
    const clamped = Math.max(0, Math.min(gens.length - 1, idx));
    slideDir.current = idx > curr ? "right" : "left";
    const entry = gens[clamped];
    if (entry === null) {
      updateNodeData(id, { currentGenIdx: clamped, imageUrl: undefined, status: "running", errorMsg: undefined });
    } else if (typeof entry === "object") {
      updateNodeData(id, { currentGenIdx: clamped, imageUrl: undefined, status: "error", errorMsg: entry.error });
    } else {
      updateNodeData(id, { currentGenIdx: clamped, imageUrl: entry, status: "done", errorMsg: undefined });
    }
  }, [id, updateNodeData, generations]);

  // Probe original URL for true pixel dimensions (Next.js Image serves a reduced copy)
  useEffect(() => {
    const url = data.imageUrl as string | undefined;
    if (!url) return;
    let cancelled = false;
    const img = new window.Image();
    img.onload = () => {
      if (!cancelled) updateNodeData(id, { imageNaturalRatio: `${img.naturalWidth} / ${img.naturalHeight}` });
    };
    img.src = url;
    return () => { cancelled = true; };
  }, [data.imageUrl, id, updateNodeData]);

  // Re-sync edge anchor positions on every resize — including during CSS transitions
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

  const closeDropdowns = () => {
    setModelOpen(false);
    setRatioOpen(false);
    setQualityOpen(false);
    setAzureQualityOpen(false);
    setLogOpen(false);
  };

  // ── Poll /api/job-status while a taskId is pending ──────────────────────────
  useEffect(() => {
    const taskId = data.taskId as string | undefined;
    if (!taskId || status !== "running") return;

    let cancelled = false;

    const doPoll = async () => {
      try {
        const res = await fetch(`/api/job-status?taskId=${taskId}`);
        const json = await res.json();
        if (cancelled) return;

        if (json.status === "done") {
          const storeNode = useWorkflowStore.getState().nodes.find(n => n.id === id);
          const gens = [...((storeNode?.data?.generations as GenEntry[] | undefined) ?? [])] as GenEntry[];
          const slot = storeNode?.data?.currentGenIdx as number ?? gens.length - 1;
          gens[slot] = json.imageUrl as string;
          updateNodeData(id, { status: "done", imageUrl: json.imageUrl, taskId: undefined, generations: gens, currentGenIdx: slot });
          clearInterval(interval);
          document.removeEventListener("visibilitychange", onVisible);
          browserNotify("Node complete", (data.label as string | undefined) ?? "Image generated");
        } else if (json.status === "error") {
          const storeNode = useWorkflowStore.getState().nodes.find(n => n.id === id);
          const gens = [...((storeNode?.data?.generations as GenEntry[] | undefined) ?? [])] as GenEntry[];
          const slot = storeNode?.data?.currentGenIdx as number ?? gens.length - 1;
          gens[slot] = { error: json.error ?? "Generation failed" };
          updateNodeData(id, { status: "error", errorMsg: json.error, taskId: undefined, generations: gens, currentGenIdx: slot });
          clearInterval(interval);
          document.removeEventListener("visibilitychange", onVisible);
          browserNotify("Node failed", json.error ?? "Generation failed");
        } else if (json.status === "not_found") {
          const storeNode = useWorkflowStore.getState().nodes.find(n => n.id === id);
          const gens = [...((storeNode?.data?.generations as GenEntry[] | undefined) ?? [])] as GenEntry[];
          const slot = storeNode?.data?.currentGenIdx as number ?? gens.length - 1;
          gens[slot] = { error: "Job expired or unknown" };
          updateNodeData(id, { status: "error", errorMsg: "Job expired or unknown", taskId: undefined, generations: gens, currentGenIdx: slot });
          clearInterval(interval);
          document.removeEventListener("visibilitychange", onVisible);
          browserNotify("Node failed", "Job expired or unknown");
        }
        // "pending" → keep polling
      } catch {
        // network hiccup — keep polling
      }
    };

    const interval = setInterval(doPoll, 3000);

    // When tab becomes visible again, poll immediately instead of waiting for the throttled interval
    const onVisible = () => { if (!document.hidden) doPoll(); };
    document.addEventListener("visibilitychange", onVisible);

    return () => { cancelled = true; clearInterval(interval); document.removeEventListener("visibilitychange", onVisible); };
  }, [data.taskId, status, id, updateNodeData]);

  const promptConnected = edges.some((e) => e.target === id && e.targetHandle === "prompt");
  const imageConnected = edges.some((e) => e.target === id && e.targetHandle === "image");
  const sourceConnected = edges.some((e) => e.source === id);
  const hasFailedImageInput = edges.some(
    (e) => e.target === id && e.targetHandle === "image" &&
      (nodes.find((n) => n.id === e.source)?.data?.status as string | undefined) === "error"
  );

  // ── Submit generation job ────────────────────────────────────────────────────
  const connectedPromptNodeId = edges.find(
    (e) => e.target === id && e.targetHandle === "prompt"
  )?.source;

  const generate = useCallback(async () => {
    requestNotificationPermission();
    const accessToken = "guest";

    // Extract frames from VideoInputNodes on the image handle that lack a capturedFrameUrl.
    // Uses trimEnd if set (end frame), otherwise trimStart ?? 0 (start / first frame).
    const videoImageEdges = edges.filter(
      (e) => e.target === id && e.targetHandle === "image" &&
        nodes.find((n) => n.id === e.source)?.type === "videoInputNode"
    );
    for (const edge of videoImageEdges) {
      const src = nodes.find((n) => n.id === edge.source);
      if (!src || (src.data.capturedFrameUrl as string | undefined)) continue;
      const videoUrl = (src.data.videoUrl ?? src.data.r2Url) as string | undefined;
      if (!videoUrl || videoUrl.startsWith("blob:")) continue;
      const trimStart = src.data.trimStart as number | undefined;
      const trimEnd = src.data.trimEnd as number | undefined;
      const extractBody = trimEnd !== undefined
        ? { videoUrl, timeSeconds: trimEnd }
        : { videoUrl, timeSeconds: trimStart ?? 0 };
      try {
        const r = await fetch("/api/extract-frame", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify(extractBody),
        });
        const j = await r.json();
        if (j.cdnUrl) updateNodeData(src.id, { capturedFrameUrl: j.cdnUrl });
      } catch { /* proceed without */ }
    }

    // Block if any wired image source has no output yet
    {
      const emptyImageEdges = edges.filter((e) => e.target === id && e.targetHandle === "image").filter((e) => {
        const src = useWorkflowStore.getState().nodes.find((n) => n.id === e.source);
        if (!src) return true;
        const url = (src.data.capturedFrameUrl ?? src.data.r2Url ?? src.data.inputImage ?? src.data.imageUrl) as string | undefined;
        return !url;
      });
      if (emptyImageEdges.length > 0) {
        setErrorHandles(new Set(["image"]));
        setTimeout(() => setErrorHandles(new Set()), 1400);
        updateNodeData(id, { hasError: true });
        addToast("Some connected image inputs have no content yet.", "error");
        for (const e of emptyImageEdges) {
          const src = useWorkflowStore.getState().nodes.find((n) => n.id === e.source);
          if (src) updateNodeData(src.id, { hasError: true });
          flashEdgeError(e.id);
        }
        return;
      }
    }

    // Use fresh store state so any newly extracted frames are included
    const upstream = resolveInputs(id, useWorkflowStore.getState().nodes as Node<NodeData>[], edges);
    const { resolvedPrompt, orderedUrls } = resolveMentions(
      upstream.prompt ?? "",
      upstream.imageNodeLabels,
      upstream.imageUrls,
    );

    // Normalized payload — the server resolves the provider (explicit
    // providerId → model_bindings active row → kie default) and stages media
    // per its binding; no client-side azure/codex branching (design §4.1).
    const payload = {
      model,
      providerId: currentProvider,
      prompt: resolvedPrompt,
      imageUrls: orderedUrls,
      aspectRatio,
      // Effective quality tier for the selected provider: the Azure picker's
      // value when the Azure controls are active, else the model's own quality
      // (P5 generalizes this onto providerOverrides).
      quality: isAzureProvider ? ((data.azureQuality as string | undefined) ?? "auto") : quality,
      resolution: (data.azureResolution as string | undefined) ?? "1k",
      ...(aspectRatio === "custom"
        ? {
            customWidth: data.azureCustomWidth as number | undefined,
            customHeight: data.azureCustomHeight as number | undefined,
          }
        : {}),
    };

    if (!resolvedPrompt.trim()) {
      updateNodeData(id, { hasError: true });
      setErrorHandles(new Set(["prompt"]));
      setTimeout(() => setErrorHandles(new Set()), 1400);
      addToast("A prompt is required to generate an image.", "error");
      if (connectedPromptNodeId) {
        updateNodeData(connectedPromptNodeId, { hasError: true });
        const promptEdge = edges.find((e) => e.target === id && e.targetHandle === "prompt");
        if (promptEdge) flashEdgeError(promptEdge.id);
      }
      return;
    }

    if (debugMode) {
      setLoading(true);
      try {
        await fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, debugOnly: true }),
        });
        await new Promise((r) => setTimeout(r, 5000));
      } finally {
        setLoading(false);
      }
      return;
    }

    // Set PENDING state — gives user 3 seconds to cancel before the API call
    const prevGens = [...(((useWorkflowStore.getState().nodes.find(n => n.id === id)?.data?.generations) as GenEntry[] | undefined) ?? [])] as GenEntry[];
    const loadingGens = [...prevGens, null] as GenEntry[];
    updateNodeData(id, { status: "pending", imageUrl: undefined, imageNaturalRatio: undefined, errorMsg: undefined, taskId: undefined, generations: loadingGens, currentGenIdx: loadingGens.length - 1 });

    pendingTimerRef.current = setTimeout(async () => {
      pendingTimerRef.current = null;
      setLoading(true);
      updateNodeData(id, { status: "running" });
      try {
        const res = await fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify(payload),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error);

        // Both Kie and Azure now return { taskId } — polling useEffect handles the rest
        // `lastTaskId` keeps the id AFTER the job settles (the run log stays
        // readable); `taskId` keeps its existing lifecycle (cleared on settle).
        updateNodeData(id, { taskId: json.taskId, lastTaskId: json.taskId });
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        const storeNode = useWorkflowStore.getState().nodes.find(n => n.id === id);
        const gens = [...((storeNode?.data?.generations as GenEntry[] | undefined) ?? [])] as GenEntry[];
        const slot = storeNode?.data?.currentGenIdx as number ?? gens.length - 1;
        gens[slot] = { error: errMsg };
        updateNodeData(id, { status: "error", errorMsg: errMsg, generations: gens, currentGenIdx: slot });
      } finally {
        setLoading(false);
      }
    }, 3000);
  }, [id, nodes, edges, model, aspectRatio, quality, currentProvider, isAzureProvider, data.azureQuality, data.azureResolution, data.azureCustomWidth, data.azureCustomHeight, debugMode, connectedPromptNodeId, updateNodeData, flashEdgeError, addToast]);

  const handleGenerateBatch = useCallback(() => {
    generate();
    if (genCount <= 1) return;

    const state = useWorkflowStore.getState();
    const src = state.nodes.find((n) => n.id === id);
    if (!src) return;

    const nodeW = cardRef.current?.offsetWidth ?? 280;
    const nodeH = cardRef.current?.offsetHeight ?? 280;
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
          imageUrl: undefined,
          generations: [],
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

  // node-card has position:relative — handles and label position relative to it
  return (
    <div
      ref={cardRef}
      className={`node-card w-full${animBusy ? " node-generating" : ""}${isQueued ? " node-queued" : ""}${(data.hasError as boolean) ? " node-error-blink" : ""}`}
      style={{
        minWidth: 280,
        aspectRatio: (data.imageNaturalRatio as string | undefined) ?? cssRatio,
      }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => { setHovering(false); closeDropdowns(); }}
      onAnimationEnd={() => updateNodeData(id, { hasError: false })}
    >
      <CornerResizer minWidth={220} minHeight={80} keepAspectRatio={!!data.imageUrl} />
      <NodeActionBar
        visible={!!selected && !data.locked && !parentGroupSelected && !multiSelected && !readOnly}
        hasContent={!!data.imageUrl}
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
      <span className="node-above-label">{data.label as string}</span>
      {(!promptConnected || hasFailedImageInput) && status !== "running" && !data.locked && (
        <MissingInputWarning messages={[
          ...(!promptConnected ? ["A text node is required"] : []),
          ...(hasFailedImageInput ? ["The connected image input has no valid content"] : []),
        ]} />
      )}

      {/* ── Icon handles — centered as a group on the node's vertical middle ── */}
      {/* prompt sits above center; image sits below center */}
      <Handle
        type="target"
        position={Position.Left}
        id="prompt"
        style={{ top: caps.supportsImages ? "calc(50% - 16px)" : "50%" }}
        className={`node-handle-icon node-handle-icon-prompt${promptConnected ? " node-handle-connected" : ""}${errorHandles.has("prompt") ? " node-handle-error" : ""}`}
        onMouseEnter={() => setHoveredHandle("prompt")}
        onMouseLeave={() => setHoveredHandle(null)}
      >
        <PromptIcon />
      </Handle>

      {caps.supportsImages && (
        <Handle
          type="target"
          position={Position.Left}
          id="image"
          style={{ top: "calc(50% + 16px)" }}
          className={`node-handle-icon node-handle-icon-resource${imageConnected ? " node-handle-connected" : ""}${errorHandles.has("image") ? " node-handle-error" : ""}`}
          onMouseEnter={() => setHoveredHandle("image")}
          onMouseLeave={() => setHoveredHandle(null)}
        >
          <PhotoIcon />
        </Handle>
      )}

      {/* ── Handle tooltip ────────────────────────────────────────────── */}
      {hoveredHandle && (
        <div
          className="absolute pointer-events-none z-[1001] text-[10px] px-2.5 py-1 rounded-lg whitespace-nowrap shadow-xl"
          style={{
            top: hoveredHandle === "prompt"
              ? (caps.supportsImages ? "calc(50% - 16px)" : "50%")
              : "calc(50% + 16px)",
            left: 0,
            transform: "translate(calc(-100% - 34px), -50%)",
            background: "#1A1A1A",
            border: `1px solid ${hoveredHandle === "prompt" ? "#2DD4BF33" : "#fb923c33"}`,
            color: "#CCCCCC",
          }}
        >
          <span style={{ color: hoveredHandle === "prompt" ? "#2DD4BF" : "#fb923c" }} className="mr-1.5">●</span>
          {hoveredHandle === "prompt"
            ? "Text prompt"
            : caps.maxImages > 0
              ? `Reference image (up to ${caps.maxImages})`
              : "Reference image"
          }
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        style={{ top: "50%" }}
        className={`node-handle-icon node-handle-icon-out-image${sourceConnected ? " node-handle-connected" : ""}${(data.hasError as boolean) ? " node-handle-error" : ""}`}
        title="Image output"
      >
        <PhotoIcon />
      </Handle>

      {/* ── Full-card media container — all controls overlaid inside ── */}
      <div
        className="relative bg-[#2a2d35] group/gen"
        style={{
          aspectRatio: (data.imageNaturalRatio as string | undefined) ?? cssRatio,
          width: "100%",
          transition: "aspect-ratio 0.35s cubic-bezier(0.4, 0, 0.2, 1)",
        }}
        onDoubleClick={() => { if (data.imageUrl) openLightbox(); }}
      >
        {/* Clipped media layer */}
        <div className="absolute inset-0 overflow-hidden rounded-[8px] z-0">
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
          {generations.length > 0 ? (
            <div
              style={{
                display: "flex",
                height: "100%",
                transform: `translateX(${-currentGenIdx * 100}%)`,
                transition: "transform 320ms cubic-bezier(0.4, 0, 0.2, 1)",
                willChange: "transform",
              }}
            >
              {generations.map((entry, i) => (
                <div key={i} style={{ minWidth: "100%", height: "100%", position: "relative", flexShrink: 0 }}>
                  {entry === null ? (
                    <div className="absolute inset-0" style={{ background: "#2a2d35" }} />
                  ) : typeof entry === "object" && !Array.isArray(entry) ? (
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
                        onClick={(e) => { e.stopPropagation(); handleDeleteSlot(i); }}
                        className="flex items-center gap-1.5 h-7 px-3 rounded-full transition-all hover:bg-red-900/60"
                        style={{ background: "rgba(40,0,0,0.7)", backdropFilter: "blur(10px)", border: "1px solid rgba(200,50,50,0.35)" }}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="stroke-red-400">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14H6L5 6" />
                          <path d="M10 11v6M14 11v6" />
                          <path d="M9 6V4h6v2" />
                        </svg>
                        <span className="text-[11px] font-medium text-red-400">Delete</span>
                      </button>
                    </div>
                  ) : (
                    <Image
                      ref={i === currentGenIdx ? nodeImgRef : undefined}
                      src={entry as string}
                      alt="Generated"
                      fill
                      quality={30}
                      sizes="400px"
                      style={{ objectFit: "fill" }}
                      onLoad={i === currentGenIdx ? () => {
                        requestAnimationFrame(() => {
                          if (!cardRef.current) return;
                          const w = cardRef.current.offsetWidth;
                          const h = cardRef.current.offsetHeight;
                          if (w > 0 && h > 0) updateNodeSize(id, w, h);
                        });
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
              <p className="text-white text-[12px] font-semibold leading-snug">
                Oops! Something went wrong.
              </p>
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
          ) : !busy && !isQueued && !data.locked && !data.imageUrl ? (
            <IdleImageFrame caption={idleCaption} />
          ) : (
            <div className="w-full h-full" />
          )}
        </div>

        {natW > 0 && natH > 0 && (
          <div
            aria-hidden
            className="absolute top-1.5 right-2 pointer-events-none select-none z-30 tabular-nums px-1.5 py-0.5 rounded-full opacity-0 group-hover/gen:opacity-100 transition-opacity duration-150 node-slide-reveal"
            style={{ fontSize: 9, lineHeight: 1, color: "#fff", background: "#1a1a1a" }}
          >
            {natW} × {natH}
          </div>
        )}

        {/* ── Bottom floating controls ── */}
        <div
          ref={controlBarRef}
          className={`absolute bottom-0 left-0 right-0 flex items-end gap-2 px-2.5 pb-2.5 pt-1 z-[1001] transition-opacity duration-150 ${hovering || selected ? "opacity-100" : "opacity-0 pointer-events-none"}`}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* Pills — wrap freely */}
          <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">

          {/* Run log — read-only disclosure over the job's event trail */}
          {logTaskId && (
            <div className="relative shrink-0">
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); setLogOpen((o) => !o); }}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full transition-all hover:brightness-125"
                style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", border: "1px solid rgba(255,255,255,0.07)" }}
                title="Run log"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 4h16v16H4z" />
                  <path d="M8 9h8M8 13h8M8 17h5" />
                </svg>
                <span className="text-[11px] text-white/70">Run log</span>
              </button>
              {logOpen && (
                <div
                  className="absolute bottom-full left-0 mb-2 w-72 bg-[#111622] border border-[#1E2840] rounded-md overflow-hidden z-[1002] shadow-2xl"
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <div className="px-2.5 py-2">
                    <JobLogViewer taskId={logTaskId} maxHeight={200} />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Model pill */}
          <div className="relative shrink-0">
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => {
                if (data.imageUrl) return;
                setModelOpen((o) => !o); setRatioOpen(false); setQualityOpen(false);
              }}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full transition-all ${data.imageUrl ? "cursor-default" : "hover:brightness-125"}`}
              style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", border: "1px solid rgba(255,255,255,0.07)" }}
              title={data.imageUrl ? "Clear the image to change model" : undefined}
            >
              <span className="shrink-0 text-white/60" style={{ lineHeight: 0 }}>
                <NodeProviderIcon provider={modelInfo.meta} />
              </span>
              <span className={`text-[11px] transition-colors ${data.imageUrl ? "text-white/30" : "text-white/70"}`}>
                {modelInfo.name}
              </span>
              {!data.imageUrl && <ChevronIcon open={modelOpen} />}
            </button>
            {modelPopup.visible && (
              <div className={`absolute bottom-full left-0 mb-2 w-48 bg-[#111622] border border-[#1E2840] rounded-md overflow-hidden z-[1002] shadow-2xl ${modelPopup.className}`}>
                {[...new Set(visibleModels.map(m => m.meta))].map((provider, pi) => (
                  <Fragment key={provider}>
                    {pi > 0 && <div className="border-t border-white/[0.06] mx-2 my-0.5" />}
                    {visibleModels.filter(m => m.meta === provider).map(m => (
                      <button
                        key={m.id}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => {
                          const newCaps = MODEL_CAPS[m.id] ?? DEFAULT_CAPS;
                          const validRatio = newCaps.ratios.includes(aspectRatio) ? aspectRatio : "1:1";
                          const validQuality = newCaps.qualityOptions && !newCaps.qualityOptions.includes(quality as "1k" | "2k" | "4k")
                            ? newCaps.qualityOptions[0]
                            : quality;
                          updateNodeData(id, { model: m.id, aspectRatio: validRatio, quality: validQuality });
                          if (!newCaps.supportsImages) removeEdgesForHandle(id, "image");
                          setModelOpen(false);
                        }}
                        className={`w-full flex items-center gap-2 px-3 py-[7px] text-[11px] hover:bg-[#141C28] transition-colors ${model === m.id ? "text-white" : "text-[#A0A0A0]"}`}
                      >
                        <span className="shrink-0 text-white/50" style={{ lineHeight: 0 }}>
                          <NodeProviderIcon provider={m.meta} />
                        </span>
                        <span className="flex-1 text-left">{m.name}</span>
                        <span className="text-[#4A4A45]">{m.meta}</span>
                      </button>
                    ))}
                  </Fragment>
                ))}
              </div>
            )}
          </div>

          {/* Provider pill — only for models with more than one backend (e.g. GPT Image 2) */}
          {modelHasProviderChoice(model) && providerChoices.length >= 2 && (
            <div className="relative shrink-0">
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => { setProviderOpen((o) => !o); setModelOpen(false); setRatioOpen(false); setQualityOpen(false); }}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full hover:brightness-125 transition-all"
                style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", border: "1px solid rgba(255,255,255,0.07)" }}
                title="Provider"
              >
                <span className="flex items-center gap-1.5 text-[11px] text-white/70">
                  <ProviderBrandIcon id={currentProvider} size={11} />
                  {PROVIDERS.find((p) => p.id === currentProvider)?.label ?? "Kie.ai"}
                </span>
                <ChevronIcon open={providerOpen} />
              </button>
              {providerPopup.visible && (
                <div className={`absolute bottom-full left-0 mb-2 w-36 bg-[#111622] border border-[#1E2840] rounded-md overflow-hidden z-[1002] shadow-2xl ${providerPopup.className}`}>
                  {providerChoices.map((id) => {
                    const p = PROVIDERS.find((q) => q.id === id);
                    if (!p) return null;
                    return (
                    <button
                      key={p.id}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => { setModelProvider(model, p.id); setProviderOpen(false); }}
                      className={`w-full flex items-center gap-1.5 px-3 py-[7px] text-[11px] hover:bg-[#141C28] transition-colors ${currentProvider === p.id ? "text-white" : "text-[#A0A0A0]"}`}
                    >
                      <ProviderBrandIcon id={p.id} size={11} />
                      {p.label}
                    </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Ratio pill */}
          <div className="relative shrink-0">
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => { setRatioOpen((o) => !o); setModelOpen(false); setQualityOpen(false); }}
              className="flex items-center gap-1 px-2.5 py-1 rounded-full hover:brightness-125 transition-all"
              style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", border: "1px solid rgba(255,255,255,0.07)" }}
            >
              <span className="text-[11px] text-white/70 tabular-nums">
                {aspectRatio === "custom"
                  ? `${(data.azureCustomWidth as number | undefined) ?? 1024}×${(data.azureCustomHeight as number | undefined) ?? 1024}`
                  : aspectRatio}
              </span>
              <ChevronIcon open={ratioOpen} />
            </button>
            {ratioPopup.visible && (
              <div className={`absolute bottom-full left-0 mb-2 ${azureCustomSizeOpen ? "w-56" : "w-32"} bg-[#111622] border border-[#1E2840] rounded-md overflow-hidden z-[1002] shadow-2xl ${ratioPopup.className}`}>
                {!azureCustomSizeOpen ? (
                  <>
                    {caps.ratios.map((r) => {
                      const { rw: iw, rh: ih, x, y } = ratioRect(r);
                      const active = r === aspectRatio;
                      return (
                        <button
                          key={r}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={() => { updateNodeData(id, { aspectRatio: r }); setRatioOpen(false); }}
                          className={`w-full flex items-center gap-2.5 px-3 py-[7px] text-[11px] hover:bg-[#141C28] transition-colors ${active ? "text-white" : "text-[#A0A0A0]"}`}
                        >
                          <svg width="20" height="14" viewBox="0 0 20 14" className="shrink-0">
                            <rect x={x} y={y} width={iw} height={ih} rx="1" fill={active ? "#FFFFFF" : "none"} stroke={active ? "#FFFFFF" : "#5A5A55"} strokeWidth="1" />
                          </svg>
                          <span className="tabular-nums">{r}</span>
                        </button>
                      );
                    })}
                    {allowAzureCustomSize && (
                      <>
                        <div className="border-t border-white/[0.06] mx-2 my-0.5" />
                        <button
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={() => {
                            setCustomWidthDraft((data.azureCustomWidth as number | undefined) ?? 1024);
                            setCustomHeightDraft((data.azureCustomHeight as number | undefined) ?? 1024);
                            setCustomSizeError(null);
                            setAzureCustomSizeOpen(true);
                          }}
                          className={`w-full flex items-center gap-2.5 px-3 py-[7px] text-[11px] hover:bg-[#141C28] transition-colors ${aspectRatio === "custom" ? "text-white" : "text-[#A0A0A0]"}`}
                        >
                          <svg width="20" height="14" viewBox="0 0 20 14" className="shrink-0">
                            <rect x="2" y="1" width="16" height="12" rx="1" fill="none" stroke={aspectRatio === "custom" ? "#FFFFFF" : "#5A5A55"} strokeWidth="1" strokeDasharray="2 1.5" />
                          </svg>
                          <span className="flex-1 text-left">Custom…</span>
                        </button>
                      </>
                    )}
                  </>
                ) : (
                  <div className="p-2.5" onMouseDown={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-between mb-2">
                      <button
                        onClick={() => setAzureCustomSizeOpen(false)}
                        className="flex items-center gap-1 text-[10px] text-[#4A4A45] hover:text-white transition-colors"
                      >
                        <span aria-hidden>‹</span> Back
                      </button>
                      <span className="text-[9px] text-[#4A4A45] tracking-wider uppercase font-semibold">Custom size</span>
                    </div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <input
                        type="number"
                        value={customWidthDraft}
                        onChange={(e) => setCustomWidthDraft(Number(e.target.value))}
                        placeholder="Width"
                        className="w-full min-w-0 bg-[#0B0F17] border border-[#1E2840] rounded px-2 py-1 text-[11px] text-white tabular-nums focus:outline-none focus:border-[#3A4A6A]"
                      />
                      <span className="text-[#4A4A45] text-[11px] shrink-0">×</span>
                      <input
                        type="number"
                        value={customHeightDraft}
                        onChange={(e) => setCustomHeightDraft(Number(e.target.value))}
                        placeholder="Height"
                        className="w-full min-w-0 bg-[#0B0F17] border border-[#1E2840] rounded px-2 py-1 text-[11px] text-white tabular-nums focus:outline-none focus:border-[#3A4A6A]"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-1 mb-2">
                      {AZURE_POPULAR_SIZES.map((p) => (
                        <button
                          key={p.label}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={() => { setCustomWidthDraft(p.width); setCustomHeightDraft(p.height); setCustomSizeError(null); }}
                          className="text-[10px] text-[#A0A0A0] hover:text-white bg-[#0B0F17] hover:bg-[#141C28] rounded px-1.5 py-1 text-left transition-colors"
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                    {customSizeError && (
                      <div className="text-[10px] text-red-400 mb-2 leading-tight">{customSizeError}</div>
                    )}
                    <button
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        const err = validateAzureCustomSize(customWidthDraft, customHeightDraft);
                        if (err) { setCustomSizeError(err); return; }
                        updateNodeData(id, { aspectRatio: "custom", azureCustomWidth: customWidthDraft, azureCustomHeight: customHeightDraft });
                        setAzureCustomSizeOpen(false);
                        setRatioOpen(false);
                      }}
                      className="w-full text-center text-[11px] font-medium text-white bg-[#1E2840] hover:bg-[#26324A] rounded py-1.5 transition-colors"
                    >
                      Apply
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Quality pill */}
          {caps.supportsQuality && !(caps.azureQualityOptions && isAzureProvider) && (
            <div className="relative shrink-0">
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => { setQualityOpen((o) => !o); setModelOpen(false); setRatioOpen(false); setAzureQualityOpen(false); }}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full hover:brightness-125 transition-all"
                style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", border: "1px solid rgba(255,255,255,0.07)" }}
              >
                {caps.qualityKey === "resolution" && <span className="text-[11px] text-white/30">Res</span>}
                <span className="text-[11px] text-white/70 uppercase">{quality}</span>
                <ChevronIcon open={qualityOpen} />
              </button>
              {qualityPopup.visible && (
                <div className={`absolute bottom-full left-0 mb-2 w-36 bg-[#111622] border border-[#1E2840] rounded-md overflow-hidden z-[1002] shadow-2xl ${qualityPopup.className}`}>
                  {caps.qualityKey === "resolution" && (
                    <div className="px-3 py-1.5 border-b border-[#1C2436]">
                      <span className="text-[9px] text-[#4A4A45] tracking-wider uppercase font-semibold">Resolution</span>
                    </div>
                  )}
                  {[
                    { id: "1k", label: "1K", meta: "Standard" },
                    { id: "2k", label: "2K", meta: "High" },
                    { id: "4k", label: "4K", meta: "Maximum" },
                  ].filter((q) => !caps.qualityOptions || caps.qualityOptions.includes(q.id as "1k" | "2k" | "4k")).map((q) => (
                    <button
                      key={q.id}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => { updateNodeData(id, { quality: q.id }); setQualityOpen(false); }}
                      className={`w-full flex items-center justify-between px-3 py-[7px] text-[11px] hover:bg-[#141C28] transition-colors ${quality === q.id ? "text-white" : "text-[#A0A0A0]"}`}
                    >
                      <span className="uppercase font-medium">{q.label}</span>
                      <span className="text-[#4A4A45]">{q.meta}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Azure Quality pill */}
          {caps.azureQualityOptions && isAzureProvider && (
            <div className="relative shrink-0">
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => { setAzureQualityOpen((o) => !o); setModelOpen(false); setRatioOpen(false); setQualityOpen(false); setAzureResolutionOpen(false); }}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full hover:brightness-125 transition-all"
                style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", border: "1px solid rgba(255,255,255,0.07)" }}
                title="Quality (Azure Foundry)"
              >
                <span className="text-[11px] text-white/70 capitalize">
                  {(data.azureQuality as string | undefined) ?? "auto"}
                </span>
                <ChevronIcon open={azureQualityOpen} />
              </button>
              {azureQualityPopup.visible && (
                <div className={`absolute bottom-full left-0 mb-2 w-36 bg-[#111622] border border-[#1E2840] rounded-md overflow-hidden z-[1002] shadow-2xl ${azureQualityPopup.className}`}>
                  <div className="px-3 py-1.5 border-b border-[#1C2436]">
                    <span className="text-[9px] text-[#4A4A45] tracking-wider uppercase font-semibold">Azure Quality</span>
                  </div>
                  {[
                    { id: "auto", meta: "Model default" },
                    { id: "low", meta: "Faster, cheaper" },
                    { id: "medium", meta: "Balanced" },
                    { id: "high", meta: "Best quality" },
                  ].map((q) => {
                    const active = ((data.azureQuality as string | undefined) ?? "auto") === q.id;
                    return (
                      <button
                        key={q.id}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => { updateNodeData(id, { azureQuality: q.id }); setAzureQualityOpen(false); }}
                        className={`w-full flex items-center justify-between px-3 py-[7px] text-[11px] hover:bg-[#141C28] transition-colors ${active ? "text-white" : "text-[#A0A0A0]"}`}
                      >
                        <span className="capitalize font-medium">{q.id}</span>
                        <span className="text-[#4A4A45]">{q.meta}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Azure Resolution pill — shown alongside Azure Quality for gpt-image-2 */}
          {caps.azureResolutionOptions && isAzureProvider && (
            <div className="relative shrink-0">
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => { setAzureResolutionOpen((o) => !o); setModelOpen(false); setRatioOpen(false); setQualityOpen(false); setAzureQualityOpen(false); }}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full hover:brightness-125 transition-all"
                style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", border: "1px solid rgba(255,255,255,0.07)" }}
                title="Resolution (Azure)"
              >
                <span className="text-[11px] text-white/30">Res</span>
                <span className="text-[11px] text-white/70 uppercase">
                  {(data.azureResolution as string | undefined) ?? "1k"}
                </span>
                <ChevronIcon open={azureResolutionOpen} />
              </button>
              {azureResolutionPopup.visible && (
                <div className={`absolute bottom-full left-0 mb-2 w-36 bg-[#111622] border border-[#1E2840] rounded-md overflow-hidden z-[1002] shadow-2xl ${azureResolutionPopup.className}`}>
                  <div className="px-3 py-1.5 border-b border-[#1C2436]">
                    <span className="text-[9px] text-[#4A4A45] tracking-wider uppercase font-semibold">Resolution</span>
                  </div>
                  {[
                    { id: "1k", label: "1K", meta: "Standard" },
                    { id: "2k", label: "2K", meta: "High" },
                    { id: "4k", label: "4K", meta: "Maximum" },
                  ].map((r) => {
                    const active = ((data.azureResolution as string | undefined) ?? "1k") === r.id;
                    return (
                      <button
                        key={r.id}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => { updateNodeData(id, { azureResolution: r.id }); setAzureResolutionOpen(false); }}
                        className={`w-full flex items-center justify-between px-3 py-[7px] text-[11px] hover:bg-[#141C28] transition-colors ${active ? "text-white" : "text-[#A0A0A0]"}`}
                      >
                        <span className="uppercase font-medium">{r.label}</span>
                        <span className="text-[#4A4A45]">{r.meta}</span>
                      </button>
                    );
                  })}
                </div>
              )}
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
          {!readOnly && <GenerateButton onClick={handleGenerateBatch} busy={animBusy} disabled={promptOverLimit || !modelReady.ready || busy || hasFailedImageInput} warningMessages={hasFailedImageInput ? ["The connected image input has no valid content"] : undefined} />}
        </div>
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
              className={`rounded-full transition-all ${i === currentGenIdx ? "w-3 h-1.5 bg-white" : "w-1.5 h-1.5 bg-white/30 hover:bg-white/60"}`}
            />
          )) : (
            <span className="text-[10px] text-white/50 font-mono tabular-nums">
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

      {/* ── Lightbox — blur-up full-quality view on double-click ─────── */}
      {lightboxOpen && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center transition-opacity duration-200 ease-in-out"
          style={{ backgroundColor: `rgba(0,0,0,${lightboxVisible ? 0.9 : 0})`, opacity: lightboxVisible ? 1 : 0 }}
          onClick={closeLightbox}
        >
          <div
            className="relative transition-all duration-200 ease-in-out rounded-2xl overflow-hidden"
            style={{
              transform: lightboxVisible ? "scale(1)" : "scale(0.95)",
              boxShadow: "0 0 0 8px #3a3a3a",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Full-res image */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={data.imageUrl as string}
              alt="Full quality"
              className="block max-w-[90vw] max-h-[90vh] object-contain"
              onLoad={() => setLightboxImgLoaded(true)}
            />
            {/* Blur placeholder */}
            {blurSrc && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={blurSrc}
                alt=""
                aria-hidden
                className={`absolute inset-0 w-full h-full object-contain${lightboxImgLoaded ? "" : " lightbox-blur-pulse"}`}
                style={{
                  transform: "scale(1.05)",
                  opacity: lightboxImgLoaded ? 0 : undefined,
                  transition: lightboxImgLoaded ? "opacity 380ms ease" : undefined,
                  pointerEvents: "none",
                }}
              />
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function IdleImageFrame({ caption }: { caption: string }) {
  return (
    <div
      aria-hidden="true"
      className="w-full h-full flex flex-col items-center justify-center gap-2 px-3 pointer-events-none select-none"
    >
      <Sparkles
        size={18}
        strokeWidth={1.5}
        style={{ color: "#2DD4BF", opacity: 0.28, flexShrink: 0 }}
      />
      <span
        className="font-mono text-[11px] font-medium tracking-[0.08em] tabular-nums leading-none whitespace-nowrap"
        style={{ color: "#6A7080" }}
      >
        {caption}
      </span>
    </div>
  );
}

function PromptIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="white">
      <path d="M1.5 2h11v2H8.5v8H5.5V4H1.5V2z" />
    </svg>
  );
}

function PhotoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <circle cx="9" cy="9" r="2" fill="white" stroke="none" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="8" height="8" viewBox="0 0 8 8" fill="none"
      stroke="#5A5A55" strokeWidth="1.5" strokeLinecap="round"
      className={`shrink-0 transition-transform duration-100 ${open ? "rotate-180" : ""}`}
    >
      <path d="M1 2.5 4 5.5 7 2.5" />
    </svg>
  );
}


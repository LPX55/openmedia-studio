/**
 * P7a-1 — CUSTOM LOGICAL MODELS: the ONE server-side catalog resolver.
 *
 * The static catalog (`lib/modelConfig.ts`) is code; a user-created model lives
 * in the `custom_models` table. Generation controllers and the settings report
 * must never branch on "catalog vs custom" themselves: they call this module,
 * which merges both sources in one place (static catalog FIRST, then the row).
 *
 * SYNTHESIS RULE (critical): a custom row must produce a COMPLETE
 * `ImageModel` / `VideoModel`. Every absent field is filled from a NEUTRAL
 * base — NEVER from a real catalog entry (borrowing e.g. `gpt-image-2`'s
 * apiInput would silently send that backend's dialect to an unrelated model).
 * Adapters slice prompts with `model.apiInput.promptMaxLength` (azure.ts,
 * codex.ts) and the video route clamps with `apiInput.durationMin/Max`, so a
 * hole here is a runtime crash, not a cosmetic gap.
 *
 * SERVER-ONLY: imports `lib/guest/db` (SQLite). Client code gets the same
 * information through `GET /api/settings/providers` (`customModels`).
 */
import { IMAGE_MODELS, VIDEO_MODELS } from "../modelConfig";
import type { ImageModel, VideoModel } from "../modelConfig";
import {
  deleteCustomModelRow,
  getCustomModelRow,
  getCustomModelRows,
  upsertCustomModelRow,
} from "./db";
import type { CustomModelApiInput, CustomModelKind, CustomModelRecord } from "./db";

export type { CustomModelApiInput, CustomModelKind } from "./db";

// ── Neutral base values ──────────────────────────────────────────────────────
//
// Deliberately generic: they must never encode a real backend's dialect.
const NEUTRAL_ASPECT_RATIO_KEY = "aspect_ratio";
const NEUTRAL_PROMPT_MAX_LENGTH = 32000;
const NEUTRAL_RATIOS = ["1:1"] as const;
const NEUTRAL_PROVIDER_LABEL = "Custom";

export const CUSTOM_MODEL_KINDS = ["image", "video"] as const;

export function isCustomModelKind(v: unknown): v is CustomModelKind {
  return v === "image" || v === "video";
}

/** True when `id` belongs to the STATIC catalog (image or video). */
export function isCatalogModelId(id: string): boolean {
  return IMAGE_MODELS.some((m) => m.id === id) || VIDEO_MODELS.some((m) => m.id === id);
}

/**
 * The exact shape `GET /api/settings/providers` exposes in `customModels`
 * (P7a-5). Another lane codes against it in parallel — do not add keys.
 */
export interface CustomModelSpec {
  id: string;
  kind: CustomModelKind;
  label: string;
  supportsImages: boolean;
  maxImages: number;
  supportsQuality: boolean;
  ratios: string[];
  apiInput: CustomModelApiInput;
}

/** What `upsertCustomModel` accepts (the POST body, minus validation). */
export interface CustomModelInput {
  id: string;
  kind: CustomModelKind;
  label?: string;
  supportsImages?: boolean;
  maxImages?: number;
  supportsQuality?: boolean;
  ratios?: string[];
  apiInput?: Partial<CustomModelApiInput>;
}

// ── Row → spec / model synthesis ────────────────────────────────────────────

function specFromRecord(row: CustomModelRecord): CustomModelSpec {
  const a = row.apiInput;
  const apiInput: CustomModelApiInput = {
    aspectRatioKey: a.aspectRatioKey || NEUTRAL_ASPECT_RATIO_KEY,
    promptMaxLength: a.promptMaxLength > 0 ? a.promptMaxLength : NEUTRAL_PROMPT_MAX_LENGTH,
  };
  if (a.imageInputKey) apiInput.imageInputKey = a.imageInputKey;
  if (a.qualityKey) apiInput.qualityKey = a.qualityKey;
  if (a.qualityOptions?.length) apiInput.qualityOptions = [...a.qualityOptions];
  if (a.qualityMap && Object.keys(a.qualityMap).length) apiInput.qualityMap = { ...a.qualityMap };
  if (a.outputFormat) apiInput.outputFormat = a.outputFormat;
  if (typeof a.durationMin === "number") apiInput.durationMin = a.durationMin;
  if (typeof a.durationMax === "number") apiInput.durationMax = a.durationMax;
  if (a.extra) apiInput.extra = { ...a.extra };
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    supportsImages: row.supportsImages,
    maxImages: row.maxImages,
    supportsQuality: row.supportsQuality,
    ratios: row.ratios.length ? [...row.ratios] : [...NEUTRAL_RATIOS],
    apiInput,
  };
}

/** Builds a COMPLETE `ImageModel` from a row — neutral base, never a catalog entry. */
function buildImageModel(row: CustomModelRecord): ImageModel {
  const a = row.apiInput;
  return {
    id: row.id,
    // The static catalog uses apiId as the upstream model string; for a custom
    // model the binding's `upstreamModelId` is authoritative (registry merge),
    // so the id is the only honest default.
    apiId: row.id,
    name: row.label,
    provider: NEUTRAL_PROVIDER_LABEL,
    ratios: row.ratios.length ? [...row.ratios] : [...NEUTRAL_RATIOS],
    supportsImages: row.supportsImages,
    maxImages: row.maxImages,
    supportsQuality: row.supportsQuality,
    apiInput: {
      aspectRatioKey: a.aspectRatioKey || NEUTRAL_ASPECT_RATIO_KEY,
      promptMaxLength: a.promptMaxLength > 0 ? a.promptMaxLength : NEUTRAL_PROMPT_MAX_LENGTH,
      ...(a.imageInputKey ? { imageInputKey: a.imageInputKey } : {}),
      ...(a.qualityKey ? { qualityKey: a.qualityKey } : {}),
      ...(a.qualityMap ? { qualityMap: { ...a.qualityMap } } : {}),
      ...(a.qualityOptions ? { qualityOptions: [...a.qualityOptions] } : {}),
      ...(a.outputFormat ? { outputFormat: a.outputFormat } : {}),
      ...(a.extra ? { extra: { ...a.extra } } : {}),
    },
  };
}

/**
 * Builds a COMPLETE `VideoModel` from a row — neutral base, never a catalog
 * entry. `handles` MUST stay defined (an empty array, not absent): the kie
 * adapter discriminates video models with `model.handles !== undefined`
 * (kie.ts `isVideoModel`), so an absent field would route the model down the
 * IMAGE payload path.
 */
function buildVideoModel(row: CustomModelRecord): VideoModel {
  const a = row.apiInput;
  const ratios = row.ratios.length ? [...row.ratios] : [...NEUTRAL_RATIOS];
  return {
    id: row.id,
    apiId: row.id,
    name: row.label,
    provider: NEUTRAL_PROVIDER_LABEL,
    ratios,
    durations: [],
    defaultDuration: 0,
    defaultRatio: ratios[0] ?? NEUTRAL_RATIOS[0],
    handles: [],
    sound: false,
    apiInput: {
      aspectRatioKey: a.aspectRatioKey || NEUTRAL_ASPECT_RATIO_KEY,
      durationKey: "duration",
      durationMin: typeof a.durationMin === "number" ? a.durationMin : 0,
      durationMax: typeof a.durationMax === "number" ? a.durationMax : 0,
      resolutionKey: "resolution",
      promptMaxLength: a.promptMaxLength > 0 ? a.promptMaxLength : NEUTRAL_PROMPT_MAX_LENGTH,
      ...(a.extra ? { extra: { ...a.extra } } : {}),
    },
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** All custom models (synthesized) — optionally narrowed to one kind. */
export function getCustomModels(kind: "image"): ImageModel[];
export function getCustomModels(kind: "video"): VideoModel[];
export function getCustomModels(kind: CustomModelKind): Array<ImageModel | VideoModel>;
export function getCustomModels(): Array<ImageModel | VideoModel>;
export function getCustomModels(kind?: CustomModelKind): Array<ImageModel | VideoModel> {
  const rows = getCustomModelRows();
  return rows
    .filter((r) => (kind ? r.kind === kind : true))
    .map((r) => (r.kind === "video" ? buildVideoModel(r) : buildImageModel(r)));
}

/** The `customModels` report array (P7a-5) — non-secret, kind-tagged. */
export function getCustomModelSpecs(): CustomModelSpec[] {
  return getCustomModelRows().map(specFromRecord);
}

/** One custom model spec, or `null` when the id is unknown. */
export function getCustomModelSpec(id: string): CustomModelSpec | null {
  const row = getCustomModelRow(id);
  return row ? specFromRecord(row) : null;
}

// ── Resolution (static catalog FIRST, then the custom row) ──────────────────

/** Resolve an image model: static `IMAGE_MODELS` first, then the custom row. */
export function resolveImageModel(id: string): ImageModel | null {
  const catalog = IMAGE_MODELS.find((m) => m.id === id);
  if (catalog) return catalog;
  const row = getCustomModelRow(id);
  if (!row || row.kind !== "image") return null;
  return buildImageModel(row);
}

/** Resolve a video model: static `VIDEO_MODELS` first, then the custom row. */
export function resolveVideoModel(id: string): VideoModel | null {
  const catalog = VIDEO_MODELS.find((m) => m.id === id);
  if (catalog) return catalog;
  const row = getCustomModelRow(id);
  if (!row || row.kind !== "video") return null;
  return buildVideoModel(row);
}

/**
 * Kind-aware resolution — the single call site generation routes use.
 * Returns `null` when neither the static catalog nor a custom row of that
 * kind knows the id (the route decides the 400).
 */
export function getModelCfg(id: string, kind: CustomModelKind): ImageModel | VideoModel | null {
  return kind === "video" ? resolveVideoModel(id) : resolveImageModel(id);
}

// ── Writes ──────────────────────────────────────────────────────────────────

function normalizeApiInput(
  raw: Partial<CustomModelApiInput> | undefined,
  kind: CustomModelKind,
): CustomModelApiInput {
  const out: CustomModelApiInput = {
    aspectRatioKey:
      typeof raw?.aspectRatioKey === "string" && raw.aspectRatioKey.trim()
        ? raw.aspectRatioKey.trim()
        : NEUTRAL_ASPECT_RATIO_KEY,
    promptMaxLength:
      typeof raw?.promptMaxLength === "number" && Number.isFinite(raw.promptMaxLength) && raw.promptMaxLength > 0
        ? Math.floor(raw.promptMaxLength)
        : NEUTRAL_PROMPT_MAX_LENGTH,
  };
  if (typeof raw?.imageInputKey === "string" && raw.imageInputKey.trim()) {
    out.imageInputKey = raw.imageInputKey.trim();
  }
  if (typeof raw?.qualityKey === "string" && raw.qualityKey.trim()) {
    out.qualityKey = raw.qualityKey.trim();
  }
  if (Array.isArray(raw?.qualityOptions)) {
    const opts = raw.qualityOptions
      .filter((x): x is string => typeof x === "string" && !!x.trim())
      .map((x) => x.trim());
    if (opts.length) out.qualityOptions = opts;
  }
  if (raw?.qualityMap && typeof raw.qualityMap === "object" && !Array.isArray(raw.qualityMap)) {
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.qualityMap)) {
      if (typeof v === "string") map[k] = v;
    }
    if (Object.keys(map).length) out.qualityMap = map;
  }
  if (typeof raw?.outputFormat === "string" && raw.outputFormat.trim()) {
    out.outputFormat = raw.outputFormat.trim();
  }
  // Duration bounds only mean anything for video rows (generate-video route /
  // kie adapter clamp with them); an image row silently drops them.
  if (kind === "video") {
    if (typeof raw?.durationMin === "number" && Number.isFinite(raw.durationMin)) out.durationMin = raw.durationMin;
    if (typeof raw?.durationMax === "number" && Number.isFinite(raw.durationMax)) out.durationMax = raw.durationMax;
  }
  if (raw?.extra && typeof raw.extra === "object" && !Array.isArray(raw.extra)) {
    out.extra = { ...(raw.extra as Record<string, unknown>) };
  }
  return out;
}

/**
 * Creates or updates a custom model (POST /api/settings/providers).
 *
 * Normalises every absent field to the neutral base and returns the exact
 * report spec. Validation that needs a 400 (bad kind, missing id, catalog
 * collision) lives in the route; this throws only on programmer error.
 */
export function upsertCustomModel(input: CustomModelInput): CustomModelSpec {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id) throw new Error("upsertCustomModel: id is required");
  if (!isCustomModelKind(input.kind)) {
    throw new Error(`upsertCustomModel: kind must be "image" or "video" (got ${String(input.kind)})`);
  }
  const kind = input.kind;
  const label = typeof input.label === "string" && input.label.trim() ? input.label.trim() : id;
  const ratios = Array.isArray(input.ratios)
    ? input.ratios.filter((r): r is string => typeof r === "string" && !!r.trim()).map((r) => r.trim())
    : [];
  const maxImages =
    typeof input.maxImages === "number" && Number.isFinite(input.maxImages) && input.maxImages > 0
      ? Math.floor(input.maxImages)
      : 0;
  const record: Omit<CustomModelRecord, "createdAt" | "updatedAt"> = {
    id,
    kind,
    label,
    supportsImages: !!input.supportsImages,
    maxImages,
    supportsQuality: !!input.supportsQuality,
    ratios: ratios.length ? ratios : [...NEUTRAL_RATIOS],
    apiInput: normalizeApiInput(input.apiInput, kind),
  };
  upsertCustomModelRow(record);
  return specFromRecord({ ...record, createdAt: null, updatedAt: null });
}

/**
 * Deletes a custom model AND its `model_bindings` rows (P7a-1 cascade).
 * Deleting the row alone would leave bindings pointing at an unresolvable id.
 */
export function deleteCustomModel(id: string): void {
  const trimmed = typeof id === "string" ? id.trim() : "";
  if (!trimmed) return;
  deleteCustomModelRow(trimmed);
}

/**
 * Shared SOURCE-VALUE resolver for the adapter families.
 *
 * Opened for P7b (HF Spaces / Gradio): the "normalized source → value" switch
 * below used to live inline in `openaiCompat.ts`; the gradio family resolves
 * its positional `data[]` slots through the SAME resolver, so the switched
 * semantics get exactly one home (compat-plan §a: one dialect, one parser;
 * P7 plan rev-2 P7a-3: "implemented in the shared source resolver, not
 * re-invented per adapter").
 *
 * `openaiCompat.ts` keeps only its DIALECT layer (paramMap field shaping,
 * value maps, video body assembly) and imports the resolver from here. The
 * gradio family (P7b) consumes it per positional slot: every source of the
 * union below may feed a `data[]` index, and the single-file slots
 * ("startFrame" / "endFrame" / "videoRef" / referenceAt(index)) exist
 * precisely so one positional file position can be expressed (vanilla
 * compat-map's "references" is a list — it cannot express a lone slot).
 *
 * SERVER-ONLY (adapter shared module — the eslint wall keeps adapters out of
 * client bundles).
 */
import type { CompatFieldSource, ReferenceAtSource } from "../bindings";
import type { GenerateInput, StagedMedia } from "../types";

/**
 * The staged URL of one media item (the passthrough URL, or the original).
 *
 * For the gradio family this value is what a `fileInputs` slot wraps into a
 * `{"path": …, "meta": {"_type": "gradio.FileData"}}` dict: the stager has
 * already run, so the string is either a public http(s) URL or the Space's
 * uploaded `/tmp/gradio/…` path (mediaStager.ts "remote-url" branch) — both
 * valid `path` contents for the slot-shaped data array.
 */
export function stagedUrlOf(media: StagedMedia | undefined): string | undefined {
  return media?.url ?? media?.originalUrl;
}

/**
 * The staged reference URLs, in order (for the list-shaped "references"
 * source).
 */
export function referenceUrls(input: GenerateInput): string[] {
  const refs = input.media.references ?? [];
  return refs.map((r) => stagedUrlOf(r)).filter((u): u is string => !!u);
}

/**
 * The ONE staged reference at the given 0-based index — the single-slot
 * counterpart of `referenceUrls` (undefined when the index does not exist).
 */
function referenceAt(input: GenerateInput, source: ReferenceAtSource): string | undefined {
  return stagedUrlOf((input.media.references ?? [])[source.index] as StagedMedia | undefined);
}

/**
 * Value of one normalized source. `undefined` ⇒ the field is NOT sent (the
 * dialect decides what the backend accepts — compat-plan §a: "per-model params
 * on needs basis only"). Gradio slots translate `undefined` into a literal
 * `null` on the OUTSIDE (a positional array must keep its shape) — that
 * translation is the CALLER's (gradio.ts), never this resolver's.
 */
export function resolveFieldValue(
  source: CompatFieldSource,
  input: GenerateInput,
): string | number | string[] | undefined {
  // The parameterized source is an OBJECT, not a string — dispatch it first
  // so the string switch below never needs to care.
  if (typeof source === "object" && source !== null) {
    if (source.kind === "referenceAt") return referenceAt(input, source);
    return undefined;
  }

  const p = input.params;
  switch (source) {
    case "prompt":
      return input.prompt;
    case "aspectRatio":
      return p.aspectRatio;
    case "tier":
      // The catalog's picker value ("1k" | "2k" | "4k" | "low" | …). The
      // route's `resolution` is the Azure-style tier — used as a fallback so
      // a client that sends the tier there still lands on the same field.
      return p.quality ?? p.resolution;
    case "quality":
      return p.quality;
    case "resolution":
      return p.resolution;
    case "size":
      return p.customWidth && p.customHeight
        ? `${p.customWidth}x${p.customHeight}`
        : undefined;
    case "width":
      return typeof p.customWidth === "number" ? p.customWidth : undefined;
    case "height":
      return typeof p.customHeight === "number" ? p.customHeight : undefined;
    case "seed":
      return typeof p.seed === "number" ? p.seed : undefined;
    case "references":
      return referenceUrls(input);
    case "outputFormat": {
      const apiInput = (input.model as { apiInput?: { outputFormat?: string } }).apiInput;
      return apiInput?.outputFormat;
    }
    // ── P7b single-file slots (plan rev-2, spike-fed) ────────────────────────
    // Each returns the staged media's URL-or-uploaded-path string for ONE
    // positional slot (wan2-1-fast's data[0] `input_image`, FLUX.1-Kontext's
    // `input_image`, ltx-video's `input_image_filepath` / `input_video_filepath`).
    case "startFrame":
      return stagedUrlOf(input.media.startFrame);
    case "endFrame":
      return stagedUrlOf(input.media.endFrame);
    case "videoRef":
      return stagedUrlOf(input.media.videoRef);
    default:
      return undefined;
  }
}

/** Apply a dialect value map (normalized value → upstream value). A map entry
 * of null means DROP the field (used for catalog sentinels like "auto" that
 * an endpoint's enum rejects — the server default applies instead). */
export function applyValueMap(
  valueMap: Record<string, string | null> | undefined,
  value: string | number | string[],
): string | number | string[] | undefined {
  if (!valueMap || typeof value !== "string") return value;
  if (!(value in valueMap)) return value;
  const mapped = valueMap[value];
  return mapped === null ? undefined : mapped;
}

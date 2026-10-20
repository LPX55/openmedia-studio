/**
 * Kie.ai adapter — design.md §1.3/§2 (Phase 4, P4b).
 *
 * - `uploadMedia` delegates to `lib/kieUpload.ts` (kept as-is; kie's temp-file
 *   store upload + per-process dedupe cache live there).
 * - `submit` carries the image createTask body builder and the 9-family video
 *   payload builders MOVED VERBATIM from `app/api/generate/route.ts:524-568`
 *   and `app/api/generate-video/route.ts:77-384` (incl. the Veo endpoint
 *   switch at the old :399-405). Input media arrives already staged by
 *   `mediaStager.ts` ("remote-url" ⇒ local `/generated/…`/`data:` inputs are
 *   kie temp URLs; already-remote URLs pass through per the pinned rule), so
 *   the builders' old `ensureR2()` normalization calls are dropped — the
 *   staging layer replaced them.
 * - `poll` is one tick of the standard `recordInfo` loop (ported from
 *   `lib/kieJobPoller.ts`), plus the C4 Veo family branch — see the comment on
 *   `poll()` for the documented fallback.
 */
import { ensureKieReachableImages, rewriteLocalMediaForKie } from "../../kieUpload";
import type { ImageModel, VideoModel } from "../../modelConfig";
import type { ProviderMeta } from "../../jobStore"; // C3-pinned shape — single source
import type {
  GenerateInput,
  GenerationProvider,
  PollOutcome,
  ProviderRuntimeConfig,
  StagedMedia,
  SubmitOutcome,
} from "../types";

const KIE_BASE = "https://api.kie.ai";
const CREATE = `${KIE_BASE}/api/v1/jobs/createTask`;

/** Interfaces mirrored from the old video route (moved verbatim). */
interface Resource {
  url: string;
  label: string;
}

interface KlingElementInput {
  name: string;
  description: string;
  imageUrls: string[];
}

function requireKey(cfg: ProviderRuntimeConfig): string {
  if (!cfg.apiKey) {
    // Same message the routes used to return with 401.
    throw new Error("No API key configured for this provider. Add one in Settings.");
  }
  return cfg.apiKey;
}

/** Staged URL for one input item (passthrough URL, or the kie temp upload). */
function stagedUrl(s: StagedMedia | undefined): string | undefined {
  return s?.url ?? s?.originalUrl;
}

function isVideoModel(m: ImageModel | VideoModel): m is VideoModel {
  return (m as VideoModel).handles !== undefined;
}

// ── Image: createTask body (moved from app/api/generate/route.ts:524-568) ────

function buildImageInput(input: GenerateInput, model: ImageModel): {
  endpoint: string;
  body: Record<string, unknown>;
  resolvedApiId: string;
} {
  const { apiInput } = model;
  const refs = input.media.references ?? [];
  const hasImages = refs.length > 0;

  // Dual-mode models (e.g. GPT Image 2): no input images ⇒ text-only variant.
  const resolvedApiId =
    !hasImages && input.binding.textOnlyUpstreamId ? input.binding.textOnlyUpstreamId : input.binding.upstreamModelId;

  const kieImageUrls = refs.map((r) => stagedUrl(r)!).slice(0, model.maxImages);
  const quality = input.params.quality ?? "1k";

  const imageInput: Record<string, unknown> = {
    prompt: input.prompt.slice(0, apiInput.promptMaxLength),
    [apiInput.aspectRatioKey]: input.params.aspectRatio,
  };
  if (apiInput.outputFormat) imageInput.output_format = apiInput.outputFormat;
  if (apiInput.imageInputKey && hasImages) imageInput[apiInput.imageInputKey] = kieImageUrls;
  if (apiInput.qualityKey) {
    imageInput[apiInput.qualityKey] = apiInput.qualityMap
      ? (apiInput.qualityMap[quality] ?? quality)
      : quality === "4k" ? "4K" : quality === "2k" ? "2K" : quality === "1k" ? "1K" : quality;
  }
  if (apiInput.extra) Object.assign(imageInput, apiInput.extra);

  // The app polls kie.ai directly — no callback URL.
  return { endpoint: CREATE, body: { model: resolvedApiId, callBackUrl: undefined, input: imageInput }, resolvedApiId };
}

// ── Video: 9-family payload builders (moved VERBATIM from
//    app/api/generate-video/route.ts:77-384; `ensureR2` normalization replaced
//    by pre-staged media) ────────────────────────────────────────────────────

function buildVideoPayload(input: GenerateInput, model: VideoModel): {
  endpoint: string;
  body: Record<string, unknown>;
  payloadInput: Record<string, unknown>;
  effectiveApiId: string;
} {
  const { apiInput } = model;
  const media = input.media;
  const extras = input.extras ?? {};

  const rawStartFrame = stagedUrl(media.startFrame);
  const rawEndFrame = stagedUrl(media.endFrame);
  const rawVideoRef = stagedUrl(media.videoRef);
  const rawRefImages = (media.references ?? []).map((r) => stagedUrl(r)!);
  const rawRefVideoUrls = (media.referenceVideos ?? []).map((r) => stagedUrl(r)!);
  const rawRefAudioUrls = (media.audioRefs ?? []).map((r) => stagedUrl(r)!);
  const resources = (media.resources ?? []).map((r) => ({
    url: stagedUrl(r.media)!,
    label: r.tag ?? "",
  }));
  const klingElements = (extras.klingElements as KlingElementInput[] | undefined) ?? [];
  const veoMode = extras.veoMode as string | undefined;
  const rawGenerationType = extras.generationType as string | undefined;
  // The app polls kie.ai directly — no callback URL unless the caller passed one.
  const callBackUrl = (extras.callBackUrl as string | undefined) || undefined;

  const prompt = input.prompt;
  const aspectRatio = input.params.aspectRatio ?? "16:9";
  const sound = input.params.sound ?? false;
  const seed = input.params.seed;
  const mode = input.params.mode ?? "pro";
  const resolution = input.params.resolution || model.defaultResolution || "480p";

  const isSeedance25EditModel = model.id === "seedance-2-5-edit";
  const effectiveAspectRatio = isSeedance25EditModel ? "adaptive" : aspectRatio;

  // Clamp duration to model limits (motion-control has no duration field)
  const clampedDuration = isSeedance25EditModel
    ? -1
    : apiInput.durationMax > 0
    ? Math.max(apiInput.durationMin, Math.min(apiInput.durationMax, Number(input.params.duration)))
    : 0;

  let payloadInput: Record<string, unknown>;
  let effectiveApiId = input.binding.upstreamModelId;
  const imageUpstreamId = input.binding.imageUpstreamId;

  if (apiInput.useMotionControl) {
    // ── Kling 2.6 motion control ──────────────────────────────────────────────
    // { prompt, input_urls, video_urls, mode, character_orientation }
    const inputImageUrl = rawStartFrame;
    const inputVideoUrl = rawVideoRef;

    payloadInput = {
      prompt:                prompt ?? "",
      input_urls:            inputImageUrl ? [inputImageUrl] : [],
      video_urls:            inputVideoUrl ? [inputVideoUrl] : [],
      mode:                  resolution,   // "720p" or "1080p"
      character_orientation: mode,         // "image" or "video"
    };
    if (apiInput.extra) Object.assign(payloadInput, apiInput.extra);

  } else if (apiInput.useMinimaxH3) {
    // ── MiniMax H3 (text / image / reference to video) ───────────────────────
    const startFrameUrl = rawStartFrame;
    const endFrameUrl = rawEndFrame;
    const r2RefImages = rawRefImages;
    const r2RefVideos = rawRefVideoUrls;
    const r2RefAudios = rawRefAudioUrls;

    if (startFrameUrl || endFrameUrl) {
      // image-to-video — frames take priority over references
      effectiveApiId = imageUpstreamId ?? effectiveApiId;
      payloadInput = {
        prompt:                 prompt ?? "",
        [apiInput.durationKey!]: clampedDuration,
      };
      if (startFrameUrl)          payloadInput[apiInput.firstFrameKey!] = startFrameUrl;
      if (endFrameUrl)            payloadInput[apiInput.lastFrameKey!]  = endFrameUrl;
      if (apiInput.resolutionKey) payloadInput[apiInput.resolutionKey]  = resolution;
    } else if (r2RefImages.length > 0) {
      // reference-to-video
      effectiveApiId = "minimax-h3/reference-to-video";
      payloadInput = {
        prompt:                     prompt ?? "",
        [apiInput.referenceImagesKey!]: r2RefImages.slice(0, 9),
        [apiInput.aspectRatioKey!]: aspectRatio,
        [apiInput.durationKey!]:    clampedDuration,
      };
      // reference_audio cannot be used alone — it always rides along with images here
      if (r2RefVideos.length > 0 && apiInput.referenceVideosKey) payloadInput[apiInput.referenceVideosKey] = r2RefVideos.slice(0, 3);
      if (r2RefAudios.length > 0 && apiInput.referenceAudiosKey) payloadInput[apiInput.referenceAudiosKey] = r2RefAudios.slice(0, 3);
      if (apiInput.resolutionKey) payloadInput[apiInput.resolutionKey] = resolution;
    } else {
      // text-to-video
      effectiveApiId = input.binding.upstreamModelId;
      payloadInput = {
        prompt:                     prompt ?? "",
        [apiInput.aspectRatioKey!]: aspectRatio,
        [apiInput.durationKey!]:    clampedDuration,
      };
      if (apiInput.resolutionKey) payloadInput[apiInput.resolutionKey] = resolution;
    }

  } else if (apiInput.firstFrameKey) {
    // ── Seedance-style models (separate frame keys + multi-ref arrays) ─────────
    const startFrameUrl = rawStartFrame;
    const endFrameUrl = rawEndFrame;
    const r2RefImages = rawRefImages;
    const r2RefVideos = rawRefVideoUrls;
    const r2RefAudios = rawRefAudioUrls;

    payloadInput = {
      [apiInput.aspectRatioKey!]: effectiveAspectRatio,
      [apiInput.durationKey!]:    clampedDuration,
    };

    if (prompt?.trim())                                        payloadInput.prompt                       = prompt;
    if (apiInput.firstFrameKey  && startFrameUrl)              payloadInput[apiInput.firstFrameKey]       = startFrameUrl;
    if (apiInput.lastFrameKey   && endFrameUrl)                payloadInput[apiInput.lastFrameKey]        = endFrameUrl;
    if (apiInput.resolutionKey)                                payloadInput[apiInput.resolutionKey]       = resolution;
    if (apiInput.soundKey)                                     payloadInput[apiInput.soundKey]            = Boolean(sound);
    // Seedance (and similar): first/last frames and reference images are mutually exclusive
    if (apiInput.referenceImagesKey && r2RefImages.length > 0 && !startFrameUrl && !endFrameUrl) payloadInput[apiInput.referenceImagesKey]  = r2RefImages;
    if (apiInput.referenceVideosKey && r2RefVideos.length > 0) payloadInput[apiInput.referenceVideosKey]  = r2RefVideos;
    if (apiInput.referenceAudiosKey && r2RefAudios.length > 0) payloadInput[apiInput.referenceAudiosKey]  = r2RefAudios;
    if (apiInput.extra)                                        Object.assign(payloadInput, apiInput.extra);

  } else if (apiInput.useHappyHorse) {
    // ── HappyHorse (Alibaba) — routes to text/image/reference endpoint ────────
    const refImageUrls = rawRefImages;
    const startFrameUrl = rawStartFrame;

    const maybeSeed = seed !== undefined && seed !== null && Number(seed) > 0 ? Number(seed) : undefined;

    if (refImageUrls.length > 0) {
      effectiveApiId = "happyhorse/reference-to-video";
      payloadInput = {
        prompt: prompt ?? "",
        reference_image: refImageUrls.slice(0, 9),
        [apiInput.aspectRatioKey!]: aspectRatio,
        [apiInput.durationKey!]:    clampedDuration,
      };
      if (apiInput.resolutionKey) payloadInput[apiInput.resolutionKey] = resolution;
      if (maybeSeed !== undefined && apiInput.seedKey) payloadInput[apiInput.seedKey] = maybeSeed;
    } else if (startFrameUrl) {
      effectiveApiId = "happyhorse/image-to-video";
      payloadInput = {
        image_urls:             [startFrameUrl],
        [apiInput.durationKey!]: clampedDuration,
      };
      if (prompt?.trim()) payloadInput.prompt = prompt;
      // resolution is determined by the input image — do not send it
      if (maybeSeed !== undefined && apiInput.seedKey) payloadInput[apiInput.seedKey] = maybeSeed;
    } else {
      effectiveApiId = "happyhorse/text-to-video";
      payloadInput = {
        prompt: prompt ?? "",
        [apiInput.aspectRatioKey!]: aspectRatio,
        [apiInput.durationKey!]:    clampedDuration,
      };
      if (apiInput.resolutionKey) payloadInput[apiInput.resolutionKey] = resolution;
      if (maybeSeed !== undefined && apiInput.seedKey) payloadInput[apiInput.seedKey] = maybeSeed;
    }

  } else if (apiInput.useKlingTurbo) {
    // ── Kling 3.0 Turbo (text-to-video / image-to-video) ─────────────────────
    const startFrameUrl = rawStartFrame;

    const durationValue = String(clampedDuration);

    if (startFrameUrl) {
      effectiveApiId = imageUpstreamId ?? effectiveApiId;
      payloadInput = {
        prompt:              prompt ?? "",
        image_urls:          [startFrameUrl],
        [apiInput.durationKey!]: durationValue,
        [apiInput.resolutionKey!]: resolution,
      };
    } else {
      effectiveApiId = input.binding.upstreamModelId;
      payloadInput = {
        prompt:                     prompt ?? "",
        [apiInput.aspectRatioKey!]: aspectRatio,
        [apiInput.durationKey!]:    durationValue,
        [apiInput.resolutionKey!]:  resolution,
      };
    }

  } else if (apiInput.useGoogleVeo) {
    // ── Google Veo 3.1 ───────────────────────────────────────────────────────
    const startFrameUrl = rawStartFrame;
    const endFrameUrl = rawEndFrame;
    const refImages = rawRefImages;

    const imageUrls: string[] = [];
    let generationType = "TEXT_2_VIDEO";

    // For veo3.1 lite, if an image is attached use: Image to video, just a text is attached, use text to video.
    // On the two other models (fast/quality), one more element is present: reference.
    const isLite = model.id === "veo3_lite";

    if (veoMode === "references" && !isLite) {
      generationType = "REFERENCE_2_VIDEO";
      if (refImages.length > 0) imageUrls.push(...refImages.slice(0, 3));
    } else {
      if (startFrameUrl || endFrameUrl) {
        generationType = "FIRST_AND_LAST_FRAMES_2_VIDEO";
        if (startFrameUrl) imageUrls.push(startFrameUrl);
        if (endFrameUrl) imageUrls.push(endFrameUrl);
      }
    }

    effectiveApiId = input.binding.upstreamModelId; // Use veo3, veo3_fast, or veo3_lite directly

    payloadInput = {
      prompt: prompt ?? "",
      generationType: rawGenerationType || generationType,
      [apiInput.aspectRatioKey!]: aspectRatio,
      [apiInput.resolutionKey!]: resolution,
      imageUrls: imageUrls,
      watermark: "",
      enableFallback: false,
      enableTranslation: true,
      callBackUrl,
    };
    if (apiInput.extra) Object.assign(payloadInput, apiInput.extra);

  } else if (apiInput.useGeminiOmniVideo) {
    // ── Gemini Omni Video (quota-based: image=1 slot, video=2 slots, max 7) ────
    const r2RefImages = rawRefImages;
    const r2RefVideos = rawRefVideoUrls.slice(0, 1);

    const videoSlots = r2RefVideos.length > 0 ? 2 : 0;
    const clampedImages = r2RefImages.slice(0, 7 - videoSlots);

    const maybeSeed = seed !== undefined && seed !== null && Number(seed) > 0 ? Number(seed) : undefined;

    payloadInput = { prompt: prompt ?? "" };
    if (clampedImages.length > 0) payloadInput.image_urls = clampedImages;
    if (r2RefVideos.length > 0)   payloadInput.video_list = r2RefVideos.map((url) => ({ url, start: 0, ends: 10 }));
    // duration is ignored by the model when video input is provided
    if (r2RefVideos.length === 0) payloadInput[apiInput.durationKey!] = String(clampedDuration);
    if (apiInput.aspectRatioKey)  payloadInput[apiInput.aspectRatioKey] = aspectRatio;
    if (apiInput.resolutionKey)   payloadInput[apiInput.resolutionKey]  = resolution;
    if (maybeSeed !== undefined && apiInput.seedKey) payloadInput[apiInput.seedKey] = maybeSeed;

  } else if (apiInput.referenceImagesKey) {
    // ── Reference-image-based models (Grok Imagine, Grok Imagine 1.5) ─────────
    const refImageUrls = rawRefImages;

    const hasImages = refImageUrls.length > 0;
    effectiveApiId = hasImages && imageUpstreamId ? imageUpstreamId : input.binding.upstreamModelId;

    const durationValue = apiInput.durationAsString ? String(clampedDuration) : clampedDuration;

    payloadInput = {
      prompt:                     prompt ?? "",
      [apiInput.aspectRatioKey!]: aspectRatio,
      [apiInput.durationKey!]:    durationValue,
    };

    if (apiInput.modeKey)       payloadInput[apiInput.modeKey]       = mode;
    if (apiInput.resolutionKey) payloadInput[apiInput.resolutionKey] = resolution;
    if (apiInput.extra)         Object.assign(payloadInput, apiInput.extra);
    if (hasImages) payloadInput[apiInput.referenceImagesKey] = refImageUrls;

  } else {
    // ── Start/end-frame + elements models (Kling) ─────────────────────────────
    const hasNewElements = klingElements.length > 0;

    const startFrameUrl = rawStartFrame;
    const endFrameUrl = rawEndFrame;
    const r2Resources: Resource[] = hasNewElements ? [] : resources;
    const uploadedElements = hasNewElements
      ? klingElements.slice(0, 3).map((el) => ({
          name:        el.name,
          description: el.description,
          imageUrls:   el.imageUrls,
        }))
      : [];

    payloadInput = {
      prompt:                     prompt ?? "",
      [apiInput.aspectRatioKey!]: aspectRatio,
      [apiInput.durationKey!]:    apiInput.durationAsString ? String(clampedDuration) : clampedDuration,
    };

    if (apiInput.modeKey)       payloadInput[apiInput.modeKey]       = mode;
    if (apiInput.soundKey)      payloadInput[apiInput.soundKey]      = Boolean(sound);
    if (apiInput.resolutionKey) payloadInput[apiInput.resolutionKey] = resolution;
    if (apiInput.extra)         Object.assign(payloadInput, apiInput.extra);

    if (apiInput.useImageUrls) {
      const image_urls: string[] = [];
      if (startFrameUrl) image_urls.push(startFrameUrl);
      if (endFrameUrl)   image_urls.push(endFrameUrl);
      if (image_urls.length > 0) payloadInput.image_urls = image_urls;
    }

    if (apiInput.useKlingElements) {
      let kling_elements: { name: string; description: string; element_input_urls: string[] }[] = [];
      if (hasNewElements) {
        kling_elements = uploadedElements.map((el) => ({
          name:               el.name,
          description:        el.description,
          element_input_urls: el.imageUrls.length >= 2 ? el.imageUrls : [el.imageUrls[0], el.imageUrls[0]],
        }));
      } else {
        kling_elements = r2Resources.map((r) => {
          const safeName = r.label.toLowerCase().replace(/\s+#/g, "_").replace(/[^a-z0-9_]/g, "") || "element";
          return { name: safeName, description: r.label, element_input_urls: [r.url, r.url] };
        });
      }
      if (kling_elements.length > 0) payloadInput.kling_elements = kling_elements;
    }
  }

  // Google Veo models require a dedicated endpoint and a flattened structure.
  const isVeo = !!apiInput.useGoogleVeo;
  const endpoint = isVeo ? `${KIE_BASE}/api/v1/veo/generate` : CREATE;
  const body: Record<string, unknown> = isVeo
    ? { model: effectiveApiId, ...payloadInput }
    : { model: effectiveApiId, callBackUrl, input: payloadInput };

  return { endpoint, body, payloadInput, effectiveApiId };
}

// ── Adapter ─────────────────────────────────────────────────────────────────

async function submitKie(input: GenerateInput): Promise<SubmitOutcome> {
  const apiKey = requireKey(input.credentials);
  const model = input.model;

  let endpoint: string;
  let requestBody: Record<string, unknown>;
  let resolvedApiId: string;
  let payloadInput: Record<string, unknown> | undefined;

  if (isVideoModel(model)) {
    const built = buildVideoPayload(input, model);
    endpoint = built.endpoint;
    requestBody = built.body;
    resolvedApiId = built.effectiveApiId;
    payloadInput = built.payloadInput;

    // kie.ai can't fetch our local reference media — re-host any leftover
    // /generated or data: URLs in the payload (e.g. kling-element image URLs,
    // which don't ride the staged media slots). Moved verbatim from the route.
    try {
      await rewriteLocalMediaForKie(payloadInput, apiKey);
    } catch (e) {
      throw new Error(`Couldn't upload reference media to kie.ai: ${(e as Error).message}`);
    }
  } else {
    const built = buildImageInput(input, model);
    endpoint = built.endpoint;
    requestBody = built.body;
    resolvedApiId = built.resolvedApiId;
  }

  const createRes = await fetch(endpoint, {
    method:  "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body:    JSON.stringify(requestBody),
  });

  if (!createRes.ok) {
    if (createRes.status === 401) throw new Error("Invalid API key — please update it in Settings.");
    throw new Error(await createRes.text());
  }

  const createdText = await createRes.text();
  let created: { code?: number; msg?: string; data?: { taskId?: string; id?: string }; taskId?: string; id?: string };
  try {
    created = JSON.parse(createdText);
  } catch {
    throw new Error(`Upstream returned non-JSON: ${createdText.slice(0, 200)}`);
  }
  if (!isVideoModel(model) ? created.code !== undefined && created.code !== 200 : created.code !== 200) {
    throw new Error(created.msg ?? "Task creation failed");
  }

  const taskId = created.data?.taskId ?? created.data?.id ?? created.taskId ?? created.id;
  if (!taskId) throw new Error(isVideoModel(model) ? "No taskId returned" : "No task ID in response");

  const providerMeta: ProviderMeta = {
    upstreamTaskId: taskId,
    family: (input.binding.family as string | undefined) ?? "standard",
    statusUrl: `${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
    upstreamModelId: resolvedApiId,
  };

  return { mode: "async", upstreamTaskId: taskId, providerMeta };
}

/** Ported from lib/kieJobPoller.ts extractUrls — same result-shape tolerance. */
function extractUrls(data: Record<string, unknown>): string[] {
  const out: string[] = [];

  const resultJson = data.resultJson as string | undefined;
  if (resultJson) {
    try {
      const parsed = JSON.parse(resultJson);
      const urls = parsed.resultUrls ?? parsed.resultUrl;
      if (Array.isArray(urls)) out.push(...urls.filter(Boolean));
      else if (urls) out.push(urls);
    } catch {
      /* fall through to the other shapes */
    }
  }
  if (out.length === 0 && typeof data.videoUrl === "string") out.push(data.videoUrl);
  if (out.length === 0) {
    const output = data.output as unknown;
    if (Array.isArray(output) && output[0]) out.push(String(output[0]));
    else if (typeof output === "string") out.push(output);
  }
  return out;
}

async function pollKie(
  upstreamTaskId: string,
  _kind: "image" | "video",
  cfg: ProviderRuntimeConfig,
  meta?: ProviderMeta,
): Promise<PollOutcome> {
  // ── C4 — Kie-Veo family branch (documented SPIKE fallback) ──────────────────
  // design.md §2.3/C4: whether `GET /api/v1/veo/record-info?taskId=` works and
  // what it returns is an UNVERIFIED claim — the live spike has not been run.
  // Until it verifies, Veo stays the one unpolled family (the same behavior as
  // the old submit path, which deliberately never started a poller for Veo:
  // generate-video:481-482). We do not guess at the endpoint/shape: the tick
  // parks as `pending` (the 12-min poll deadline bounds it). If the spike
  // later verifies the endpoint, replace this branch with a real record-info
  // mapping pinned into provider_meta — do not merge it as if verified.
  if (meta?.family === "kie-google-veo") {
    return { state: "pending" };
  }

  const apiKey = cfg.apiKey;
  if (!apiKey) return { state: "error", error: "No API key configured for this provider. Add one in Settings." };

  const res = await fetch(
    `${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(upstreamTaskId)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  const json = (await res.json()) as Record<string, unknown>;
  if (json?.code !== undefined && json.code !== 200 && json.code !== 0) {
    return { state: "error", error: (json.msg as string) ?? `kie.ai error ${json.code}` };
  }
  const data = (json?.data ?? json) as Record<string, unknown>;
  const state = String(data.state ?? data.status ?? "").toLowerCase();

  if (state === "success" || state === "succeeded") {
    const urls = extractUrls(data);
    if (urls.length === 0) {
      return { state: "error", error: "Generation succeeded but returned no output" };
    }
    return { state: "done", mediaUrls: urls };
  }

  if (state === "fail" || state === "failed" || state === "error") {
    const msg =
      (data.failMsg as string) ?? (data.error as string) ?? (data.failReason as string) ?? "Generation failed";
    return { state: "error", error: msg };
  }

  // waiting / queuing / generating / running → keep polling
  return { state: "pending" };
}

export const kieProvider: GenerationProvider = {
  id: "kie",
  label: "Kie.ai",
  mediaStaging: "remote-url",

  /** kieUpload.ts delegation — pushes local `/generated/…`/`data:` to kie's temp store. */
  async uploadMedia(localPathOrDataUrl: string, _mimeType: string, cfg: ProviderRuntimeConfig): Promise<string> {
    const apiKey = requireKey(cfg);
    const [url] = await ensureKieReachableImages([localPathOrDataUrl], apiKey);
    return url;
  },

  checkReadiness(cfg: ProviderRuntimeConfig): { ready: boolean; reason?: string } {
    return cfg.keySource !== "none" && !!cfg.apiKey
      ? { ready: true }
      : { ready: false, reason: "No API key configured for this provider. Add one in Settings." };
  },

  submit: submitKie,
  poll: pollKie,
};

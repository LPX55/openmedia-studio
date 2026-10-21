/**
 * POST /api/generate-video — thin video-generation controller (Phase 4, P4b;
 * design §5 Phase 4).
 *
 * parse normalized payload → registry.resolveForModel → stageInputMedia →
 * submitJob → `{ taskId }`. The 9-family Kie payload builders (incl. the Veo
 * endpoint switch) moved verbatim into `lib/providers/adapters/kie.ts`; the
 * client no longer sends alternate veo bodies (design §4.1).
 *
 * PROVIDER RESOLUTION (P6 video lane): the backend comes from
 * `resolveForModel` — the explicit `providerId`, else the model's active
 * `model_bindings` row, else the static default (kie). The kie path is
 * UNCHANGED (same payload, same staging, same submit); the compat family
 * (OpenRouter's `/videos`) rides the SAME controller — the adapter owns the
 * dialect, the route stays provider-agnostic.
 */
import { NextRequest, NextResponse } from "next/server";
// `@/lib/providers/bootstrap` (NOT `@/lib/providers` — the client-side
// `lib/providers.ts` occupies that specifier): side-effect registration of
// kie/azure/codex + the registry API. Controllers never import adapters.
import { resolveForModel } from "@/lib/providers/bootstrap";
import { createStagingResolver, stageInputMedia } from "@/lib/providers/mediaStager";
import { submitJob } from "@/lib/jobManager";
import { VIDEO_MODELS } from "@/lib/modelConfig";
import * as guestDb from "@/lib/guest/db";

interface Resource {
  url: string;
  label: string;
}

interface KlingElementInput {
  name: string;
  description: string;
  imageUrls: string[];
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      videoModel      = body.model || "kling-3.0",
      prompt,
      startFrameUrl:  rawStartFrame,
      endFrameUrl:    rawEndFrame,
      videoRefUrl:    rawVideoRef,
      resources       = [] as Resource[],
      klingElements   = [] as KlingElementInput[],
      referenceImageUrls:  rawRefImages     = body.imageUrls || [] as string[],
      referenceVideoUrls:  rawRefVideoUrls  = [] as string[],
      referenceAudioUrls:  rawRefAudioUrls  = [] as string[],
      sound           = false,
      duration        = 5,
      aspectRatio     = body.aspect_ratio || "16:9",
      mode            = "pro",
      resolution:     rawResolution,
      seed,
      veoMode,
      generationType: rawGenerationType,
      callBackUrl:    rawCallBackUrl,
      providerId,
      debugOnly       = false,
    } = body;

    const modelCfg = VIDEO_MODELS.find((m) => m.id === videoModel);
    if (!modelCfg) return NextResponse.json({ error: `Unknown video model: ${videoModel}` }, { status: 400 });

    const resolution = rawResolution || modelCfg.defaultResolution || "480p";

    if (debugOnly) {
      const debugPayload = {
        videoModel, prompt, aspectRatio, duration, mode, resolution, sound, seed,
        startFrameUrl: rawStartFrame, endFrameUrl: rawEndFrame, videoRefUrl: rawVideoRef,
        resources, klingElements, referenceImageUrls: rawRefImages,
        referenceVideoUrls: rawRefVideoUrls, referenceAudioUrls: rawRefAudioUrls,
        veoMode, generationType: rawGenerationType, callBackUrl: rawCallBackUrl, providerId,
      };
      console.log("[DEBUG] generate-video payload:", JSON.stringify(debugPayload, null, 2));
      return NextResponse.json({ debugPayload });
    }

    const { provider, binding, config } = resolveForModel(videoModel, providerId, guestDb.getModelBindingRows(videoModel));

    // An image-only backend (azure / codex) cannot serve a video request — it
    // would build an IMAGE payload and fail upstream with a confusing error.
    if (provider.capabilities?.video === false) {
      return NextResponse.json(
        { error: `${provider.label} does not support video generation.` },
        { status: 400 },
      );
    }

    const readiness = provider.checkReadiness(config, binding);
    if (!readiness.ready) {
      return NextResponse.json(
        { error: readiness.reason ?? `${provider.label} is not ready.` },
        { status: 401 },
      );
    }

    // Clamp duration to model limits here too (same math the adapter's payload
    // builder applies) so the pending `generations` row records the clamped
    // value, as the old route did.
    const isSeedance25EditModel = modelCfg.id === "seedance-2-5-edit";
    const clampedDuration = isSeedance25EditModel
      ? -1
      : modelCfg.apiInput.durationMax > 0
      ? Math.max(modelCfg.apiInput.durationMin, Math.min(modelCfg.apiInput.durationMax, Number(duration)))
      : 0;

    const media = await stageInputMedia(
      {
        references: rawRefImages,
        startFrame: rawStartFrame,
        endFrame: rawEndFrame,
        videoRef: rawVideoRef,
        referenceVideos: rawRefVideoUrls,
        audioRefs: rawRefAudioUrls,
        resources: resources.map((r: Resource) => ({ url: r.url, tag: r.label })),
      },
      createStagingResolver("video-generate", binding, provider),
      config,
    );

    const { taskId } = await submitJob("video", provider, binding, {
      model: modelCfg,
      prompt: prompt ?? "",
      params: { aspectRatio, duration: clampedDuration, mode, resolution, sound, seed },
      media,
      extras: {
        // Family-specific structured inputs the adapter interprets (see types.ts).
        ...(klingElements.length ? { klingElements } : {}),
        ...(veoMode ? { veoMode } : {}),
        ...(rawGenerationType ? { generationType: rawGenerationType } : {}),
        ...(rawCallBackUrl ? { callBackUrl: rawCallBackUrl } : {}),
      },
    });

    return NextResponse.json({ taskId });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const cause = e instanceof Error && (e as NodeJS.ErrnoException).cause;
    console.error("[generate-video] unhandled error:", msg, cause ?? "");
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

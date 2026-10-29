/**
 * POST /api/generate — thin image-generation controller (Phase 4, P4b;
 * design §5 Phase 4: "Slim … down to thin controllers over
 * jobManager.submitJob()").
 *
 * parse normalized payload → registry.resolveForModel → stageInputMedia →
 * submitJob → `{ taskId }`. All provider branching (kie / azure / codex
 * payload construction) lives in `lib/providers/adapters/*`; the client sends
 * `{ model, providerId?, prompt, aspectRatio, quality, resolution?, … }` with
 * no azure/codex flags (design §4.1).
 */
import { NextRequest, NextResponse } from "next/server";
// `@/lib/providers/bootstrap` (NOT `@/lib/providers` — the client-side
// `lib/providers.ts` occupies that specifier): side-effect registration of
// kie/azure/codex + the registry API. Controllers never import adapters.
import { resolveForModel } from "@/lib/providers/bootstrap";
import { createStagingResolver, stageInputMedia } from "@/lib/providers/mediaStager";
import { submitJob } from "@/lib/jobManager";
// P7a-1: the shared catalog resolver (static IMAGE_MODELS first, then a
// `custom_models` row) — the ONE merge point, never an inline catalog find.
import { resolveImageModel } from "@/lib/guest/customModels";
import * as guestDb from "@/lib/guest/db";

export const maxDuration = 1000;

export async function POST(req: NextRequest) {
  const {
    model       = "nano-banana-2",
    prompt,
    imageUrls   = [],
    aspectRatio = "1:1",
    quality     = "1k",
    resolution,
    customWidth,
    customHeight,
    providerId,
    debugOnly,
  } = (await req.json()) as {
    model?:        string;
    prompt?:       string;
    imageUrls?:    string[];
    aspectRatio?:  string;
    quality?:      string;     // effective quality tier for the selected provider
    resolution?:   string;     // azure size-map tier ("1k" | "2k" | "4k")
    customWidth?:  number;     // manual size — used when aspectRatio === "custom"
    customHeight?: number;
    providerId?:   string;     // explicit provider; omit ⇒ model_bindings active row ⇒ kie
    debugOnly?:    boolean;
  };

  if (debugOnly) {
    const body = { model, prompt, imageUrls, aspectRatio, quality, resolution, customWidth, customHeight, providerId };
    console.log("[DEBUG] generate payload:", JSON.stringify(body, null, 2));
    return NextResponse.json({ ok: true });
  }

  if (!prompt?.trim()) return NextResponse.json({ error: "Prompt is required" }, { status: 400 });

  const modelCfg = resolveImageModel(model);
  if (!modelCfg) {
    return NextResponse.json(
      {
        error:
          `Unknown model: ${model} — it is not in the static catalog and no custom model ` +
          `is registered under that id (create one in Settings first)`,
      },
      { status: 400 },
    );
  }

  try {
    const { provider, binding, config } = resolveForModel(model, providerId, guestDb.getModelBindingRows(model));

    const readiness = provider.checkReadiness(config, binding);
    if (!readiness.ready) {
      return NextResponse.json(
        { error: readiness.reason ?? `${provider.label} is not ready.` },
        { status: 401 },
      );
    }

    // resolveImages' legacy cap: at most 14 reference images reach kie (moved
    // from the old controller's `imageUrls.slice(0, 14)` in resolveImages).
    const references = imageUrls.slice(0, 14);

    // C1 (o6-gate): staging operation is picked PER REQUEST — `image-edit`
    // when reference images are present, so the Azure binding's
    // `mediaStagingByOperation["image-edit"] = "multipart-buffer"` is actually
    // selected (design §1.3 / finding 1i); bare generations keep
    // `image-generate`. Kie/Codex resolve to the same strategy either way.
    const media = await stageInputMedia(
      { references },
      createStagingResolver(references.length > 0 ? "image-edit" : "image-generate", binding, provider),
      config,
    );

    const { taskId } = await submitJob("image", provider, binding, {
      model: modelCfg,
      prompt,
      params: { aspectRatio, quality, resolution, customWidth, customHeight },
      media,
    });

    return NextResponse.json({ taskId });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * lib/jobManager — provider-refactor Phase 2 + Phase 4 (design.md §2).
 *
 * - `settleJob()` is the single completion funnel for in-process jobs: mirror
 *   media into MEDIA_DIR, write `jobStore`, update the `generations` row, emit
 *   `job:<taskId>` on the SSE bus (fixes the Azure/Codex 12-min hang), and
 *   release both in-process registries (C2: settleJob is the only release point).
 * - `submitJob()` (P4b, design §2.1): uniform PRE-MINT — mints the taskId,
 *   inserts the pending `jobStore` + `generations` rows (with `provider_id`)
 *   BEFORE any upstream call, marks the submit live (C2 `activeSubmits`),
 *   runs `provider.submit()` in a managed try/catch background task (a throw
 *   settles the row `error` — finding 3b), and returns `{ taskId }`
 *   immediately. Sync outcomes settle inline; async outcomes persist
 *   `provider_meta` (C3) and arm the provider-generic poll loop.
 * - `startPolling()` (P4b): generic 3s/12-min loop calling
 *   `provider.poll(upstreamTaskId, kind, cfg, meta)` through the registry
 *   (replaces the Phase-2 kieJobPoller shim). The Kie-Veo family is the one
 *   UNPOLLED family (C4 spike fallback — see the guard below).
 * - `resumeJob()`: crash recovery — restarts a lost poll loop via the
 *   registered provider (kie, or a compat backend that implements `poll`),
 *   settles an orphaned in-process job ("Server restarted…"), leaves unknown
 *   providers untouched.
 */
import { randomUUID } from "crypto";
import { jobStore, type JobResult, type ProviderMeta } from "./jobStore";
import { appendJobLog, describeError } from "./jobLog";
import { jobEvents } from "./jobEvents";
import { mirrorToR2, uploadBuffer } from "./storage";
import * as guestDb from "./guest/db";
import { GUEST_USER_ID } from "./guestMode";
// Importing the bootstrap for its side effect (registers kie/azure/codex) AND
// for `get` — controllers never import adapters directly (P4b). NB: `./providers`
// would resolve to the client-side lib/providers.ts; the bootstrap is ./providers/bootstrap.
import { get as getRegisteredProvider } from "./providers/bootstrap";
import type { GenerationProvider, GenerateInput, StagedMedia } from "./providers/types";
import type { ModelProviderBinding } from "./providers/bindings";

export type JobKind = "image" | "video";

/** Per-process boot id — activeSubmits entries from an earlier boot don't count (C2). */
const bootId = randomUUID();

/** Live in-process submits (taskId → bootId). Released ONLY when the job settles. */
const activeSubmits = new Map<string, string>();

/** Live poll loops owned by startPolling — double-start guard. */
const activePollers = new Set<string>();

const RESTART_ERROR = "Server restarted while local job was in progress";

const POLL_INTERVAL_MS = 3_000;
const MAX_POLL_MS = 12 * 60 * 1000; // matches the SSE hard cap in job-status

/**
 * How often a poll tick is STORED in the trail. The console line is written
 * for every tick (debug granularity); the trail keeps the first tick, every
 * state change and every Nth tick, so a 12-minute loop cannot flood it.
 */
const POLL_TRAIL_EVERY = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when the task is a live submit of this boot or has a live poll loop (C2). */
export function isActive(taskId: string): boolean {
  return activePollers.has(taskId) || activeSubmits.get(taskId) === bootId;
}

/** Mark an in-process submit as live (C2). Released only by settleJob. */
export function registerSubmit(taskId: string): void {
  activeSubmits.set(taskId, bootId);
}

export type SettleOutcome =
  | { status: "done"; urls?: string[]; buffers?: Array<{ buffer: Buffer; mimeType: string }> }
  | { status: "error"; error: string };

/**
 * Single settle funnel (design.md §2.2): mirror media to MEDIA_DIR
 * (remote urls via mirrorToR2, local buffers via uploadBuffer), then
 * jobStore.set → guestDb.updateGeneration → jobEvents.emit → release registries.
 * Idempotent: a second settle for an already-terminal job is a no-op.
 */
export async function settleJob(
  taskId: string,
  kind: JobKind,
  providerId: string,
  outcome: SettleOutcome,
): Promise<void> {
  const current = jobStore.get(taskId);
  if (current && current.status !== "pending") {
    activeSubmits.delete(taskId);
    activePollers.delete(taskId);
    appendJobLog(taskId, "settle", "settle ignored — the job is already terminal");
    return;
  }

  try {
    const folder = kind === "video" ? "videos" : "images";
    let result: JobResult;

    if (outcome.status === "error") {
      result = { status: "error", error: outcome.error, providerId };
      appendJobLog(taskId, "settle", `settling as error · ${outcome.error}`);
    } else {
      // Remote result urls (kie-style) → mirror into MEDIA_DIR; on failure keep
      // the source urls, exactly like kieJobPoller's settleSuccess fallback.
      let urls = outcome.urls ?? [];
      if (urls.length > 0) {
        try {
          urls = await Promise.all(urls.map((u) => mirrorToR2(u, folder)));
        } catch (e) {
          console.error(`[jobManager] ${taskId} url mirror failed, using source urls:`, (e as Error).message);
          appendJobLog(taskId, "error", `url mirror failed — keeping the source urls · ${describeError(e)}`);
        }
      }
      // Local buffers (Azure/OpenAI base64 or a Codex CLI output file) go
      // straight to MEDIA_DIR via uploadBuffer.
      const bufferCount = outcome.buffers?.length ?? 0;
      if (outcome.buffers?.length) {
        const stored = await Promise.all(
          outcome.buffers.map((b) => uploadBuffer(b.buffer, b.mimeType, folder)),
        );
        urls = [...urls, ...stored];
      }
      appendJobLog(
        taskId,
        "settle",
        `settling as done · mirrored ${urls.length} url(s) · ${bufferCount} buffer(s)`,
      );
      result = kind === "video"
        ? { status: "done", videoUrl: urls[0], providerId }
        : { status: "done", imageUrl: urls[0], imageUrls: urls, providerId };
    }

    jobStore.set(taskId, result);
    // One UPDATE: the terminal state + the last error + the trail, so the log
    // survives a restart (the read API falls back to the generations row).
    const dbUpdate: Parameters<typeof guestDb.updateGeneration>[1] = {
      job_log: JSON.stringify(jobStore.getTrail(taskId)),
    };
    if (result.status === "done") {
      dbUpdate.status = "done";
      if (kind === "video") dbUpdate.video_url = result.videoUrl;
      else {
        dbUpdate.image_url = result.imageUrl;
        dbUpdate.image_urls = result.imageUrls;
      }
    } else if (result.status === "error") {
      dbUpdate.status = "error";
      dbUpdate.error_msg = result.error;
    }
    guestDb.updateGeneration(taskId, dbUpdate);
    appendJobLog(taskId, "settle", "job store + generations row updated");
    // Fixes the O1 SSE bug: Azure/Codex completions now wake /api/job-stream.
    jobEvents.emit(`job:${taskId}`, result);
    appendJobLog(taskId, "settle", `SSE event emitted · job:${taskId}`);
  } finally {
    // Single release point for both registries (design.md §2.2 step 5, C2) —
    // must run even if store/DB/emit throws, or a leaked entry would make the
    // task look live forever and resumeJob could never settle the orphan.
    activeSubmits.delete(taskId);
    activePollers.delete(taskId);
  }
}

/**
 * Generic poll loop (P4b): 3s interval, 12-min deadline, one `provider.poll()`
 * tick per interval — the loop shape kieJobPoller.ts used, now driven through
 * the registry adapter. Always terminal: the deadline settles the job.
 */
async function runProviderPollLoop(
  provider: GenerationProvider,
  taskId: string,
  upstreamTaskId: string,
  kind: JobKind,
  meta?: ProviderMeta,
): Promise<void> {
  const cfg = guestDb.getProviderRuntimeConfig(String(provider.id));
  const deadline = Date.now() + MAX_POLL_MS;

  let tick = 0;
  let lastState = "";

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    tick += 1;

    let outcome;
    try {
      outcome = await provider.poll!(upstreamTaskId, kind, cfg, meta);
    } catch (e) {
      // Transient poll errors retry — same contract as the old kie loop.
      console.warn(`[jobManager] ${taskId} transient poll error:`, (e as Error).message);
      appendJobLog(taskId, "poll", `tick ${tick} failed · ${describeError(e)}`, {
        store: tick === 1 || tick % POLL_TRAIL_EVERY === 0,
      });
      continue;
    }

    // The console line is written for EVERY tick (debug granularity); the
    // trail keeps the first tick, every state change and every Nth tick.
    appendJobLog(
      taskId,
      "poll",
      `tick ${tick} · state ${outcome.state}${outcome.state === "pending" && outcome.progress !== undefined ? ` · ${outcome.progress}%` : ""}`,
      { store: tick === 1 || outcome.state !== lastState || tick % POLL_TRAIL_EVERY === 0 },
    );
    lastState = outcome.state;

    if (outcome.state === "done") {
      await settleJob(taskId, kind, String(provider.id), {
        status: "done",
        urls: outcome.mediaUrls,
        buffers: outcome.buffers,
      });
      return;
    }
    if (outcome.state === "error") {
      await settleJob(taskId, kind, String(provider.id), { status: "error", error: outcome.error });
      return;
    }
    // pending → keep polling
  }

  appendJobLog(taskId, "poll", `poll deadline reached after ${tick} tick(s) — timing out`);
  await settleJob(taskId, kind, String(provider.id), { status: "error", error: "Generation timed out" });
}

/**
 * Start (or restart) the async poll loop for a task via the registered
 * provider's `poll()`. No-ops when the provider has no poll implementation —
 * including the Kie-Veo family, which is the one UNPOLLED family until the
 * C4 record-info spike verifies the endpoint (design §2.3; the adapter parks
 * that family as `pending`, and we don't even arm the loop here so an unpolled
 * Veo row can still be resumed/settled by other means).
 */
export function startPolling(taskId: string, providerId: string, kind: JobKind, meta?: ProviderMeta): void {
  if (!taskId || activePollers.has(taskId)) return;
  if (meta?.family === "kie-google-veo") {
    appendJobLog(taskId, "poll", "poll loop skipped — the Veo family is unpolled (C4 spike fallback)");
    return;
  }
  const provider = getRegisteredProvider(providerId);
  if (!provider?.poll) {
    appendJobLog(taskId, "poll", `poll loop skipped — the provider "${providerId}" has no poll implementation`);
    return;
  }

  const upstreamTaskId = meta?.upstreamTaskId ?? taskId;
  activePollers.add(taskId);
  appendJobLog(
    taskId,
    "poll",
    `poll loop started · provider ${providerId} · family ${meta?.family ?? "standard"} · interval ${POLL_INTERVAL_MS}ms`,
  );
  void runProviderPollLoop(provider, taskId, upstreamTaskId, kind, meta)
    .catch((e) => {
      console.error(`[jobManager] poll for ${taskId} crashed:`, e);
      appendJobLog(taskId, "error", `poll loop crashed · ${describeError(e)}`);
    })
    .finally(() => activePollers.delete(taskId));
}

/** Flatten staged media into the pending row's `reference_image_urls` (display metadata). */
function flattenStagedMedia(media: GenerateInput["media"]): string[] | undefined {
  const out: string[] = [];
  const push = (s?: StagedMedia) => {
    const u = s?.url ?? s?.originalUrl;
    if (u) out.push(u);
  };
  media.references?.forEach(push);
  push(media.startFrame);
  push(media.endFrame);
  push(media.videoRef);
  media.referenceVideos?.forEach(push);
  media.audioRefs?.forEach(push);
  media.resources?.forEach((r) => push(r.media));
  return out.length > 0 ? out : undefined;
}

/**
 * Uniform pre-mint submit (design §2.1, P4b):
 *   mint taskId → insert pending rows (jobStore + generations, with
 *   provider_id) → registerSubmit (C2) → managed background
 *   `provider.submit()` → settleJob (sync) / provider_meta + poll loop (async).
 * Returns `{ taskId }` immediately; a throwing submit settles the row
 * `error` (finding 3b) instead of leaving it pending forever.
 */
export async function submitJob(
  kind: JobKind,
  provider: GenerationProvider,
  binding: ModelProviderBinding,
  input: Omit<GenerateInput, "taskId" | "kind" | "binding" | "credentials">,
): Promise<{ taskId: string }> {
  const providerId = String(provider.id);
  const taskId = `${providerId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const fullInput: GenerateInput = {
    ...input,
    taskId,
    kind,
    binding,
    credentials: guestDb.getProviderRuntimeConfig(providerId),
  };

  // The trail starts BEFORE the upstream call — a submit that dies inside the
  // provider must still leave a trace (the "fetch failed" gap).
  appendJobLog(
    taskId,
    "submit",
    `task pre-minted · provider ${providerId} · model ${input.model.id} · kind ${kind}`,
  );

  jobStore.set(taskId, {
    status: "pending",
    type: kind,
    userId: GUEST_USER_ID ?? undefined,
    providerId,
  });
  appendJobLog(taskId, "submit", "pending record written to the job store");

  // Pre-insert the pending row BEFORE the upstream call (design §2.1) so a
  // crash mid-submit can't orphan the job; settleJob updates it on completion.
  guestDb.insertGeneration({
    task_id: taskId,
    user_id: GUEST_USER_ID,
    generation_type: kind,
    status: "pending",
    prompt: input.prompt.slice(0, 2000),
    model: input.model.id,
    aspect_ratio: input.params.aspectRatio,
    quality: input.params.quality,
    ...(kind === "image" ? { azure_resolution: providerId === "azure" ? input.params.resolution : undefined } : {}),
    duration: input.params.duration,
    kling_mode: input.params.mode,
    sound: input.params.sound,
    reference_image_urls: flattenStagedMedia(input.media),
    provider_id: providerId,
  });
  appendJobLog(taskId, "submit", "pending row written to guest.db");

  // C2: mark the submit live — released ONLY when settleJob runs, so the
  // client's first status poll can't false-kill a job that's still running.
  registerSubmit(taskId);
  appendJobLog(taskId, "submit", "submit registered as live (activeSubmits)");

  void (async () => {
    try {
      appendJobLog(taskId, "submit", "upstream submit started");
      const outcome = await provider.submit(fullInput);

      if (outcome.mode === "sync") {
        appendJobLog(taskId, "submit", "upstream answered synchronously");
        await settleJob(taskId, kind, providerId, {
          status: "done",
          urls: outcome.mediaUrls,
          buffers: outcome.rawBuffers,
        });
        return;
      }

      // Async upstream task — persist the C3-pinned provider_meta so
      // resumeJob/poll can reconnect after a restart.
      const meta: ProviderMeta = outcome.providerMeta ?? {
        upstreamTaskId: outcome.upstreamTaskId,
        family: binding.family ?? "standard",
        statusUrl: "",
        upstreamModelId: binding.upstreamModelId,
      };
      jobStore.set(taskId, {
        status: "pending",
        type: kind,
        userId: GUEST_USER_ID ?? undefined,
        providerId,
        providerMeta: meta,
      });
      guestDb.updateGeneration(taskId, { provider_meta: meta });
      appendJobLog(
        taskId,
        "submit",
        `upstream task accepted · family ${meta.family} · model ${meta.upstreamModelId}`,
      );

      if (meta.family === "kie-google-veo") {
        // C4 spike fallback: Veo is the one unpolled family (the record-info
        // endpoint/shape is unverified), and no poll loop will ever own this
        // task. Settle it EXPLICITLY (o6 bullet 5) — leaving it pending would
        // hang the client forever; HEAD's 12-min poll timeout used to produce
        // the same terminal error. settleJob's finally releases activeSubmits.
        await settleJob(taskId, kind, providerId, {
          status: "error",
          error: "Veo polling not available — the result can't be tracked yet; check the Gallery later.",
        });
        return;
      }

      startPolling(taskId, providerId, kind, meta);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[jobManager] ${providerId} submit for ${taskId} failed:`, msg);
      appendJobLog(taskId, "error", `submit failed · ${describeError(e)}`);
      await settleJob(taskId, kind, providerId, { status: "error", error: msg });
    }
  })();

  return { taskId };
}

/**
 * Crash recovery — called by /api/job-status and /api/job-stream when a job is
 * pending and (per C2) not known to be live:
 * - kie → restart the poll loop (upstream job survives a server restart);
 * - azure/codex (in-process) → settle `error` "Server restarted…" — the row
 *   exists, so it must not be left pending forever or reported not_found;
 * - unknown provider → leave pending untouched.
 * Legacy rows without provider_id infer azure/codex by taskId prefix, else kie.
 */
export function resumeJob(taskId: string): void {
  if (!taskId) return;
  if (isActive(taskId)) {
    appendJobLog(taskId, "resume", "resume skipped — the job is still live in this process", { store: false });
    return;   // live submit (current boot) or live poll — C2
  }

  const stored = jobStore.get(taskId);
  if (stored && stored.status !== "pending") {
    appendJobLog(taskId, "resume", "resume skipped — the job is already settled", { store: false });
    return; // already settled
  }

  const gen = guestDb.recoverJob(taskId);
  if (gen && gen.status !== "pending") {
    // generations row is terminal — sync it back into jobStore (legacy readability).
    appendJobLog(taskId, "resume", `recovered the terminal state "${gen.status}" from the generations row`);
    jobStore.set(
      taskId,
      gen.status === "done"
        ? gen.video_url
          ? { status: "done", videoUrl: gen.video_url, providerId: gen.provider_id }
          : { status: "done", imageUrl: gen.image_url ?? undefined, imageUrls: gen.image_urls ?? undefined, providerId: gen.provider_id }
        : { status: "error", error: gen.error_msg ?? "Generation failed", providerId: gen.provider_id },
    );
    return;
  }
  if (!stored && !gen) {
    appendJobLog(taskId, "resume", "resume skipped — nothing known about this task", { store: false });
    return; // nothing known — leave unknown tasks untouched
  }

  let providerId = stored?.providerId ?? gen?.provider_id;
  const meta = stored?.providerMeta ?? gen?.provider_meta;
  let kind: JobKind | undefined = stored?.type;
  if (gen?.generation_type === "image" || gen?.generation_type === "video") kind ??= gen.generation_type;

  if (!providerId) {
    // Legacy rows predate provider_id — infer by prefix, else kie (finding 3d).
    providerId = taskId.startsWith("azure-") ? "azure"
      : taskId.startsWith("codex-") ? "codex"
      : "kie";
  }
  const jobKind: JobKind = kind === "video" ? "video" : "image";

  if (providerId === "kie") {
    appendJobLog(taskId, "resume", "restarting the poll loop for the recovered task");
    startPolling(taskId, providerId, jobKind, meta);
    return;
  }
  // A compat backend with a REGISTERED poll implementation (OpenRouter's
  // video lane) — the upstream task survives a server restart exactly like
  // kie's, so the poll loop is restarted through the same funnel.
  const registered = getRegisteredProvider(providerId);
  if (registered?.poll) {
    appendJobLog(taskId, "resume", "restarting the poll loop for the recovered task");
    startPolling(taskId, providerId, jobKind, meta);
    return;
  }
  if (providerId === "azure" || providerId === "codex") {
    // In-process job with no upstream to reconnect to. If we got here the
    // submit isn't running in this process (isActive was false) — the process
    // that owned it is gone, so settle it cleanly instead of hanging the UI.
    appendJobLog(taskId, "resume", "orphaned in-process job — settling it as an error");
    void settleJob(taskId, jobKind, providerId, { status: "error", error: RESTART_ERROR });
    return;
  }
  // Unknown provider (no adapter registered) — leave pending untouched.
  appendJobLog(taskId, "resume", `unknown provider "${providerId}" — the task stays pending`);
}

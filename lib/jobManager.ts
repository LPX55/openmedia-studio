/**
 * lib/jobManager — provider-refactor Phase 2 (design.md §2; C2/C3/C7b-minimal).
 *
 * - `settleJob()` is the single completion funnel for in-process jobs: mirror
 *   media into MEDIA_DIR, write `jobStore`, update the `generations` row, emit
 *   `job:<taskId>` on the SSE bus (fixes the Azure/Codex 12-min hang), and
 *   release both in-process registries (C2: settleJob is the only release point).
 * - `activeSubmits` (C2): the generate route registers a live in-process submit
 *   before invoking the provider; `resumeJob` therefore can no longer false-kill
 *   a live Azure/Codex job on the client's very first status poll.
 * - `resumeJob()`: crash recovery — restarts a lost kie poll loop, settles an
 *   orphaned in-process job ("Server restarted…"), leaves unknown providers
 *   untouched.
 *
 * Phase-2 scope is the C7b *minimal* option: no provider registry yet —
 * resumeJob handles "kie" and the in-process "azure"/"codex" directly.
 */
import { randomUUID } from "crypto";
import { jobStore, type JobResult, type ProviderMeta } from "./jobStore";
import { jobEvents } from "./jobEvents";
import { mirrorToR2, uploadBuffer } from "./storage";
import * as guestDb from "./guest/db";
import { runKiePollLoop, isPolling as isKiePolling } from "./kieJobPoller";

export type JobKind = "image" | "video";

/** Per-process boot id — activeSubmits entries from an earlier boot don't count (C2). */
const bootId = randomUUID();

/** Live in-process submits (taskId → bootId). Released ONLY when the job settles. */
const activeSubmits = new Map<string, string>();

/** Live poll loops owned by startPolling — double-start guard. */
const activePollers = new Set<string>();

const RESTART_ERROR = "Server restarted while local job was in progress";

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
    return;
  }

  try {
    const folder = kind === "video" ? "videos" : "images";
    let result: JobResult;

    if (outcome.status === "error") {
      result = { status: "error", error: outcome.error, providerId };
    } else {
      // Remote result urls (kie-style) → mirror into MEDIA_DIR; on failure keep
      // the source urls, exactly like kieJobPoller's settleSuccess fallback.
      let urls = outcome.urls ?? [];
      if (urls.length > 0) {
        try {
          urls = await Promise.all(urls.map((u) => mirrorToR2(u, folder)));
        } catch (e) {
          console.error(`[jobManager] ${taskId} url mirror failed, using source urls:`, (e as Error).message);
        }
      }
      // Local buffers (Azure/OpenAI base64 or a Codex CLI output file) go
      // straight to MEDIA_DIR via uploadBuffer.
      if (outcome.buffers?.length) {
        const stored = await Promise.all(
          outcome.buffers.map((b) => uploadBuffer(b.buffer, b.mimeType, folder)),
        );
        urls = [...urls, ...stored];
      }
      result = kind === "video"
        ? { status: "done", videoUrl: urls[0], providerId }
        : { status: "done", imageUrl: urls[0], imageUrls: urls, providerId };
    }

    jobStore.set(taskId, result);
    if (result.status === "done") {
      guestDb.updateGeneration(
        taskId,
        kind === "video"
          ? { status: "done", video_url: result.videoUrl }
          : { status: "done", image_url: result.imageUrl, image_urls: result.imageUrls },
      );
    } else if (result.status === "error") {
      guestDb.updateGeneration(taskId, { status: "error", error_msg: result.error });
    }
    // Fixes the O1 SSE bug: Azure/Codex completions now wake /api/job-stream.
    jobEvents.emit(`job:${taskId}`, result);
  } finally {
    // Single release point for both registries (design.md §2.2 step 5, C2) —
    // must run even if store/DB/emit throws, or a leaked entry would make the
    // task look live forever and resumeJob could never settle the orphan.
    activeSubmits.delete(taskId);
    activePollers.delete(taskId);
  }
}

/**
 * Start (or restart) the async poll loop for a task. The 3s-interval /
 * 12-min-cap loop itself lives in lib/kieJobPoller and is reused unchanged via
 * runKiePollLoop. kie-only in Phase 2: azure/codex are in-process and have
 * nothing to poll (C7b minimal shims — no registry yet).
 */
export function startPolling(taskId: string, providerId: string, kind: JobKind, meta?: ProviderMeta): void {
  if (!taskId || activePollers.has(taskId)) return;
  if (providerId !== "kie") return;
  const upstreamTaskId = meta?.upstreamTaskId ?? taskId;
  if (isKiePolling(upstreamTaskId)) return; // a poll loop already owns this upstream task
  const apiKey = guestDb.getKieApiToken();
  if (!apiKey) return; // same no-op as resumeKieJob when no key is configured

  activePollers.add(taskId);
  void runKiePollLoop(upstreamTaskId, apiKey, kind)
    .catch((e) => console.error(`[jobManager] kie poll for ${taskId} crashed:`, e))
    .finally(() => activePollers.delete(taskId));
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
  if (isActive(taskId)) return;   // live submit (current boot) or live poll — C2
  if (isKiePolling(taskId)) return; // the submit-path kie loop owns this task

  const stored = jobStore.get(taskId);
  if (stored && stored.status !== "pending") return; // already settled

  const gen = guestDb.recoverJob(taskId);
  if (gen && gen.status !== "pending") {
    // generations row is terminal — sync it back into jobStore (legacy readability).
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
  if (!stored && !gen) return; // nothing known — leave unknown tasks untouched

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
    startPolling(taskId, providerId, jobKind, meta);
    return;
  }
  if (providerId === "azure" || providerId === "codex") {
    // In-process job with no upstream to reconnect to. If we got here the
    // submit isn't running in this process (isActive was false) — the process
    // that owned it is gone, so settle it cleanly instead of hanging the UI.
    void settleJob(taskId, jobKind, providerId, { status: "error", error: RESTART_ERROR });
    return;
  }
  // Unknown provider for this phase (no registry yet, C7b minimal) — leave pending untouched.
}

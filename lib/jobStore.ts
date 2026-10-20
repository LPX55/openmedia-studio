import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "./guest/paths";

/**
 * C3 pinned provider_meta shape (design.md §1.3/§2.1) — persisted as JSON in
 * `generations.provider_meta` and mirrored on pending jobStore entries.
 * Phase 4 moves the canonical declaration into lib/providers/types.ts; keep
 * the shapes identical until then.
 */
export interface ProviderMeta {
  upstreamTaskId: string;   // id on the upstream provider (Kie task id in Phase 2)
  family: string;           // VideoPayloadFamily | "standard" (union lands with Phase-4 bindings)
  statusUrl: string;        // fully-resolved status endpoint
  responseUrl?: string;     // result endpoint when separate from status (fal) — C4
  upstreamModelId: string;  // model string actually sent upstream
}

/**
 * The phase a trail entry belongs to. Deliberately coarse — the trail is a
 * human-readable trace, not a structured event bus.
 */
export type JobLogPhase = "submit" | "poll" | "settle" | "resume" | "error" | "retry";

/**
 * One entry of the per-job event trail.
 *
 * SECURITY: `detail` is ALWAYS redacted before it reaches this shape (see
 * lib/jobLog.ts) — no API keys, no `data:` payloads, no full request bodies,
 * no base URLs carrying a key.
 */
export interface JobLogEntry {
  /** Epoch milliseconds. */
  t: number;
  phase: JobLogPhase;
  detail: string;
}

/**
 * Cap of the per-job trail — the LAST N entries are kept (append-only, the
 * oldest are dropped). A 12-minute poll loop can produce hundreds of events;
 * the trail stays small enough to ship to the client on every read.
 */
export const JOB_LOG_CAP = 50;

export type JobResult =
  | { status: "pending"; type?: "image" | "video"; userId?: string; providerId?: string; providerMeta?: ProviderMeta; trail?: JobLogEntry[] }
  | { status: "done"; imageUrl?: string; imageUrls?: string[]; videoUrl?: string; providerId?: string; providerMeta?: ProviderMeta; trail?: JobLogEntry[] }
  | { status: "error"; error: string; providerId?: string; providerMeta?: ProviderMeta; trail?: JobLogEntry[] };

/** Drop the oldest entries once the cap is exceeded. */
function capTrail(trail: JobLogEntry[]): JobLogEntry[] {
  return trail.length > JOB_LOG_CAP ? trail.slice(trail.length - JOB_LOG_CAP) : trail;
}

/** Attach a trail to a result without widening the union (per-status spread). */
function withTrail(result: JobResult, trail: JobLogEntry[]): JobResult {
  switch (result.status) {
    case "pending": return { ...result, trail };
    case "done": return { ...result, trail };
    case "error": return { ...result, trail };
  }
}

// DATA_DIR is the repo in dev and a writable per-user dir in the packaged
// desktop app (the install dir is read-only there).
const FILE = join(DATA_DIR, ".job-store.json");

function read(): Record<string, JobResult> {
  if (!existsSync(FILE)) return {};
  try { return JSON.parse(readFileSync(FILE, "utf8")); }
  catch { return {}; }
}

function write(data: Record<string, JobResult>): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(data), "utf8");
}

export const jobStore = {
  get(taskId: string): JobResult | undefined {
    return read()[taskId];
  },
  /**
   * Write the record. The trail is PRESERVED across writes unless the caller
   * passes one explicitly — the trail is append-only and must survive the
   * status transitions (`pending` → `done`/`error`).
   */
  set(taskId: string, result: JobResult): void {
    const data = read();
    const prev = data[taskId];
    const trail = result.trail ?? prev?.trail;
    data[taskId] = trail ? withTrail(result, capTrail(trail)) : result;
    write(data);
  },
  /** The capped trail of a job (empty when the job is unknown). */
  getTrail(taskId: string): JobLogEntry[] {
    return read()[taskId]?.trail ?? [];
  },
  /**
   * Append one entry to the job's trail (capped) and persist it. Creates a
   * `pending` record when the job is not known yet — the trail is written
   * BEFORE the upstream call (pre-mint), so that is the normal case.
   */
  appendTrail(taskId: string, entry: JobLogEntry): JobLogEntry[] {
    const data = read();
    const prev = data[taskId];
    const trail = capTrail([...(prev?.trail ?? []), entry]);
    data[taskId] = prev
      ? withTrail(prev, trail)
      : { status: "pending", trail };
    write(data);
    return trail;
  },
};

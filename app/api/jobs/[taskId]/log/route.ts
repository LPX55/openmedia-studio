import { NextRequest, NextResponse } from "next/server";
import { jobStore, type JobLogEntry } from "@/lib/jobStore";
import * as guestDb from "@/lib/guest/db";

/**
 * GET /api/jobs/[taskId]/log — the per-job event trail.
 *
 * The trail is written by lib/jobLog.ts and persisted on the jobStore record
 * (`.job-store.json`). When that record is gone (cold start, a cleared store)
 * the read falls back to the `generations` row: its `status`/`error_msg`/
 * `updated_at` plus the trail copy written at settle time (`job_log`).
 *
 * NEVER 500s: an unknown task id answers 200 with a clear empty shape.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;
  const id = (taskId ?? "").trim();

  if (!id) {
    return NextResponse.json(
      { taskId: id, status: "not_found", providerId: null, model: null, trail: [], recoveredFromDb: false },
      { status: 400 },
    );
  }

  const stored = jobStore.get(id);

  // The generations row is the fallback source — it must never break the read.
  let gen: ReturnType<typeof guestDb.recoverJob> = null;
  try {
    gen = guestDb.recoverJob(id);
  } catch {
    gen = null;
  }

  const status = stored?.status ?? gen?.status ?? "not_found";
  const providerId = stored?.providerId ?? gen?.provider_id ?? null;
  const model = gen?.model ?? null;

  let trail: JobLogEntry[] = stored?.trail ?? [];
  let recoveredFromDb = false;
  if (trail.length === 0 && gen?.job_log) {
    const parsed = parseTrail(gen.job_log);
    if (parsed.length > 0) {
      trail = parsed;
      recoveredFromDb = true;
    }
  }
  // The in-memory record is gone → the answer comes from the database.
  if (!stored && gen) recoveredFromDb = true;

  return NextResponse.json({
    taskId: id,
    status,
    providerId,
    model,
    trail,
    recoveredFromDb,
    ...(gen ? { updatedAt: gen.updated_at } : {}),
    ...(gen?.error_msg ? { lastError: gen.error_msg } : {}),
  });
}

/** Parse the stored trail JSON — a malformed value yields an empty trail. */
function parseTrail(raw: string): JobLogEntry[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is JobLogEntry =>
        !!e &&
        typeof e === "object" &&
        typeof (e as JobLogEntry).t === "number" &&
        typeof (e as JobLogEntry).phase === "string" &&
        typeof (e as JobLogEntry).detail === "string",
    );
  } catch {
    return [];
  }
}

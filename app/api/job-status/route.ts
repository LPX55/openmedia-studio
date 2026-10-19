import { NextRequest, NextResponse } from "next/server";
import { jobStore } from "@/lib/jobStore";
import { resumeJob } from "@/lib/jobManager";
import * as guestDb from "@/lib/guest/db";

function recoverJob(taskId: string): "done" | "error" | "pending" | "not_found" {
  const gen = guestDb.recoverJob(taskId);
  if (!gen) return "not_found";
  if (gen.status === "done") {
    const result = gen.video_url
      ? { status: "done" as const, videoUrl: gen.video_url, providerId: gen.provider_id }
      : { status: "done" as const, imageUrl: gen.image_url ?? undefined, imageUrls: gen.image_urls ?? undefined, providerId: gen.provider_id };
    jobStore.set(taskId, result);
    return "done";
  }
  if (gen.status === "error") {
    jobStore.set(taskId, { status: "error", error: gen.error_msg ?? "Generation failed", providerId: gen.provider_id });
    return "error";
  }
  return "pending";
}

export async function GET(req: NextRequest) {
  const taskId = req.nextUrl.searchParams.get("taskId");
  if (!taskId) {
    return NextResponse.json({ error: "taskId is required" }, { status: 400 });
  }

  const result = jobStore.get(taskId);

  // Task known to local store — return as-is.
  if (result) {
    // Pending + not live → restart a lost kie poller, or settle an orphaned
    // in-process job. jobManager.resumeJob no-ops for jobs still running in
    // this process (C2 activeSubmits) — replaces the old azure-prefix
    // checks (design.md Phase 2).
    if (result.status === "pending") {
      resumeJob(taskId);
      const refreshed = jobStore.get(taskId);
      if (refreshed) return NextResponse.json(refreshed);
    }
    return NextResponse.json(result);
  }

  // Task not in local store (server restarted / cold start) — recover from
  // the generations row. Rows that exist are never reported not_found just
  // because they're in-process (legacy azure-prefix shortcut removed).
  const recovered = recoverJob(taskId);

  if (recovered === "done" || recovered === "error") {
    return NextResponse.json(jobStore.get(taskId)!);
  }

  if (recovered === "pending") {
    resumeJob(taskId);
    const refreshed = jobStore.get(taskId);
    if (refreshed) return NextResponse.json(refreshed);
    return NextResponse.json({ status: "pending" });
  }

  return NextResponse.json({ status: "not_found" });
}

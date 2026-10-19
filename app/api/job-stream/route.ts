import { NextRequest } from "next/server";
import { jobStore, type JobResult } from "@/lib/jobStore";
import { jobEvents } from "@/lib/jobEvents";
import { resumeJob } from "@/lib/jobManager";
import * as guestDb from "@/lib/guest/db";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
};

const TIMEOUT_MS = 12 * 60 * 1000; // 12 min hard cap

function immediate(payload: JobResult): Response {
  return new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: SSE_HEADERS });
}

export async function GET(req: NextRequest) {
  const taskId = req.nextUrl.searchParams.get("taskId");
  if (!taskId) return new Response("taskId required", { status: 400 });

  // Already settled in jobStore — respond immediately, no stream needed
  const existing = jobStore.get(taskId);
  if (existing && existing.status !== "pending") {
    return immediate(existing);
  }

  if (existing) {
    // Restart a lost kie poller, or settle an orphaned in-process job —
    // replaces the old azure-prefix check (design.md Phase 2).
    // Live jobs (C2 activeSubmits/activePollers) are no-ops.
    resumeJob(taskId);
    const refreshed = jobStore.get(taskId);
    if (refreshed && refreshed.status !== "pending") return immediate(refreshed);
  } else {
    const gen = guestDb.recoverJob(taskId);
    if (gen?.status === "done" || gen?.status === "error") {
      const recovered: JobResult = gen.status === "done"
        ? gen.video_url
          ? { status: "done", videoUrl: gen.video_url, providerId: gen.provider_id }
          : { status: "done", imageUrl: gen.image_url ?? undefined, imageUrls: gen.image_urls ?? undefined, providerId: gen.provider_id }
        : { status: "error", error: gen.error_msg ?? "Generation failed", providerId: gen.provider_id };
      jobStore.set(taskId, recovered);
      return immediate(recovered);
    }
    if (gen) {
      // Pending generations row exists without a jobStore entry — resume it
      // (restart poller / settle orphaned in-process job), then re-check.
      resumeJob(taskId);
      const refreshed = jobStore.get(taskId);
      if (refreshed && refreshed.status !== "pending") return immediate(refreshed);
      if (!refreshed) {
        jobStore.set(taskId, {
          status: "pending",
          type: gen.generation_type === "video" ? "video" : "image",
          providerId: gen.provider_id,
          providerMeta: gen.provider_meta,
        });
      }
    } else {
      // No record either — truly not found
      return immediate({ status: "error", error: "Job not found" });
    }
  }

  // Job is pending — open an SSE stream and wait for the poller/settle to fire
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      let closed = false;

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(timeout);
        controller.close();
      };

      const send = (payload: JobResult) => {
        if (closed) return;
        controller.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`));
        close();
      };

      // The settle may have landed between the resume above and this stream
      // actually starting — don't miss it (it would hang until the hard cap).
      // Enqueued directly (not via send()) so close() never touches the
      // heartbeat/timeout handles before they exist.
      const snapshot = jobStore.get(taskId);
      if (snapshot && snapshot.status !== "pending") {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(snapshot)}\n\n`));
        controller.close();
        return;
      }

      // Keepalive comment every 25 s (proxies drop idle SSE connections)
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(enc.encode(": ping\n\n"));
      }, 25_000);

      // Hard cap — emit error if callback never arrives
      const timeout = setTimeout(() => {
        send({ status: "error", error: "Generation timed out" });
      }, TIMEOUT_MS);

      jobEvents.once(`job:${taskId}`, send);

      req.signal.addEventListener("abort", () => {
        jobEvents.off(`job:${taskId}`, send);
        close();
      });
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

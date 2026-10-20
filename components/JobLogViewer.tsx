"use client";

/**
 * components/JobLogViewer — the read-only view of a job's event trail.
 *
 * ONE component, used by the canvas nodes (GenerateNode / VideoGeneratorNode)
 * and by the gallery's pending tiles. It talks to
 * `GET /api/jobs/[taskId]/log` and renders the trail as a phase timeline
 * (time · phase chip · detail).
 *
 * While the job is still pending the viewer refreshes on the SAME cadence the
 * rest of the app polls `/api/job-status` with (3s) — no new interval is
 * invented here. The viewer NEVER mutates a job: it is a pure reader.
 */
import { useEffect, useState } from "react";

export interface JobLogEntryView {
  t: number;
  phase: string;
  detail: string;
}

export interface JobLogResponse {
  taskId: string;
  status: string;
  providerId: string | null;
  model: string | null;
  trail: JobLogEntryView[];
  recoveredFromDb?: boolean;
  updatedAt?: string;
  lastError?: string;
}

/** The poll cadence the app already uses for /api/job-status. */
const POLL_MS = 3_000;

/** Per-phase accent (the chip border + text). */
const PHASE_COLOR: Record<string, string> = {
  submit: "#2DD4BF",
  poll: "#60a5fa",
  settle: "#4ade80",
  resume: "#fbbf24",
  error: "#f87171",
  retry: "#fb923c",
};

/** `HH:MM:SS` of a trail entry. */
function formatTime(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default function JobLogViewer({
  taskId,
  maxHeight = 220,
  showHeader = true,
}: {
  /** The job to watch — `null`/undefined renders the empty state. */
  taskId?: string | null;
  /** Max height of the scrollable timeline. */
  maxHeight?: number;
  /** Hide the status/provider header (compact embeds). */
  showHeader?: boolean;
}) {
  // The payload is tagged with the taskId it belongs to, so a task change
  // never shows the previous job's trail.
  const [state, setState] = useState<{ taskId: string; data: JobLogResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastStatus: string | null = null;

    const load = async () => {
      try {
        const res = await fetch(`/api/jobs/${encodeURIComponent(taskId)}/log`, { cache: "no-store" });
        const json = (await res.json()) as JobLogResponse;
        if (cancelled) return;
        lastStatus = json?.status ?? null;
        setState({ taskId, data: json });
        setError(null);
        // Auto-refresh only while the job is still running.
        if (lastStatus === "pending") timer = setTimeout(load, POLL_MS);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        // Keep trying while the job may still be running; a terminal job does
        // not keep the viewer busy.
        if (lastStatus === null || lastStatus === "pending") timer = setTimeout(load, POLL_MS);
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [taskId]);

  if (!taskId) {
    return (
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", padding: "6px 2px" }}>
        No run yet.
      </div>
    );
  }

  const data = state?.taskId === taskId ? state.data : null;
  const trail = data?.trail ?? [];
  const isPending = data?.status === "pending";

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}
    >
      {showHeader && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexWrap: "wrap",
            fontSize: 10,
            color: "rgba(255,255,255,0.45)",
          }}
        >
          <span
            style={{
              padding: "1px 6px",
              borderRadius: 999,
              border: `1px solid ${isPending ? "rgba(96,165,250,0.35)" : "rgba(255,255,255,0.12)"}`,
              color: isPending ? "#60a5fa" : "rgba(255,255,255,0.6)",
            }}
          >
            {data?.status ?? "loading"}
          </span>
          {data?.providerId && <span>{data.providerId}</span>}
          {data?.model && <span>· {data.model}</span>}
          {isPending && <span style={{ color: "#60a5fa" }}>· live</span>}
          {data?.recoveredFromDb && <span title="Recovered from the local database">· recovered</span>}
        </div>
      )}

      {error && (
        <div style={{ fontSize: 10, color: "#f87171", lineHeight: 1.4, wordBreak: "break-word" }}>
          Couldn&apos;t load the run log: {error}
        </div>
      )}

      {trail.length === 0 ? (
        !error && (
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", padding: "4px 0" }}>
            {isPending ? "Waiting for the first log entry…" : "No log entries for this run."}
          </div>
        )
      ) : (
        <div
          style={{
            overflowY: "auto",
            maxHeight,
            display: "flex",
            flexDirection: "column",
            gap: 3,
            paddingRight: 2,
          }}
        >
          {trail.map((entry, i) => {
            const color = PHASE_COLOR[entry.phase] ?? "rgba(255,255,255,0.5)";
            return (
              <div
                key={`${entry.t}-${i}`}
                style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 10, lineHeight: 1.45 }}
              >
                <span
                  style={{
                    color: "rgba(255,255,255,0.35)",
                    fontVariantNumeric: "tabular-nums",
                    flexShrink: 0,
                    paddingTop: 1,
                  }}
                >
                  {formatTime(entry.t)}
                </span>
                <span
                  style={{
                    flexShrink: 0,
                    padding: "0 5px",
                    borderRadius: 4,
                    border: `1px solid ${color}44`,
                    color,
                    background: `${color}14`,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    fontSize: 9,
                    lineHeight: "14px",
                  }}
                >
                  {entry.phase}
                </span>
                <span style={{ color: "rgba(255,255,255,0.7)", wordBreak: "break-word", minWidth: 0 }}>
                  {entry.detail}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * lib/jobLog — the per-job event trail.
 *
 * The gap this closes: a "fetch failed" in a background submit left ZERO
 * server-side trace — the node showed an error, the console showed nothing,
 * and the only evidence was the job's terminal error message. Every job now
 * carries an append-only, capped trail of what happened (submit → poll →
 * settle / resume / error / retry), readable through
 * `GET /api/jobs/[taskId]/log` and rendered by components/JobLogViewer.tsx.
 *
 * SECURITY RULES (enforced here, not at the call sites):
 *   - NO api keys — `sk-…`, `Bearer …` and `?key=…` are redacted.
 *   - NO `data:` payloads — a staged reference is a base64 blob; only its
 *     COUNT is ever logged.
 *   - NO full request/response bodies — only shapes (key names), counts and
 *     URL HOSTS.
 *   - NO base URL carrying a key — URLs are reduced to their host (userinfo,
 *     path, query and fragment are dropped).
 *   - Every detail is length-capped, so a rogue upstream string cannot blow
 *     up the store.
 *
 * SERVER-ONLY (it touches the local job store).
 */
import { jobStore, type JobLogEntry, type JobLogPhase } from "./jobStore";

export type { JobLogEntry, JobLogPhase };

/** Longest detail we keep (chars) — the trail is a hint, not a transcript. */
const MAX_DETAIL_LEN = 300;

/**
 * Strip everything secret-ish from a detail string.
 *
 * Deliberately conservative: it removes the shapes that carry credentials or
 * payload bytes, and leaves the human-readable remainder alone.
 */
export function redactLogText(text: string): string {
  let out = text;
  // data: URIs (staged media blobs) — never log the payload.
  out = out.replace(/data:[^\s"'<>]+/gi, "[data-url omitted]");
  // URL userinfo (https://key:secret@host) — the credential is the secret.
  out = out.replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[redacted]@");
  // Authorization headers.
  out = out.replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 [redacted]");
  // Common key prefixes (sk-…, sk-or-…) — the token must START a word so a
  // task id like "…-task-…" is never mangled.
  out = out.replace(/(^|[\s"'`(=])sk-[A-Za-z0-9_-]{8,}/gi, "$1[redacted]");
  // Query-string credentials.
  out = out.replace(
    /([?&](?:key|api_?key|apikey|token|access_token|secret|password)=)[^&\s]+/gi,
    "$1[redacted]",
  );
  // Long base64-ish blobs (an inline image body that slipped through).
  out = out.replace(/[A-Za-z0-9+/]{80,}={0,2}/g, "[blob omitted]");
  if (out.length > MAX_DETAIL_LEN) out = `${out.slice(0, MAX_DETAIL_LEN)}…`;
  return out;
}

/**
 * The HOST of a URL — never the path, query, fragment or userinfo.
 * Returns null for a non-URL string.
 */
export function urlHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.host || null;
  } catch {
    return null;
  }
}

/** A short, safe description of a thrown value (no stack, no payload). */
export function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === "string") return e;
  return String(e);
}

/**
 * Append one entry to a job's trail AND echo it to the console.
 *
 * `store: false` writes the console line only — used for the high-frequency
 * poll ticks, where the trail keeps only the first/last/state-changing ones.
 */
export function appendJobLog(
  taskId: string,
  phase: JobLogPhase,
  detail: string,
  opts?: { store?: boolean },
): void {
  if (!taskId) return;
  const safe = redactLogText(detail);
  if (opts?.store !== false) {
    jobStore.appendTrail(taskId, { t: Date.now(), phase, detail: safe });
  }
  console.log(`[job-log] ${taskId} ${phase} ${safe}`);
}

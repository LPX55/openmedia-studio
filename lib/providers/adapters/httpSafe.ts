/**
 * Shared HTTP/URL SAFETY helpers for the adapter families (P7 plan §f).
 *
 * Opened for P7c (MCP): gradio.ts's origin-pin logic stopped being private —
 * the mcp family must make the SAME guarantees, so the implementation gets
 * exactly one home ("do not duplicate the logic", review of 83f93c9).
 *
 * The two guarantees every carrier-of-credentials/value must keep:
 *
 *  1. ORIGIN PIN — a URL that was earned from a REMOTE payload (a file
 *     reference in a tool result / status stream) may only ever point at the
 *     origin we pinned ourselves (the binding/statusUrl origin). The gradio
 *     review blocker on 7177592 names the two concrete attacks: a bearer
 *     byte fetch would carry the user's token to a foreign host (exfil), and
 *     a settle-mirror mediaUrl would be adapter-introduced SSRF (the funnel
 *     fetch has no host validation and follows redirects).
 *  2. REDIRECT OFF — a pinned-host request that answers 30x must NOT be
 *     followed: the Location target would inherit the request it is exactly
 *     what "pinned" tries to prevent. `redirect: "error"` turns any redirect
 *     into a transport failure (transient, retried) — never a relay.
 *
 * SERVER-ONLY (adapter shared module — the eslint wall keeps adapters out of
 * client bundles).
 */

/**
 * http(s), no userinfo, origin === pinned origin. Everything else is "no" —
 * including parse failure (an unparseable candidate is never a target).
 */
export function sameOriginSafe(candidate: string, origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (parsed.username || parsed.password) return false;
  return parsed.origin === origin;
}

/**
 * The ONE fetch the adapters use whenever a request carries the provider's
 * token (or anything that could turn into one): `redirect: "error"` is not
 * optional, and the per-call timeout is ALWAYS set — no adapter POST may
 * outlive its job's own budget thinking about it.
 */
export async function pinnedFetch(
  url: string,
  {
    method,
    headers,
    body,
    timeoutMs,
  }: {
    timeoutMs: number;
    method?: string;
    headers?: Record<string, string>;
    body?: BodyInit;
  } = { timeoutMs: 10 * 60_000 },
): Promise<Response> {
  return fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
}

// ── Minimal SSE reader (the wire grammar both families stream) ──────────────

/**
 * One SSE frame: the `event:` value and the joined `data:` payload.
 * (Gradio/MCP `data:` may be split across lines on transport — join "\n".)
 */
export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Pull complete frames out of a growing buffer; the remainder (a possibly
 * partial trailing frame) is returned to the caller so streaming consumers
 * can keep it. Frame boundary = blank line (`\n\n`).
 */
export function framesFrom(chunk: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  // WIRE REALITY (P7c finding): real servers frame SSE with CRLF — every
  // committed capture under docs/fixtures/phase7 is "\r\n"-framed. Normalise
  // here, once, so every family speaks the same grammar; a family-local
  // normalisation is how gradio.ts ended up proving its parser against a
  // wire format real Spaces do not send.
  //
  // A trailing lone CR is HELD BACK: chunk boundaries can fall between the
  // "\r" and the "\n", and converting that "\r" to "\n" early would fabricate
  // a frame boundary out of nothing.
  let working = chunk;
  let heldCr = false;
  if (working.endsWith("\r")) {
    working = working.slice(0, -1);
    heldCr = true;
  }
  working = working.replace(/\r\n/g, "\n");

  let rest = working;
  for (;;) {
    const idx = rest.indexOf("\n\n");
    if (idx < 0) break;
    const block = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    frames.push({ event, data: dataLines.join("\n") });
  }
  // Give the held CR back: this call must not consume it, or a "\r\n" split
  // across chunks would lose the CR (and a CR that is DATA would be eaten).
  if (heldCr) rest += "\r";
  return { frames, rest };
}

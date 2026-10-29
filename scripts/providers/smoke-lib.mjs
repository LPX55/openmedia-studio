/**
 * smoke-lib — shared, dependency-free harness for the offline provider smoke
 * fixtures in scripts/providers/.
 *
 * Extracted from smoke-compat.mjs so the upcoming gradio/mcp fixtures can reuse
 * the same infrastructure:
 *
 *   - assertion helpers (ok / eq / section + passed / failures / summarize);
 *   - quiet() — console.log suppression unless HELIOS_SMOKE_VERBOSE=1;
 *   - fakeResponse() — a Response-alike with a REAL ReadableStream body, so a
 *     fixture can replay byte-streamed responses with per-chunk delays, forced
 *     mid-frame splits (splitAt / splitEveryNBytes) and cancellation;
 *   - sseFrames() — canonical `event: …\ndata: …\n\n` SSE replay (plus
 *     heartbeat-only / EOF-without-complete builders);
 *   - installFetchStub() — records calls, consults a per-fixture responder and
 *     HONORS init.signal (an abort rejects the fetch with an AbortError and
 *     errors the response body so an in-flight reader surfaces it too).
 *
 * Zero dependencies, plain ESM: `node scripts/providers/<fixture>.mjs` runs it
 * with no build step.
 */

export const HARNESS_VERSION = "phase7-rev1";

// ── Assertions ───────────────────────────────────────────────────────────────
export let passed = 0;
export const failures = [];

export function ok(name, condition, detail) {
  if (condition) {
    passed++;
    return true;
  }
  failures.push(detail ? `${name} — ${detail}` : name);
  return false;
}

export function eq(name, actual, expected) {
  const same = Object.is(actual, expected) ||
    JSON.stringify(actual) === JSON.stringify(expected);
  return ok(
    name,
    same,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

export function section(title) {
  console.log(`\n▸ ${title}`);
}

/** Current tallies; `failures` is the live list (length = failure count). */
export function summarize() {
  return { passed, failures };
}

/** Swallow the adapter's request log unless HELIOS_SMOKE_VERBOSE=1. */
export function quiet(fn) {
  const original = console.log;
  if (process.env.HELIOS_SMOKE_VERBOSE === "1") return fn();
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = original;
  }
}

// ── Small internals ──────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An Error with DOMException's AbortError name (works on every Node >= 22). */
function abortError(message = "The operation was aborted.") {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

function toBuffer(part) {
  if (Buffer.isBuffer(part)) return part;
  if (part instanceof Uint8Array) {
    return Buffer.from(part.buffer, part.byteOffset, part.byteLength);
  }
  return Buffer.from(String(part), "utf8");
}

/**
 * Cut a buffer at `splitAt`:
 *   - number N  → every N bytes (forced mid-frame splits);
 *   - number[]  → at those absolute byte offsets;
 *   - null      → one piece.
 */
function splitBytes(buf, splitAt) {
  let cuts = [];
  if (typeof splitAt === "number") {
    if (Number.isFinite(splitAt) && splitAt > 0) {
      for (let i = splitAt; i < buf.length; i += splitAt) cuts.push(i);
    }
  } else if (Array.isArray(splitAt)) {
    cuts = [...new Set(
      splitAt.filter((n) => Number.isFinite(n) && n > 0 && n < buf.length),
    )].sort((a, b) => a - b);
  }
  if (cuts.length === 0) return buf.length === 0 ? [] : [buf];
  const pieces = [];
  let from = 0;
  for (const cut of cuts) {
    pieces.push(buf.subarray(from, cut));
    from = cut;
  }
  pieces.push(buf.subarray(from));
  return pieces.filter((piece) => piece.length > 0);
}

// ── Response-alike with a real streaming body ────────────────────────────────
/**
 * Minimal `Response`-alike for stubbed fetch calls.
 *
 * opts:
 *   ok / status / bytes / contentType — legacy knobs, unchanged behavior;
 *   chunks          — Array<string|Buffer> delivered through `body`;
 *   chunkDelayMs    — delay before each enqueue (a slow upstream);
 *   splitAt         — number (every N bytes) or offsets, forcing mid-frame cuts.
 *
 * `text()`, `arrayBuffer()` and `json()` always return the CONCATENATION (so
 * callers that never touch `body` behave exactly as before). `body` is a real
 * ReadableStream: getReader() works, bodyUsed flips, and `_errorBody()` (used by
 * installFetchStub) makes an in-flight reader reject on abort.
 */
export function fakeResponse(payload, opts = {}) {
  const {
    ok = true,
    status = 200,
    bytes = null,
    contentType = "application/json",
    chunks = null,
    chunkDelayMs = 0,
    splitAt = null,
  } = opts;

  const hasChunks = Array.isArray(chunks);
  const chunkBytes = hasChunks ? Buffer.concat(chunks.map(toBuffer)) : null;
  const text = hasChunks
    ? chunkBytes.toString("utf8")
    : typeof payload === "string"
      ? payload
      : JSON.stringify(payload);
  const bodyBytes = hasChunks ? chunkBytes : bytes ?? Buffer.from(text, "utf8");
  const segments = hasChunks && splitAt === null
    ? chunks.map(toBuffer).filter((chunk) => chunk.length > 0)
    : splitBytes(bodyBytes, splitAt);
  const delayMs = Number.isFinite(chunkDelayMs) && chunkDelayMs > 0 ? chunkDelayMs : 0;

  let controller = null;
  let stopped = false;
  let startedResolve;
  let doneResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const done = new Promise((resolve) => { doneResolve = resolve; });

  const fail = (err) => {
    if (stopped) return;
    stopped = true;
    try {
      controller?.error(err);
    } catch {
      /* the stream was already closed/cancelled */
    }
    startedResolve();
    doneResolve();
  };

  const body = new ReadableStream({
    start(c) {
      controller = c;
      void (async () => {
        try {
          for (let i = 0; i < segments.length; i += 1) {
            if (delayMs > 0) await sleep(delayMs);
            if (stopped) return;
            c.enqueue(new Uint8Array(segments[i]));
            if (i === 0) startedResolve();
          }
          if (stopped) return;
          stopped = true;
          c.close();
          startedResolve();
          doneResolve();
        } catch (err) {
          fail(err);
        }
      })();
    },
  });

  // Make bodyUsed sticky: a reader that has drained (and releaseLock()ed) the
  // stream still reports the body as used, like a real Response.
  let streamUsed = false;
  const nativeGetReader = body.getReader.bind(body);
  body.getReader = (...args) => {
    streamUsed = true;
    return nativeGetReader(...args);
  };
  Object.defineProperty(body, "bodyUsed", {
    configurable: true,
    get: () => streamUsed,
  });

  let consumed = false;
  let jsonPromise = null;

  return {
    ok,
    status,
    body,
    get bodyUsed() {
      return consumed || streamUsed || body.locked;
    },
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        if (key === "content-type") return contentType;
        if (key === "content-length") return String(bodyBytes.length);
        // Legacy fallback kept for the existing fixtures.
        return "application/json";
      },
    },
    text: async () => {
      consumed = true;
      return text;
    },
    arrayBuffer: async () => {
      consumed = true;
      const copy = Buffer.from(bodyBytes);
      return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
    },
    json: async () => {
      consumed = true;
      if (!jsonPromise) jsonPromise = Promise.resolve().then(() => JSON.parse(text));
      return jsonPromise;
    },
    // Internal hooks for installFetchStub (not part of the Response surface).
    _errorBody: fail,
    _started: started,
    _done: done,
  };
}

// ── SSE replay ───────────────────────────────────────────────────────────────
function serializeFrame(frame) {
  const event = frame?.event ?? "message";
  const data = frame?.data;
  const serialized = data === null
    ? "null"
    : typeof data === "string"
      ? data
      : JSON.stringify(data);
  // One data line per source line, canonical SSE framing.
  const dataLines = String(serialized)
    .split(/\r?\n/)
    .map((line) => `data: ${line}`)
    .join("\n");
  return `event: ${event}\n${dataLines}\n\n`;
}

/**
 * Replay `frames` as a canonical SSE byte stream.
 *
 *   frames: Array<{ event?: string, data: string | object | null }>
 *   opts:   { splitEveryNBytes?: number, chunkDelayMs?: number }
 *
 * `splitEveryNBytes` forces mid-frame cuts: a consumer must buffer until the
 * blank line (`\n\n`) before parsing. `data: null` is the heartbeat wire form.
 */
export function sseFrames(frames, { splitEveryNBytes = null, chunkDelayMs = 0 } = {}) {
  const wire = frames.map(serializeFrame).join("");
  return fakeResponse(wire, {
    contentType: "text/event-stream",
    splitAt: splitEveryNBytes,
    chunkDelayMs,
  });
}

/** Only heartbeat/null frames — EOF with no complete/message event. */
export function sseHeartbeatOnly(opts = {}) {
  return sseFrames(
    [
      { event: "heartbeat", data: null },
      { event: "heartbeat", data: null },
    ],
    opts,
  );
}

/** A progress frame, then EOF — never a complete/message event. */
export function sseEofNoComplete(opts = {}) {
  return sseFrames([{ event: "progress", data: { status: "pending" } }], opts);
}

// ── Fetch stub ───────────────────────────────────────────────────────────────
/**
 * Install a global fetch stub that records calls and consults `getResponse`.
 *
 *   const { calls, clear, restore } = installFetchStub((url, init) => …);
 *
 * `calls` IS the shared array: `calls.length = 0` / `calls[i].init` keep working.
 * `getResponse` returns a fakeResponse (or any Response-alike). Every call is
 * recorded WHOLESALE as `{ url: String(url), init }` — no normalization.
 *
 * init.signal is honored:
 *   - already aborted → the call rejects with an AbortError (and is recorded);
 *   - aborting while the response is still being prepared (e.g. a chunk delay)
 *     → the whole fetch rejects with AbortError;
 *   - aborting while the body streams → the body is errored, so an in-flight
 *     reader rejects with AbortError;
 *   - the listener is removed once the fetch/body settles.
 */
export function installFetchStub(getResponse, { calls = [] } = {}) {
  const previousFetch = globalThis.fetch;

  const fetchStub = async (url, init) => {
    calls.push({ url: String(url), init });
    const signal = init?.signal;
    if (!signal) return getResponse(url, init);
    if (signal.aborted) throw abortError();

    let response = null;
    let fetchSettled = false;
    let removeListener = () => {};

    const aborted = new Promise((_, reject) => {
      const onAbort = () => {
        const err = abortError();
        // Reject first: `_errorBody` settles the body's readiness promise, and
        // the fetch race must see the abort, not a "stream started" resolution.
        if (!fetchSettled) reject(err);
        if (response?._errorBody) response._errorBody(err);
        removeListener();
      };
      removeListener = () => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    // The race below consumes this while pending; swallow the later rejection
    // when the fetch has already resolved (the body is errored instead).
    aborted.catch(() => {});

    const pending = Promise.resolve().then(() => getResponse(url, init));

    try {
      response = await Promise.race([pending, aborted]);
      // Wait for the first body chunk so an abort during an early chunk delay
      // rejects the fetch itself, not only the body.
      if (response?._started) await Promise.race([response._started, aborted]);
      if (signal.aborted) throw abortError();
      fetchSettled = true;
      if (response?._done) {
        Promise.resolve(response._done).then(removeListener, removeListener);
      } else {
        removeListener();
      }
      return response;
    } catch (err) {
      fetchSettled = true;
      removeListener();
      throw err;
    }
  };

  globalThis.fetch = fetchStub;

  return {
    calls,
    clear() {
      calls.length = 0;
    },
    restore() {
      globalThis.fetch = previousFetch;
    },
  };
}

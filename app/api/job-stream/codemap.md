# /api/job-stream — SSE job result stream

## Responsibility
Server-Sent Events endpoint that delivers the settled result of a generation job
as soon as it lands, avoiding tight client polling. Uses the same recovery path
as `/api/job-status` (jobStore → `resumeJob` → `generations` row).

## Design
- `GET /api/job-stream?taskId=<id>` (400 plain-text `taskId required`).
- **Settled already** (`jobStore` hit with a non-`pending` status) → immediate
  single `data: {...}\n\n` frame, no stream opened.
- **Pending store hit** → `resumeJob(taskId)`; if the settle lands inline, emit
  immediately.
- **Store miss** → `guestDb.recoverJob(taskId)`:
  - terminal row → re-hydrate `jobStore` and emit immediately;
  - pending row → `resumeJob()`, re-check, else seed a pending `jobStore` entry
    from the row (`generation_type`, `provider_id`, `provider_meta`) and stream;
  - no row → immediate `{ status: "error", error: "Job not found" }`.
- Stream (`ReadableStream`):
  - **race guard** — the store is re-read inside `start()`; a settle that landed
    between `resumeJob` and the stream starting is enqueued and closed directly
    (before the heartbeat/timeout handles exist, so `close()` never touches them).
  - `jobEvents.once('job:${taskId}', send)` — one-shot, first payload closes.
  - heartbeat comment `: ping` every **25 s** so proxies don't drop the idle connection.
  - hard cap `TIMEOUT_MS = 12 min` → emits
    `{ status: "error", error: "Generation timed out" }` then closes.
  - `req.signal` abort → unsubscribe (`jobEvents.off`) + close.
- Headers: `text/event-stream`, `no-cache`, `keep-alive`.

## Flow
1. Parse `taskId` → immediate-settle / recovery paths.
2. Else register the listener + heartbeat + timeout; the stream closes on the
   first payload, the hard cap, or client abort.

## Integration
- **Stores**: `jobStore` (`lib/jobStore.ts`), `jobEvents` emitter
  (`lib/jobEvents.ts`) fed by `settleJob` (`lib/jobManager.ts`),
  `guestDb.recoverJob`.
- **Job manager**: `resumeJob` restarts polling for recoverable providers and
  settles orphaned in-process jobs — replaces the old `azure-*` prefix checks.
- **Response**: SSE `data:` frames carrying the `JobResult` union
  (`done` / `error` payloads); errors before the stream are also SSE frames.

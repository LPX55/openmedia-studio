# /api/job-stream — SSE job result stream

## Responsibility
Server-Sent Events endpoint that delivers the settled result of a generation job
as soon as it lands, avoiding tight client polling. Falls back to DB recovery
and poller restart just like `/api/job-status`.

## Design
- `GET /api/job-stream?taskId=<id>` (400 plain-text `taskId required`).
- **Settled already** (`jobStore` hit with non-`pending` status) → immediate
  single `data: {...}\n\n` frame, no stream opened.
- **Store miss** → `recoverJob()` from the `generations` row; on hit, re-seed
  `jobStore` and emit immediately; on miss → immediate
  `{ status: "error", error: "Job not found" }`.
- **Pending** → `resumeKieJob(taskId, type)` for non-`azure-*` ids (restarts a
  poller lost to a server restart), then open a `ReadableStream`:
  - waits on `jobEvents.once('job:${taskId}', send)` — one-shot, then closes.
  - heartbeat comment `: ping` every **25 s** so proxies don't drop the idle connection.
  - hard cap `TIMEOUT_MS = 12 min` → emits
    `{ status: "error", error: "Generation timed out" }` then closes.
  - `req.signal` abort → unsubscribe + close.
- Headers: `text/event-stream`, `no-cache`, `keep-alive`.

## Flow
1. Parse `taskId` → immediate-settle / recovery paths.
2. Else register event listener + heartbeat + timeout; stream closes on first payload.

## Integration
- **Stores**: `jobStore` (`lib/jobStore.ts`), `jobEvents` emitter
  (`lib/jobEvents.ts`) fed by `lib/kieJobPoller.ts`, `guestDb.recoverJob`.
- **Poller**: `resumeKieJob` for kie tasks; `azure-*` tasks are callback-free and
  settle only if the in-process Azure IIFE is still alive.
- **Response**: SSE `data:` frames carrying the `JobResult` union
  (`done` / `error` payloads).

# /api/job-status — one-shot job poll

## Responsibility
Returns the current state of a generation task from the in-memory `jobStore`,
falling back to SQLite recovery and poller resumption when the server restarted
and lost the store.

## Design
- `GET /api/job-status?taskId=<id>` (400 `taskId is required` when missing).
- Lookup order:
  1. **Store hit** → return as-is. If `status === "pending"`, call
     `resumeJob(taskId)` first (restarts a lost poll loop, or settles an orphaned
     in-process Azure/Codex job) and return the refreshed record when the settle
     landed inline.
  2. **Store miss** → local `recoverJob(taskId)` reads the `generations` row:
     `done` → re-hydrate `jobStore` with `{ videoUrl }` or
     `{ imageUrl, imageUrls }` (+ `providerId`) and return it; `error` →
     `{ status: "error", error: error_msg, providerId }`; `pending` →
     `resumeJob()` then re-read, else `{ status: "pending" }`.
  3. Nothing → `{ status: "not_found" }`.
- No task-id prefix shortcuts: the old `azure-*` / `codex-*` "memory-only" rule is
  gone. Every job (`submitJob` pre-mints a pending `generations` row) is
  recoverable, and `resumeJob` is the single guard against false-killing a live
  job (`activeSubmits` / `activePollers`, C2).

## Flow
1. Parse `taskId`.
2. Store lookup → (pending ⇒ `resumeJob`) → response.
3. DB recovery for store misses → re-hydrate or resume → response.

## Integration
- **Stores**: `jobStore` (`lib/jobStore.ts`), `guestDb.recoverJob`
  (`lib/guest/db.ts` → `generations`).
- **Job manager**: `resumeJob` (`lib/jobManager.ts`) — restarts polling for
  providers with a `poll()` (Kie, compat video), settles orphaned in-process
  Azure/Codex jobs as `error`, leaves unknown providers pending.
- **Response**: `JobResult` union — `{ status: "pending" }`,
  `{ status: "done", videoUrl?|imageUrl?, imageUrls?, providerId? }`,
  `{ status: "error", error, providerId? }`, `{ status: "not_found" }`.
- **Alternatives**: `/api/job-stream` (SSE push), `/api/jobs/[taskId]/log`
  (event trail).

# /api/job-status — one-shot job poll

## Responsibility
Returns the current state of a generation task from the in-memory `jobStore`,
falling back to SQLite recovery when the server restarted and lost the store.

## Design
- `GET /api/job-status?taskId=<id>` (400 if missing).
- Three-tier lookup:
  1. `jobStore.get(taskId)` hit → return as-is. If still `pending` and not an
     `azure-*` id, call `resumeKieJob(taskId, type)` to restart the background
     poller killed by the restart (type from `result.type`, default `image`).
  2. Store miss → `recoverJob(taskId)` reads the `generations` DB row:
     `done` → re-hydrate `jobStore` with `{ videoUrl }` or `{ imageUrl, imageUrls }`
     and return it; `error` → `{ status: "error", error: error_msg }`; still
     `pending` → `{ status: "pending" }`.
  3. Nothing → `{ status: "not_found" }`.
- `azure-*` ids are memory-only (no DB record), so a store miss returns
  `not_found` immediately without recovery or poller resume.

## Flow
1. Parse `taskId`.
2. Store lookup → (optional `resumeKieJob`) → response.
3. DB recovery path for non-Azure ids.

## Integration
- **Stores**: `jobStore` (`lib/jobStore.ts`), `guestDb.recoverJob`
  (`lib/guest/db.ts` → `generations`).
- **Poller**: `resumeKieJob` (`lib/kieJobPoller.ts`); completions are pushed back
  into `jobStore` by `pollKieJob` / `jobEvents`.
- **Response**: `JobResult` union — `{ status: "done", videoUrl?|imageUrl?, imageUrls? }`,
  `{ status: "error", error }`, `{ status: "pending" }`, `{ status: "not_found" }`.
- **Alternative**: `/api/job-stream` (SSE) for push-style waiting.

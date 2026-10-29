# /api/jobs/[taskId]/log — per-job event trail

## Responsibility
Reads the append-only event trail of one generation job (`lib/jobLog.ts`):
what was submitted, which poll ticks ran, when it settled, and why it failed.
The server-side counterpart of `components/JobLogViewer.tsx`.

## Design
- `GET /api/jobs/[taskId]/log` — App Router dynamic segment, `params` is a
  Promise (`{ params }: { params: Promise<{ taskId: string }> }`).
- Sources, in order:
  1. `jobStore.get(id)` → `.trail` (the live record, also persisted in
     `.job-store.json`);
  2. `generations.job_log` — the copy written by `settleJob` at settle time
     (JSON array of `{ t, phase, detail }`, parsed defensively; malformed rows
     yield `[]`);
  3. empty trail.
- `recoveredFromDb` is `true` when the trail came from the row, or when the
  in-memory record is gone but a `generations` row exists.
- Response: `{ taskId, status, providerId, model, trail, recoveredFromDb,
  updatedAt?, lastError? }`.
  - `status` = store status → row status → `"not_found"`;
  - `providerId` = store → row → `null`;
  - `model` and `updatedAt` / `lastError` come from the row only.
- Empty/blank id → 400 with the same empty shape (`trail: []`).
- **Never 500s**: `guestDb.recoverJob()` is wrapped in try/catch and an unknown
  task answers 200 `{ status: "not_found", trail: [] }`.
- Read-only: no writes, no auth; redaction (keys, `data:` payloads, URL
  userinfo/query, long blobs) already happened at append time in `lib/jobLog.ts`.

## Flow
1. Await `params` → trim `taskId`.
2. Read `jobStore` → read `generations` row (tolerant).
3. Prefer the store trail, else parse `job_log`.
4. Respond with the merged shape.

## Integration
- **Stores**: `jobStore` (`lib/jobStore.ts` — `JobLogEntry`,
  `JobLogPhase`, `JOB_LOG_CAP = 50`), `guestDb.recoverJob`
  (`lib/guest/db.ts` → `generations.job_log`).
- **Writers**: `appendJobLog` (`lib/jobLog.ts`) from `submitJob`,
  `startPolling`, `settleJob`, `resumeJob` (`lib/jobManager.ts`) and the
  provider adapters; `settleJob` mirrors the capped trail into `job_log`.
- **Consumer**: `components/JobLogViewer.tsx` (fetches with `cache: "no-store"`).
- **Related**: `/api/job-status` (state only), `/api/job-stream` (SSE state).

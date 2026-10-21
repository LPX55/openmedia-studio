# STATE
status: done        # active | paused | blocked | done
focus: provider migration journey documented (docs/provider-migration-journey.md); P1→P6 all committed on feat/pluggable-providers at 7208ce4, nothing pushed
next: build the workflow automations pack (realistic image + video workflows across input types and endpoints); live video test still awaits a spend decision; merge awaits push approval
blockers: none
updated: 2026-10-21

## Notes

- 2026-10-21 — JOURNEY DOC: `docs/provider-migration-journey.md` records the
  whole provider migration as narrative — starting state (client-driven routing,
  9-way video switch, two-key credentials, no endpoint concept), the constraints
  that decided the architecture (no vendor locks, one compat contract, presets
  for robustness, cost as a ranking factor, server authority), the paths killed
  (fal, aggregators, HF, Segmind, SpicyAPI-as-compat, dedicated adapters, custom
  endpoint UI, harness day), the architecture (catalog vs bindings, dialect as
  binding data, one settle funnel, preset resolution), a phase chronicle
  P1→P6-video with what each lane proved, the 11 live findings that changed code
  (auto-ratio 400, refs as objects, numeric seed, bearer content endpoint, no
  video upload endpoint, `/images` vs `/v1/images/generations`, per-model
  endpoints 404…), the pricing doctrine + captured numbers, the process rules
  (spike-before-bind, promotion gate, 432-assertion offline fixture, eslint
  zero-new-vs-HEAD), an honest failure list (mapping ≠ capability on video, disk
  100% full, P3 gate failure, unverified kie apiIds, flagged UI gaps), and the
  open-items table. Numbers verified against the tree: 40 catalog models
  (20/20), 84 built-in bindings, 5 registered adapters, 4 presets, 432 smoke
  assertions.

- 2026-10-21 — P6 VIDEO lane (provider-refactor-impl) landed in the WORKING TREE
  (uncommitted, no commits per the task) on `feat/pluggable-providers`: the
  openai-compat family grew an ASYNC video leg beside its sync image leg —
  `POST {base}/videos` → `202 {id, polling_url}` (the relative polling_url is
  resolved against the backend ORIGIN), the poll maps the contract's six
  statuses (pending|in_progress → pending, completed → done, failed|cancelled|
  expired → error with the job's own error string) and a finished task's BYTES
  are fetched from the bearer-authenticated `…/content?index=0` and handed to
  the settle funnel as raw BUFFERS (the "video buffers, not b64" path — the
  funnel's mirror sends no Authorization header, so the bytes must be fetched
  provider-side). 12 OpenRouter video bindings (google/veo-3.1-lite,
  x-ai/grok-imagine-video-1.5 + -lite, kwaiv/kling-3.0-pro + -std,
  bytedance/seedance-2.0-fast + -mini, minimax/hailuo-3 + -max,
  alibaba/wan-2.6, black-forest-labs/flux-video-edit + -upscale) ride the
  existing 6 catalog rows untouched; 3 catalog rows were ADDED (wan-2.6,
  flux-video-edit, flux-video-upscale) with the sweep's caps. The dialect is
  binding data (`fields` + new sources duration/sound/frames/inputReferences,
  `maxFrames`, `maxReferences`, `durationMin/Max`, `defaultDuration`,
  `referenceFrame`, `constants`): the duration is re-clamped to the model's own
  limits (minimax 4 → 5), unsupported tiers are DROPPED (the "auto" ratio —
  the router 400s on it — and 4k/2K/1080p), Kling's resolution is pinned to
  720p, and a model with no duration picker sends the binding's own default.
  The video lane stages media as "remote-url" (OpenRouter takes HTTPS URLs
  only and documents NO upload endpoint ⇒ a local file fails LOUDLY). The
  jobManager's resumeJob now restarts the poll loop for any registered
  provider with a poll implementation (kie is unchanged) and the video route
  refuses an image-only backend. Validated: tsc exit 0, eslint zero-new-vs-HEAD
  (git-stash compare, 0 = 0), the offline smoke fixture green at 432
  assertions (new video section: body shape, clamp/drop/default, async submit,
  all six poll statuses, the content download, and a route-level end-to-end —
  stubbed fetch ONLY, zero network). NOT live-tested: the registry's pricing
  column is still uncaptured ⇒ the cost of a live run is UNVERIFIED.

- 2026-10-21 — Job trail + run-log viewer landed in the WORKING TREE (uncommitted, no
  commits per the task) on `feat/pluggable-providers`: `lib/jobLog.ts` appends a
  per-job, capped (last 50) event trail `{ t, phase, detail }` onto the jobStore
  record — phases submit/poll/settle/resume/error/retry, every detail REDACTED
  (no api keys, no `data:` payloads, no full bodies, URL hosts only). The
  jobManager funnel (submitJob pre-mint → startPolling → settleJob → resumeJob)
  is instrumented; the openai-compat submit got a bounded fetch (12-min budget,
  ONE retry on transport failures only — HTTP 4xx/5xx are never replayed) and
  logs attempt/timeout/status-class/error-kind. The trail is mirrored into the
  new idempotent `generations.job_log` TEXT column at settle time and read
  through `GET /api/jobs/[taskId]/log` (never 500s; falls back to the
  generations row). `components/JobLogViewer.tsx` renders the phase timeline
  and is wired into GenerateNode + VideoGeneratorNode ("Run log" disclosure)
  and the gallery's pending tiles; the node status machine is untouched (a new
  read-only `lastTaskId` node field keeps the log reachable after a run ends).
  Validated: tsc exit 0, eslint zero-new-vs-HEAD (git-stash compare, 53 = 53),
  the offline smoke fixture green at 291 assertions (new trail-cap /
  retry-once / redaction / read-API section, stubbed fetch — zero network), and
  the `job_log` migration verified on a copy of the real guest.db (3 rows kept,
  idempotent on re-open). HOST NOTE: the root filesystem was 100% FULL (0 bytes
  free) mid-task — the regenerable `.next/` build dir (526 MB) was deleted to
  continue (~4.3 GB free now); `node_modules`, `data/` and `public/` were left
  untouched.

- 2026-10-20 — P6c (provider-refactor-impl) landed the Pollinations sync leg on
  `feat/pluggable-providers` — NO dedicated adapter: the backend is a second
  ALIAS of the openai-compat family (`provider.id "pollinations"`, keyEnv
  `POLLINATIONS_API_KEY`, base `https://gen.pollinations.ai`, path
  `/v1/images/generations`). 11 static image bindings carry the spike's exact
  upstream ids (gemini-2.5/3.1/3-pro/3.1-lite image, z-image-turbo, seedream
  5.0 lite/pro, grok-imagine-image, gpt-image-2 + 2.5 flare/sunburst) with the
  upstream reference caps; VIDEO is out (weak lane). The adapter grew a
  GENERIC `uploadMedia` (binding-configured endpoint + field convention;
  multipart/raw/base64) so the "remote-url" staging of a binding (Pollinations'
  media store `media.pollinations.ai/upload`) works — data-url backends
  (OpenRouter) never reach it. New dialect sources `width`/`height` (Pollinations
  takes numeric px, not the "WxH" `size` string) + `referenceMode`; the
  `pollinations-sync` preset was corrected to the real dialect and the code
  seed is now authoritative (v1 has no preset editor). Validated: tsc exit 0,
  eslint zero-new-vs-HEAD (only the pre-existing SettingsModal setState-in-
  effect error), the offline smoke fixture green at 263 assertions (Pollinations
  binding resolution + request body + media upload + remote-url staging + the
  settings report, all via a stubbed fetch — zero network).
- 2026-10-20 — P6b (provider-refactor-impl) landed the compat-plan §(c)+(d) layer on
  `feat/pluggable-providers`: `param_presets` table + four code-seeded presets
  (standard-image, image-edit, openrouter-dialect, pollinations-sync) seeded
  idempotently at schema init (seed JSON validated at seed time — a typo aborts
  the boot); the resolution order `preset params ← binding.paramMap ←
  custom-binding overrides` lives in `registry.resolveForModel` and applies to
  the openai-compat family only (`GenerationProvider.usesParamPresets`); an
  unknown preset id fails the job loudly (binding.presetError → the adapter
  throws → the job settles with the message) — never a silent fallback. The
  SettingsModal API-Keys panel gained a "Compatible endpoints" section (base URL
  + key + preset picker with a view-only JSON preview) wired through
  PUT/DELETE /api/settings/providers (extended with `presetId`; unknown id →
  400), and GET now returns the preset list. Validated: tsc exit 0, eslint
  zero-new-vs-HEAD (repo-wide fingerprint identical to the HEAD baseline), the
  permanent smoke fixture green at 119 assertions (new preset-resolution
  section, incl. a negative test proving the order assertions bite), fresh-DB
  and existing-DB opens clean with idempotent seeding and no data loss.
- 2026-10-20 — P6a landed the openai-compat family (one adapter, OpenRouter
  dialect bindings, offline smoke fixture).
- 2026-10-21 — PRE-SHIP reminder (user): sidebar "Assets" nav is a hardcoded disabled placeholder — revisit the data-storage methodology (guest.db + localStorage + MEDIA_DIR layout, single-user assumptions, export/backup story) before any public ship.

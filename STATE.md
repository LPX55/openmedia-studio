# STATE
status: active      # active | paused | blocked | done
focus: P7 (MCP servers + HF Spaces) SHIPPED through plan step 5 on feat/pluggable-providers — two new provider families, custom logical models, dynamic backends, Add-backend UI, two Spaces bound; 16 commits local and UNPUSHED
next: (1) one deliberate live /edit_image probe to bind prithivMLmods/FireRed-Image-Edit-1.0-Fast (images_b64_json shape is unpublished — do not guess); (2) UAT the new Custom models picker group + Add backend card in a real session; (3) decide whether template graphs should offer Space-backed models (they still resolve to kie bindings); (4) push/PR call on the 16 commits
blockers: none
updated: 2026-10-29

## Notes

- 2026-10-29 — P7 SHIPPED (plan step 5), 15 commits on `feat/pluggable-providers`, every one
  gate-verified before it landed. WHAT EXISTS NOW: a `hf-gradio` family (positional `data[]`
  dialect, per-tick 25s abort budget, SSE poll by event_id, in-adapter bearer byte fetch for
  private Spaces, origin-pinned file URLs, CRLF-safe SSE reader) and an `mcp` family
  (negotiated 2025-06-18 floor, session replay, one re-init on 404, bounded single tools/call,
  four-case defensive parse, images-only v1). Shared `httpSafe` carries the origin pin +
  redirect-refusing bounded fetch + SSE grammar for both. P7a: `kind`-keyed resolve hook so a
  user-created backend id routes to its family adapter while `provider.id` stays the backend,
  dynamic report enumeration, upload-dedupe keyed by provider+baseUrl+input, `allowPrivateUrl`
  gated on BOTH binding and adapter capability, `custom_models` table + one server-side
  catalog resolver (neutral base — never borrowed from a catalog entry), `customModels` in the
  report, custom models in all three pickers, Add-backend card. THREE SILENT-WRONG PATHS
  CLOSED that only binding real Spaces exposed: CompatFieldSource advertised duration/sound/
  frames/inputReferences but resolved all four to undefined (two now implemented, two loud);
  GradioArgMap had no valueMap so minimax's `canvas` Literal silently forced 16:9 on a 9:16
  request; every catalog row received the generic Kie binding so both Space models defaulted
  to a backend that cannot serve them (`kieServable` marker is the only predicate that drops
  exactly those two). BOUND: moss-image-8-step-dmd (t2i) + smd-minimax-h3-ref2va-few-step
  (ref2video — `variant` sits BETWEEN reference_2 and reference_3, the sharpest position≠order
  case yet). DELIBERATELY UNBOUND: JCisHERE/wan2-2-i2v-v3 (adult LoRA enum as a model param is
  a product call, not plumbing — its wire facts still recorded) and FireRed (unpublished
  images_b64_json encoding). Suites: smoke-compat 453, smoke-gradio 103, smoke-mcp 88,
  check-workflows 623; tsc 0 throughout. Docs: docs/adding-a-space-or-mcp-server.md (operator
  walkthrough), docs/provider-phase7-spike.md (live captures + operator-supplied signatures),
  docs/fixtures/phase7/ (byte-exact captures incl. a real DeepWiki tools/call). KNOWN GAPS:
  no custom-MODEL creation form (API-driven by design), template graphs still resolve to kie.

- 2026-10-29 — P7 PLAN DRAFTED (pending peer review): docs/provider-mcp-spaces-plan.md — two new
  provider families: `mcp` (sync tools/call, one adapter for any MCP server incl. HF Space MCP)
  and `hf-gradio` (async queue API, event_id → SSE poll). Key verified facts baked in: Gradio
  rejects the 2026-07-28 MCP revision (pin 2025-06-18), positional `data` arrays from
  /gradio_api/info order (never UI order), private Spaces must return BYTES (funnel mirror sends
  no auth), ZeroGPU quota is caller-attributed (always send the HF token). Deliberately relaxed:
  the old HF-wrapper rejection (Space = user-owned backend) and C6 custom-logical-models ban
  (P7a-1, new `custom_models` table — the one schema-touching lane). Suggested build order:
  P7a infra → P7c mcp → P7b gradio; smoke fixtures follow the offline stubbed-fetch pattern of
  smoke-compat.mjs. AGENTS.md also rewritten in-place this session (compact commands/architecture/
  constraints, all verified against config).

- 2026-10-21 — FORK + RENAME: `SegFault42/HeliosGen` is now forked to **`LPX55/openmedia-studio`** and
  the working tree renamed to match on every user-facing surface — `package.json`
  name, `app/layout.tsx` title, sidebar brand text and GitHub links, hero label,
  toaster alt, `update-check` repo (functional: it would have silently 404'd),
  README (clone URL, badge raw URL, prose, still Tauri-free), DESKTOP.md headings,
  `.env.example` header, workflow-import error string, `mark.svg` aria-label, and
  the codemap headers. Remotes repointed: `upstream` = SegFault42/HeliosGen,
  `origin` = LPX55/openmedia-studio; `feat/pluggable-providers` pushed with
  upstream tracking (the earlier 403 push is resolved — the fork belongs to the
  authenticated account). DELIBERATELY UNCHANGED, as functional identity rather
  than branding: `HELIOS_DATA_DIR`/`HELIOS_MEDIA_DIR`, the localStorage keys
  (`heliosgen-guest`, `heliosgen-chats-guest`), the workflow export format id
  `heliosgen-workflow`, the kie upload path, and everything under `src-tauri/`
  (productName, bundle id `cash.sdd.helios.desktop`, Cargo bin, sidecar) — so
  DESKTOP.md still names `HeliosGen.app`/`.dmg` because that is what the desktop
  build actually produces. A src-tauri rename is a separate, riskier pass.

- 2026-10-21 — OPENROUTER VIDEO LANE OPENED AND VERIFIED LIVE (not just offline):
  three real jobs through `POST /api/generate-video` with `providerId: "openrouter"`,
  zero code paths bypassed. (1) seedance-2-mini 4 s @ 480p prompt-only — submitted
  (202 + polling_url), polled, then FAILED upstream: "output audio may be related
  to copyright restrictions". (2) grok-imagine-1.5 4 s @ 480p from a first frame —
  done in ~30 s, 544×544 h264 + AAC. (3) after the audio fix, seedance-mini same
  prompt — done, 864×496 h264, NO audio stream, ~$0.11. Costs from the live key:
  $0.7676 spent today, $0.34 of the $1/day cap left; grok 480p = 8¢/s + 1¢/image
  input (a 4 s job = $0.33), seedance = token-metered $0.0000035/token.
  THE REAL FINDING: `generate_audio` is a PER-MODEL fact in the live
  `/api/v1/videos/models` record — `true` (seedance fast/mini, hailuo-3, wan-2.6,
  veo-3.1-lite), `false` (hailuo-3-max, no audio at all), `null` (grok-1.5 —
  always renders audio, no parameter; `allowed_passthrough_parameters: []`).
  Declaring it where upstream accepts it fixes a genuine failure mode: the
  seedance job that died on the audio-copyright policy returned a clean
  video-only clip once `sound:false` actually reached the router. An earlier
  grok edit that declared the field was reverted — sending a parameter the model
  does not have is exactly the "params only on a needs basis" rule. Verified
  offline first with a mocked-fetch capture script (`tsx`, no spend) that prints
  the exact outgoing body per model, so the live run was never the first
  evidence. STILL A GAP FOR TEMPLATES: OR video stages media as "remote-url"
  and upstream has NO upload endpoint, so a local `/generated/images/…` cannot
  feed a video node — grok only ran because a still was uploaded to the
  Pollinations media store by hand first. Template graphs therefore still
  resolve to kie bindings (which upload natively) unless a public media host
  exists. Validated: tsc exit 0, `check:workflows` 623 assertions, eslint clean
  on the touched file.

- 2026-10-21 — WORKFLOW TEMPLATE PACK shipped in four commits on
  `feat/pluggable-providers`: `fd886a4` (pack + validator + gallery + R2-thumbnail
  crash fix), `19f8a33` (idle format hint in empty generator nodes), `cbb1d61`
  (adaptive-only ratio no longer collapses a video card), `ce18cba` (28 preview
  SVGs, taller campaign brief, motion-transfer layout). Seven templates —
  product still→motion, character set, assistant brief→campaign kit, first/last
  frame transition, clip remix (video in), motion transfer (video→video), plus
  the legacy UGC board. All graphs are data (`nodes`/`edges`/`nodeCounters`)
  handed to `createSpace`, so they resolve through the same bindings as a
  hand-built canvas. `pnpm check:workflows` = 623 offline assertions over models,
  ratios, handles, durations, quality options, single-slot wires, prompt
  sources, counters, and the idle-start rule. Verified by headless-Chrome
  screenshots: dashboard gallery, product ad, character set, campaign brief,
  clip remix, motion transfer. No live runs executed (spend not approved);
  reference inputs are local placeholders the user replaces.

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

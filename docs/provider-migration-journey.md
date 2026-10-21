# Provider Migration — Journey & Process

A narrative record of how HeliosGen's generation backend went from
client-driven, kie-shaped routing to a provider-agnostic
OpenAI-compatible contract — what was decided, what was rejected, what
the live endpoints taught us, and how the work was validated.

**Scope:** everything on `feat/pluggable-providers` (P1 → P6 video),
2026-10-19 → 2026-10-21. Nothing pushed.

**Companion documents:**

| Document | Role |
|---|---|
| `docs/provider-refactor.md` | The pre-implementation design report: current-state map, target architecture, P1–P5 plan, residual risks. Historical now — the plan it describes has landed. |
| `docs/provider-compat-plan.md` | The rescoped Phase 6 plan (compat family, presets, endpoint UI, kill list). Living. |
| `docs/compat-endpoints.md` | The live registry: what is confirmed, what is theoretical, what is ruled out, with dates and evidence. Living. |
| `docs/provider-adapters-starter.md` | Research archive for the four "starter" adapters that were rejected as code but kept as knowledge. |
| `.slim/*.md` | Raw spike findings (binding availability, qwen endpoint, SpicyAPI verdict, Segmind privacy, unified endpoint, starter providers). |
| `STATE.md` | Cockpit state; the running log of each lane's landing. |

---

## 1. Starting point

The app worked, but the backend was welded to kie.ai's shape:

- **Routing lived in the browser.** The server branched on
  `azureBaseUrl`, `azureDeployment`, `codexProvider` fields the client put
  in the request body, then fell through to Kie. Four client-side branch
  builders duplicated the same logic (`GenerateNode`, gallery ×2 on retry,
  `VideoGeneratorNode`) and had already drifted.
- **Upstreams were hardcoded.** Base URLs and paths sat inline in the API
  routes, the poller, and the upload helper.
- **Video was a 9-way boolean switch.** `generate-video/route.ts` chose a
  payload shape from `apiInput.useMotionControl`, `useMinimaxH3`,
  `useHappyHorse`, `useKlingTurbo`, `useGoogleVeo`, `useGeminiOmniVideo`,
  `useImageUrls`, `useKlingElements`, else standard — each with its own
  field names.
- **Credentials were exactly two keys** (`kie_api_token`, `azure_api_key`)
  in SQLite plus three `localStorage` blobs, with an env-name mismatch
  (`KIE_API_KEY` vs `KIE_API_TOKEN`).
- **There was no "endpoint" concept at all.** A model was an `apiId`
  string; there was nowhere to say "this model can be served by that
  backend".
- **Two lifecycle bugs fell out of the duplication:** Azure/Codex ran
  detached IIFEs that wrote the job store without emitting the SSE event
  (streams hung) and without a pending row (no restart recovery).

That inventory — ranked, file-and-line referenced — is in
`docs/provider-refactor.md` §(b). It is the reason the refactor started
with deletions rather than additions.

---

## 2. The constraints that decided the architecture

These were product constraints first, technical second. Almost every
design choice below traces back to one of them.

1. **No vendor locks — hard constraint.** Backends must be
   interchangeable plumbing; the canvas is the product. That killed every
   single-vendor hosted aggregator, not on quality but on principle.
2. **One contract, not N adapters.** Pick one wire format and make
   backends ride it by *configuration*. Chosen: OpenAI-compatible media
   (images sync, video async).
3. **Per-model parameters on a needs basis only.** Seed only the models
   actually used; unknown params pass through untouched. No speculative
   dialect modelling.
4. **Robustness = stored presets referenced by bindings.** The user's
   requirement: no hand-entering per-model params in a UI. A preset is the
   base layer; bindings override; custom bindings override again.
5. **Cost is a first-class ranking factor** — per call and per megapixel.
   This is why pricing capture became doctrine rather than a nice-to-have.
6. **BYOK + custom system prompts**, and provider/model visibility
   toggles to keep the pickers honest.
7. **Debrand everything** — app copy, docs, README. Also: **no Tauri in
   the README**. Packaging is not product scope and is not being committed
   to now.
8. **Server authority.** The client sends intent (`model`, `providerId`,
   prompt, media); the server resolves endpoints, keys, and payload shape.

---

## 3. Paths considered and killed

| Path | Why it died |
|---|---|
| **fal.ai** | Single hosted vendor + credit markup — violates constraint 1. |
| **Hosted aggregators generally** (kie clones, Replicate-billed, SpicyAPI) | Same lock-in; the "aggregator as compat layer" pattern just moves the throat to choke. |
| **HuggingFace Inference Providers wrapper** | Chat-compat only; image/video shapes are per-provider and undocumented as REST. New dependency, zero bindings. |
| **Segmind Gateway** | Full-proxy data path (it sees prompts, files, *and* your BYOK keys) with thin legal docs — no DPA/ZDR/key-encryption answers. Consumer-grade only. Recorded in `.slim/segmind-privacy.md`. |
| **SpicyAPI as a compat backend** | `/v1/images/*` 404s; image models 400 on chat endpoints. Its `/v1/videos` is OpenAI-*Videos*-shaped (singular `input_reference`, `seconds`, `size`) — a different dialect from OpenRouter's native `/videos`. Verdict: it needs a kie-family adapter; parked. |
| **Four dedicated starter adapters** (OpenRouter/Pollinations/SpicyAPI/HF as separate code) | Redundant once the compat family existed — the first two became *aliases*, the last two had no viable surface. |
| **Replicate / fal dedicated adapters** (the original Phase 6 trio) | Superseded by the compat family + the explicit kill list. |
| **Full custom-endpoint / custom-model UI** | Dead. Endpoint config survives only scoped to compat bindings. |
| **A full conformance-harness day** | Replaced by one lightweight *permanent* smoke fixture living in the build lane. |

---

## 4. The architecture that came out

```
client intent ──► /api/generate | /api/generate-video   (thin controllers)
                        │
                        ▼
              registry.resolveForModel(modelId, providerId?)
                 preset params ← binding.paramMap ← custom overrides
                        │
                        ▼
              GenerationProvider adapter  (submit / poll /
                                           checkReadiness / uploadMedia)
                        │
                        ▼
              pre-minted taskId  →  pending row  →  upstream
                        │
                        ▼
              jobManager.settleJob()   ← ONE funnel
                mirror media · jobStore · generations · SSE emit · release
```

Five ideas do the heavy lifting:

1. **Logical catalog vs execution bindings.** `lib/modelConfig.ts` keeps
   everything clients read (handles, ratios, modes, prompt limits,
   `apiInput`). Execution identity moves into bindings.
   **40 catalog models** (20 image, 20 video) today.
2. **Bindings are data.** `{modelId, providerId, upstreamModelId, family,
   paramMap, mediaStaging, presetId}`. Dialect differences live in the
   binding, never in `if (provider === …)` branches. **84 built-in
   bindings** ship in code: 40 kie defaults (derived, `upstreamModelId =
   apiId`) + 1 azure + 1 codex + 19 OpenRouter image + 12 OpenRouter video
   + 11 Pollinations image.
3. **The compat family is one adapter with aliases.**
   `openaiCompat.ts` is registered under `openrouter` and `pollinations`;
   the alias carries `{baseUrl, keyEnv, path, paramMap}`. Adding a
   backend is a config row, not a file. It speaks **two legs**: sync
   images (`/images`, b64 or URL) and async video (`/videos` → 202 →
   poll → bytes).
4. **One settle funnel.** Every completion path — sync image, detached
   background, async poll — settles through `settleJob()`, which mirrors
   media, writes the store + DB, emits SSE, and releases registry
   entries. `provider_meta` is pinned per job so a resume knows which
   adapter and upstream task to talk to.
5. **Param presets.** Four code-seeded rows (`standard-image`,
   `image-edit`, `openrouter-dialect`, `pollinations-sync`), resolved
   preset ← binding ← custom override, applied to the compat family only.
   An unknown preset id **fails the job loudly** — never a silent
   fallback, because a silent fallback is how "robust" dies.

---

## 5. Phase chronicle

Each phase was a bounded lane: a written task, a validation contract, no
commits inside the lane, and a report with unverified items labelled as
such.

### P1 — Delete dead generation paths (`340c161`)

Removed the dead `WorkflowCanvas.runAll` canvas path (it expected a
`data.videoUrl` the route never returned), the stale leaf-node model
lists, `lib/pendingJobs.ts`, `executor.topoSort`, and seven newly-dead
bindings. **Behavior-neutral by design.** You cannot refactor a system
you have not finished deleting.

### P2 — The funnel (`b026c85`)

`lib/jobManager.ts` was born: `settleJob` (mirror → store → DB → emit →
release, `try/finally` safe), `startPolling`, `resumeJob`. `generations`
gained `provider_id` and `provider_meta` via an idempotent migration.
Azure/Codex moved onto the funnel, which fixed the hung-SSE and
no-recovery bugs as a side effect. Kie paths unchanged.

### P3 — Credentials become data (`283da11`)

`provider_configs` + `model_bindings` (PK `(model_id, provider_id)`),
one-shot marker-guarded legacy migration in both directions, env-name
unification, and `GET/PUT/DELETE /api/settings/providers`. The legacy key
routes became thin wrappers.

This lane's gate **failed** and was remediated: the migration could
strand its marker on throw, and an import failure had no `ROLLBACK`. Fix:
`try/finally` around marker write, rollback on failure, no marker
stranding. Worth recording — the gate caught a real data-loss class bug
that tests would not have.

### P4+P5 — Registry, adapters, server authority (`8e717cc`)

Shipped together on purpose (`C7c`): P4 alone would have regressed
Azure/Codex users. Registry with `resolveForModel`, static bindings for
every catalog model, per-operation media staging with passthrough,
loopback re-hosting, idempotent bootstrap, and the UI reading **readiness
from the adapter** instead of guessing from a key flag.

### P6a — The compat family (`4a83f4e`)

One `openaiCompatProvider`, 10 OpenRouter image bindings, registry alias
views, adapter-driven readiness in `GET /api/settings/providers`, a
permanent offline smoke fixture (`scripts/providers/smoke-compat.mjs`,
85 assertions at birth). Validated: `tsc` 0, eslint zero-new-vs-HEAD.

### P6b — Presets + endpoint UI (`02dc546`)

`param_presets` table, four seeded presets validated *before* write (a
typo aborts the boot), resolution order in the registry, SettingsModal
"Compatible endpoints" section (base URL + key + preset picker +
view-only JSON preview), `presetId` on the provider write path. Fixture →
119 assertions.

### P6c — Pollinations joins as an alias (`6f2b2b8`)

No new adapter: `providerId "pollinations"`, keyEnv
`POLLINATIONS_API_KEY`, base `gen.pollinations.ai`, path
`/v1/images/generations`. 11 image bindings with spike-verified upstream
ids and reference caps. This lane forced one genuinely new capability: a
**generic `uploadMedia`** (binding-configured endpoint + field
convention; multipart/raw/base64) so `remote-url` staging works. Fixture →
263 assertions.

### P6 sweep — image coverage in one pass (`17e4041`, `196f786`, `9a15a1f`, `5355ff5`, `6203604`, `376d378`)

Seven more OpenRouter image models plus the qwen family, taking image
bindings to 19. `meta/muse-image` skipped: zero live endpoints.
Registry promoted OpenRouter images to **Confirmed** only after live t2i +
i2v + three spot-checks returned `done` with mirrored files.

### Cross-cutting UI / product lanes

- **Assistant BYOK + custom system prompts**, provider/model visibility
  toggles filtered across every picker (`989ba4f`).
- **Debrand** (`c96db3c`, `f328c9b`): UI copy, README, `.env.example`;
  functional identifiers kept with a documented allowlist. Dead R2
  template assets replaced with local placeholders; the "H" logo replaced
  with a temp teal square; the dead `*.r2.dev` Next image pattern removed.
  README went **Tauri-free**.
- **Empty-state pass** (`7088b64`): stock splash imagery removed,
  gallery + WorkflowHero rebalanced rather than propped up with stock art.
- **Observability** (`16ba5b8`): per-job capped, **redacted** trails
  (submit/poll/settle/resume/error/retry; hosts not bodies, no `data:`
  payloads, no keys), a 12-minute fetch budget, **one** retry on transport
  failures only (4xx/5xx never replayed), `GET /api/jobs/[taskId]/log`,
  and a shared `JobLogViewer` in both generator nodes + pending gallery
  tiles.

### P6 video (`53e31f8` sweep, `7208ce4` implementation)

This is the phase where a sweep taught us we were wrong about what was
missing — see §9. Short version: 10 video models verified live with caps
and pricing, then a lane built async submit/poll/settle through the same
compat adapter, 12 bindings, 3 new catalog rows, provider-aware resume.
Fixture → **432 assertions**.

---

## 6. What the live endpoints taught us

Every row below changed code or doctrine. Listings lie; runtime doesn't.

| # | Finding | Symptom | Resolution |
|---|---|---|---|
| 1 | OpenRouter images are at `/images`, **not** `/v1/images/generations` | docs-shaped guess 404'd | `pathOverride` in the binding |
| 2 | `aspect_ratio: "auto"` is rejected upstream | 400 on a value the catalog advertises | `null` valueMap entry **drops the field**; catalog `auto` now means "server default" |
| 3 | Reference images must be objects, not strings | 400 on `image_url: "data:…"` | `{type:"image_url", image_url:{url}}` everywhere |
| 4 | qwen `seed` is **numeric** at runtime despite the endpoint listing saying boolean | 400 on `true` | trust runtime; boolean path deleted |
| 5 | Video `…/content` requires the bearer token | a mirrored URL would have stored a 401/unreachable file | poll fetches the bytes and hands the funnel **buffers** (documented deviation from the lane brief, which said "let settleJob fetch") |
| 6 | No video upload endpoint is documented | local reference files cannot be used on the video lane | bindings stage `remote-url` only; the stager **fails loudly** ("must be uploaded first") |
| 7 | Per-model `/videos/models/{id}/endpoints` 404s | the sweep's first script crashed | caps come from the list endpoint `GET /v1/videos/models` |
| 8 | `nano-banana` family 429s | upstream Google AI Studio quota, key itself healthy | blocked, not "fixed"; recorded as upstream billing |
| 9 | Pollinations' reference field accepts **both** array and single-string forms | two plausible shapes, both work | accepted both; no artificial narrowing |
| 10 | Video caps are per-model and narrow | e.g. minimax min duration 5 s, Kling pinned 720p, no 4K | re-clamp + tier-drop in the binding, not in code |
| 11 | `input_references` vs `frame_images` are different mechanisms | image-to-video needs a **frame**, guidance needs a **reference** | both built; a request with both is treated as i2v (upstream rule) |

The pattern: **docs give you the request; only a live call gives you the
contract.** That is why the registry has a promotion gate with five
required conditions and why "docs claim it" never promotes a backend.

---

## 7. Cost as a first-class dimension

Before the sweep, pricing was scattered across spike notes and binding
comments — effectively nowhere. It is now doctrine:

> Capture per-model pricing at binding time from the live listing
> (`pricing_skus`) into the binding comment **and**
> `docs/compat-endpoints.md`. The registry is the single source of truth.

Captured so far (images, at time of writing): qwen 2.1 Turbo $0.0184 flat
at 1K/2K (Pro $0.046); flux-3-klein $0.008 (768) → $0.036 (4K),
size-scaled; seedream-5-flash $0.018 flat; recraft-v4.1-flash $0.007;
recraft-v4-styles-vector $0.05 + $0.005/ref (requires ≥1 ref);
mai-image-2.6-flash token-metered; krea-2-medium(-turbo) **unverified**.

Video is metered in *three incompatible ways*, which is itself a finding:
per-second with resolution tiers (veo-lite, grok, minimax, wan), per
second flat (kling, flux-video-edit), token-metered (seedance), and
megapixel-second (flux-video-upscale). A single "cost" column is
therefore honest only as a *basis* label plus the raw SKUs.

**Consequence for verification:** no live video test has run. Images cost
~$0.02 and were tested freely; video bills per second and per resolution,
and the SKUs are captured but the per-test figure is still unverified. Not
spending the user's money unprompted is the correct default.

---

## 8. How the work was run

The process is as much a deliverable as the code. It is repeatable:

1. **Spike before binding.** A backend ships only with ≥3 real rows from a
   live listing. Doc-only, no code.
2. **Promotion gate.** Confirmed requires: live submit returns media →
   `settleJob` mirrors it → reference-field shape confirmed live → error
   envelope *observed* (not assumed) → readiness gating works **without** a
   key (the negative case). Date + model recorded per confirmation.
3. **One lane, one contract.** Lanes get: exact scope, ordered steps, the
   validation bar, "no commits", "no network unless told", and a report
   format that requires **labelling unverified items instead of guessing**.
   That single rule is why §11 is honest.
4. **Permanent offline smoke fixture.** `pnpm smoke:providers` —
   now **432 assertions**, stubbed `fetch` only, zero network. It is not a
   test suite bolted on; it is the lane's acceptance criteria, and it is
   what makes "no network" lanes trustworthy.
5. **Gates that compare to HEAD, not to zero.** `tsc --noEmit` exit 0,
   plus eslint **zero-new-vs-HEAD** via `git stash` fingerprint compare.
   Pre-existing debt is visible but never blocks a lane.
6. **Deviation is reported, not hidden.** When a lane's instructions
   conflict with reality, the lane does the correct thing and *says so*
   (§6 row 5 is exactly this).
7. **Registry hygiene as a merge gate.** Docs updates land with the code
   that earned them, in the same commit.

---

## 9. Failures, near-misses, course corrections

Honest list — these are the parts worth remembering.

- **The adapter could not speak video, and nobody noticed for a while.**
  The 10-endpoint sweep produced caps and pricing, and the report still
  read like coverage. Mapping is not capability: bindings without a submit
  path are just config files. Caught by asking "does the adapter actually
  have a video branch?" — answer: no. It cost a full implementation lane
  to reconcile. **Lesson: verify the execution path before counting
  coverage.**
- **Disk hit 100% mid-lane** (0 bytes free). The regenerable `.next/`
  build dir was deleted to continue; `node_modules`, `data/`, `public/`
  untouched. Logged in `STATE.md`.
- **A design gate failed on P3** (stranded migration marker, no rollback
  on import failure). Remediated, not waived.
- **Unverified kie `apiId`s.** The 10 new image/video catalog rows carry
  family-convention guesses for their kie ids. Same precedent as the
  earlier sweep, but it is a known sharp edge if kie is used for them.
- **Upstream-id spelling ambiguity on video.** The lane was told
  `kwaiv/* kling-3.0-*` and `minimax/hail3`, the repo had conflicting
  spellings; implementation used the newest in-repo source and *flagged
  the prefix and `3.0`/`v3.0` token as unconfirmed against the live
  listing*.
- **A typo in the registry ("1082p-class")** survived into a doc table;
  implementation used `1080p`. Small, but an example of why "record at
  binding time" beats recollection.
- **Catalog/UI gaps reported rather than papered over:** `veo3_lite`'s row
  says `sound: false` though the model supports audio (audio unreachable);
  Kling's mode picker has no effect on the OpenRouter lane (variant is a
  fixed model id, 4K does not exist upstream); seedance/minimax reference
  handles are capped at 2 on that lane. Known, documented, not silently
  "fixed" by guessing.
- **Tooling noise:** several turns were lost to malformed/empty tool calls
  and a mistyped workdir. Process overhead, not product risk — but it is
  why lanes are dispatched with complete contracts instead of drip-fed.

---

## 10. Where things stand

**Branch:** `feat/pluggable-providers`, tip `7208ce4`, nothing pushed.

```
7208ce4  P6 video: OpenRouter video submit path + 12 bindings
53e31f8  Video sweep: 10 OpenRouter video models verified + pricing tracking rule
196f786  Promote OpenRouter images to confirmed (live t2i+i2v+spot checks)
17e4041  P6 sweep: 7 more OpenRouter image bindings + catalog models
9a15a1f  Drop aspect_ratio:auto instead of sending it (live 400 fix)
5355ff5  OpenRouter refs as objects, not strings (live-verified)
16ba5b8  Robust job logging + in-app run-log viewer
6203604  Fix qwen seed mapping: numeric per runtime validation
376d378  Qwen Image 2.1 Turbo: catalog + bindings + seed mapping
f328c9b  Local placeholders + temp mark; README goes Tauri-free
7088b64  Empty states: drop stock splash imagery, rebalance layout
781ee9f  Repo knowledge base: codemaps, provider docs, ignore rules
c96db3c  Debrand app UI + docs (kie-agnostic copy)
989ba4f  Assistant BYOK + custom prompts, visibility toggles
6f2b2b8  P6c compat Pollinations sync-image leg
02dc546  P6b compat presets + endpoint UI
4a83f4e  P6a provider compat: OpenRouter family
8e717cc  P4+P5 provider refactor: registry, adapters, authority, readiness
283da11  P3 provider refactor: credential store + providers endpoint
b026c85  P2 provider refactor: jobManager funnel + provider_id migration
340c161  P1 provider refactor: delete dead generation paths
```

**Numbers:** 40 catalog models (20 image / 20 video) · 84 built-in
bindings · 5 registered adapters (kie, azure, codex, openrouter,
pollinations) · 4 presets · 432 offline smoke assertions.

**Live-proven:** Pollinations sync image (t2i + both reference shapes);
OpenRouter qwen-2.1-turbo (t2i + i2v with refs), recraft-v4.1-flash,
seedream-5-0-flash, flux-3-image-klein.

**Written but never executed:** the entire video lane. Async submit, poll,
status mapping, and bearer content fetch are covered by stubbed-fetch
assertions only.

---

## 11. Open items

| Item | State | Note |
|---|---|---|
| Live video test | **Not run** | Needs a spend decision: cheapest is ~4 s on veo-3.1-lite; worst case is long + 1080p + audio. |
| mai-image-2.6-flash, recraft-v4-styles-vector, krea-2-medium(-turbo) | Bindings exist, never live-run | Costs/metering unverified. |
| `OPENROUTER_API_KEY` expiry | ~2026-10-21 | Long-lived work must not depend on it. |
| Branch merge | Not pushed | Requires explicit user approval for the push. |
| Automations (workflow pack) | Next milestone | Realistic image + video workflows across input types and endpoints. |
| Audio (TTS/STT) | Parked | Technically fits the compat family, but there is no UI surface — no audio nodes, pickers, playback, or waveform. Needs a concrete use case (e.g. voiceover tracks for generated video) before it is a modality worth building. |
| Text / LLM | Dropped | `/api/assistant` + BYOK already covers chat; a compat text binding would duplicate, not add. |
| kie `apiId`s for the 10 new rows | Unverified guesses | Family convention, same precedent as the sweep. |
| Dashboard "recent runs" | Not started | Logs exist per job; no aggregate view. |
| Retry hardening on kie/azure/codex fetch paths | Not started | Only the compat adapter has the bounded-fetch + one-retry treatment. |
| `lib/kieJobPoller.ts` | Dead code | Still listed in `lib/codemap.md`; delete when kie retirement is scheduled. |
| OR / POL wordmarks | Design pass | Placeholder-quality next to the temp app mark. |
| Pollinations video | Weak lane | Caps tighter (refs ≤2, 5 s caps), async path explicitly uncovered. |
| SpicyAPI | Parked | Needs a kie-family adapter; compat cannot carry its image surface. |
| kie retirement | Unscheduled | Only when compat coverage demonstrably replaces the models users actually generate with. |
| Pre-ship: "Assets" nav | Placeholder | Hardcoded disabled item — revisit data-storage methodology (guest.db + localStorage + `MEDIA_DIR`, single-user assumptions, export/backup) before any public ship. |

---

## 12. Doctrine (the short version)

1. **One contract beats N adapters.** A backend is config, not a file.
2. **Docs describe intent; live calls define the contract.** Promote on
   evidence, with a date and a model id.
3. **Delete before you abstract.** P1 existed for a reason.
4. **One funnel for every completion path.** Sync, detached, polled —
   same door in.
5. **Dialect belongs in the binding.** The first `if (provider === …)` in
   an adapter is a design smell.
6. **Cost is a property of the binding**, captured at the same time as the
   caps.
7. **Fail loudly on configuration errors.** A silent fallback is a bug
   with better manners.
8. **Unverified is a status, not a guess.** Say it, and it stays
   trustworthy.
9. **The offline fixture is the contract.** If it cannot prove it without
   the network, it is not proven.

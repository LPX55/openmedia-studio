# Provider Plan — Phase 7 (MCP Servers & HF Spaces)

Status: draft, rev 2 — revised after an independent cross-review that verified every citation against source (blockers 1-3, high 4-6, mediums, sequencing — all confirmed). Original rev-1 claims are retracted or rescoped where noted; the wire-level appendix is unchanged.

Extends the compat-plan architecture (one family adapter per upstream dialect; backends are configuration, never code branches) with two new families: generation through **MCP servers** and through **Hugging Face Spaces** (Gradio queue API, or the Space's own MCP endpoint when MCP support is enabled).

Wire-level protocol facts below are **verified live on 2026-10-29** (real Spaces exercised over plain fetch; MCP spec revisions checked against the schema repo). Research appendix at the end carries the receipts.

## (a) Direction & decision log

- **User bet (P7 origin):** broaden the endpoint catalog — two new backend kinds: MCP servers and HF Spaces. This deliberately **relaxes two prior positions**:
  - The compat plan's rejection of "HuggingFace wrapper (new dep, zero bindings)" applied to a *hosted wrapper service*; an HF Space is the user's own BYOK/self-hosted backend, same as a LiteLLM gateway. Riders stay binding-configured; no vendor-throat.
  - C6 ("custom logical models out of scope" — design §C6 / compat-plan §e-4 backlog): arbitrary Spaces and MCP tools can't honestly ride the 28 fixed catalog rows. P7 brings custom logical models INTO scope as a minimal, scoped first cut (P7a-1). The cheap fallback (bind Spaces onto existing catalog models' provider unions) is rejected as semantically muddy — a FLUX Space showing up as "Nano Banana 2" in the gallery is worse than the schema work.
- **Honestly rescoped (rev 2):** rev 1 predicted "no `GenerationProvider` contract change". The cross-review disproved this — the contract's *shapes* are sufficient (ProviderId open, sync/async submit, `poll(meta)` statusUrl, staging strategies), but the *plumbing* needs a compatible extension, which is its own P7a-0 commit:
  - **Resolve hook.** `registry.get()` is an exact `Map.get` (`lib/providers/registry.ts:41-43`) and aliases are readonly at registration (`lib/providers/adapters/openaiCompat.ts:1103`) — there is no family/catch-all routing. A user-created id (e.g. `hf-mflux`) resolves to `undefined` → `resolveForModel` throws (registry.ts:148). P7a-0 adds a resolver consulted by `resolveForModel` BEFORE `get()`, keyed on the `provider_configs.kind`/family, serving both new families' user-created backends.
  - **Dynamic report enumeration.** The settings report iterates a hardcoded `PROVIDER_CATALOG as const` (`app/api/settings/providers/route.ts:50-67`) and the client list is equally static (`lib/providers.ts:17-27`) — custom rows would be *writable but never listed*. P7a-0 merges `provider_configs` rows (with their `kind`) into the report and into the client provider union.
- **Kept, unchanged:** one adapter per family; dialect in binding data; spike-before-bind; per-model params on needs basis only; loud failures (never silent fallback); prompt/key/URL-userinfo redaction in the run log; server-only adapters behind the eslint `no-restricted-imports` wall; offline-first verification; live runs opt-in and spend-gated.
- **Order (rev 2, resequenced):** spike 1 → **P7b (Gradio)** 2 → **P7c (MCP)** 3 → **P7a infrastructure** last-before-merge. Rationale (cross-review): Gradio is first because it reuses the ALREADY-EXERCISED async lane (poll loop, retry funnel, SSE framing, staging) and freezes `GradioArgMap` against real recordings before any schema ships; MCP lands after because — while its spec surface is formally smaller — it is the NEWEST surface in this codebase (handshake, session handling, SSE-in-POST, four-case parse, version negotiation), and its smoke fixture depends on the same harness upgrade Gradio's forces. The spike is step 1 so the "position ≠ UI order" caveat never bites a frozen column list. See (d).

## (b) Target shape

### P7b — `hf-gradio` family (async queue API; no SDK dependency) — lands SECOND

One adapter `lib/providers/adapters/gradio.ts`, id `hf-gradio`, each Space a backend alias with its own provider row (base URL = `https://<owner>-<space>.hf.space`, credentials = HF token (`hf_…`, highest rate limits + ZeroGPU quota attribution; optional for public Spaces).

- `submit(image|video)` → `POST /gradio_api/call/{fn}` with the positional `data` array from the binding's argMap → `{event_id}` → async outcome with `providerMeta.statusUrl = GET /gradio_api/call/{fn}/{event_id}`. Same pattern as the openai-compat video lane: `poll()` reads `meta.statusUrl` so it needs no fn-name parameter.
- `poll` → per-tick bounded (see below) fetch of the SSE stream (`event: complete|generating|error|heartbeat`; `heartbeat` frames carry `data: null` — ignore). Exposed status mapping: `complete → done`, `error → error`, everything else → pending. Output = the final frame's `data` array; the first `FileData` entry (its `url` — `https://<space>/gradio_api/file=<path>`) is the media.
  - Public Space → return the URL and let the settle funnel mirror it.
  - Private Space → the funnel's mirror sends no Authorization header (established rule) ⇒ fetch the bytes IN the adapter with the Bearer token and return **buffers** — the `done.buffers` path already exists for exactly this shape.
- **Poll-tick bounds (rev 2 — closes cross-review blocker 3).** `runProviderPollLoop` checks its deadline ONLY at loop top (`lib/jobManager.ts:184`) — a poll() that streams/hangs holds the whole loop past `MAX_POLL_MS`, and only the compat adapters use `AbortSignal` today. The gradio (and mcp) adapters therefore:
  1. wrap EACH tick's fetch in `AbortSignal.timeout(20-30s)`;
  2. on abort/timeout → throw a transient error → the loop's existing catch retries → `pending` → next tick reopens the SSE and resumes from the current frame (resumability is why queries go by `event_id`, never by a consumed stream).
  The loop's `MAX_POLL_MS` remains the ONLY wall — there is deliberately NO per-call long timeout. (Rev 1's "per-attempt ≥180 s" is deleted; it contradicted the compat lane's 10-minute `REQUEST_TIMEOUT_MS` and inverted the funnel's assumption.)
- Staging = `remote-url` with `uploadMedia()` = `POST /gradio_api/upload` (multipart, field `files`) → pass the returned path as a FileData dict (`{"path": …, "meta": {"_type": "gradio.FileData"}}`). Public http(s) references pass through; loopback/private ones respect `allowPrivateUrl` (P7a-4).
- Caps: from the step-1 spike recordings — steps, width/height, seed handling — seeded into the binding (re-clamp / drop rules reused from the compat video lane).

### P7c — `mcp` family (sync; images-only in v1) — lands THIRD

`lib/providers/adapters/mcp.ts`, id `mcp`, aliases per server. `upstreamModelId` = the tool name. Generation = ONE blocking `tools/call` → `mode: "sync"` with buffers, exactly the openai-compat image leg's flow — so the run-log trail, one-retry-on-transport-failure, and settle rules apply untouched.

- **Scope guard (rev 2 — closes medium #1):** v1 serves IMAGES through the sync buffer path (bounded, size-guarded — see below). MCP VIDEO generation requires the *URL branch*: the tool result carries or regex-extracts a `/gradio_api/file=…`-style URL that the settle funnel mirrors byte-bounded — never an unbounded base64 buffer inflating worker RAM twice (types.ts buffer-side + uploadBuffer side). A tool result that neither thread offers settles LOUDLY, never truncated.
- Handshake = **2025-06-18 protocol**: `initialize` → `notifications/initialized` (→ 202 empty) → `tools/call` with `params: {name, arguments}`. Verified live: Gradio pins mcp>=1.21.0,<2.0.0 and **rejects 2026-07-28 with a hard 400** ("Supported versions: 2024-11-05, 2025-03-26, 2025-06-18"). The adapter captures `Mcp-Session-Id` when a server issues one (Gradio is stateless and never does), resends it on every later request, and re-initializes once on a 404.
  **Protocol version is NEGOTIATED, never a hardcoded constant (rev 2):** initial request sends `2025-06-18` as the advertised floor; the adapter reads `result.protocolVersion` from the initialize response and speaks whatever both sides agree on (so a future SDK-2.x server upgrades transparently). The version-pin trap is a negotiation rule, not a config constant.
- Response parse is defensive BY CONTRACT:
  1. `content[]` item `type:"image"` (base64) → bounded buffer (reject > ~64 MB — multi-MB base64 verified live elsewhere);
  2. else `resource`/`resource_link` uri / URL regex out of `TextContent` — verified live: Gradio's MCP server often emits a **Python-repr text blob** containing `{'path': …, 'url': 'https://<space>/gradio_api/file=…'}` instead of an image block;
  3. `isError: true` → settled job error (HTTP 200 — protocol error vs tool error distinction);
  4. nothing found → loud "no media in tool result (content types: …)".
- Headers: `MCP-Protocol-Version` + `Mcp-Method`/`Mcp-Name` are MUST-send per the 2026-07-28 spec and tolerated on 1.x servers (verified live) — send them always so SDK-2.x servers don't fork the dialect afterwards. `Accept: application/json, text/event-stream` must list both; **branch on the response content-type, never on our Accept** (verified: Gradio always replies `text/event-stream` even for single JSON bodies — SSE framing `event: message\ndata: <json>\n\n`).
- Staging = `data-url` (MCP image tools overwhelmingly accept data URLs / public URLs as string args). A binding MAY declare `remote-url` only when it names its own upload path; otherwise local references fail LOUDLY with the openrouter-video rule's wording ("no upload endpoint documented ⇒ a local file fails loudly") — the known template-graph gap rides along and is NOT silently worked around.
- **HF Space with MCP enabled = an MCP binding, zero new code:** backend base URL = the Space's `/gradio_api/mcp/` (**trailing slash required** — verified 307 on the non-slash form), credential = the same HF token, tool names discovered sessionless via `GET /gradio_api/mcp/schema` (verified: returns `{name, description, inputSchema, meta.endpoint_name}` without a handshake). **Resolve the tool by `meta.endpoint_name` — NEVER by reconstructing the `name` string** (spike-proved unreconstructable: `wan2_1_fastgenerate_video` carries NO separator where the repo stem ends in a digit, while `Z_Image_Turbo_generate_image` does; the convention is a recorded observation, not a contract — see `docs/provider-phase7-spike.md`). The user story is ONE kind of card in Settings: "Add MCP server" — pointing at a Space or anywhere else is the same flow.

### P7a — Binding & settings infrastructure (lands LAST, unlocks user-facing)

Nothing below blocks the adapter lanes; all of it blocks the MERGE. Rationale: smoke fixtures exercise static code-seeded bindings, which need none of this; every item here exists to make the result user-creatable and safely enumerable.

- **P7a-0 (own commit): resolve hook + dynamic enumeration.** Before `registry.get()`: `resolveForModel` consults the kind-keyed custom-backend resolver (review blocker 1). The settings report merges `provider_configs` rows (route.ts:50-67 today) into the per-backend list and feeds custom rows into `bindingsByModel`; the client union (`lib/providers.ts`) learns new ids through the report, never a static list. Also in this commit: **staging upload-dedupe rekey** — `uploadCache` is keyed by the raw input string only (`lib/providers/mediaStager.ts:234-249`), so with kie + pollinations + N gradio + M mcp backends, backend B receives backend A's uploaded URL (a `/tmp/gradio/...` path handed to a Space that never saw it). Key becomes `providerId + baseUrl + input` and `cachedUpload` inlines the plugin's per-call context so two upload targets never share an entry.
- **P7a-1 custom logical models (C6 relaxation, rescoped per rev 2).** New table `custom_models` with the fields CLIENTS ACTUALLY READ (verified reader set from the cross-review):
  image: `supportsImages`, `maxImages`, `supportsQuality`, `apiInput: {promptMaxLength, qualityOptions}`
  video: the above + `apiInput: {durationMin, durationMax}` (generate-video route:107) and the picker fields `GenerateNode.tsx:26-39` consumes.
  `GenerateInput.model` is a fully populated `ImageModel | VideoModel` (`types.ts:101`) and adapters already read `model.apiInput.promptMaxLength` (`azure.ts:272`, `codex.ts:187`) — the row must produce that complete object. Rev 1's `defaults` column is dropped (cross-review verified: NO reader — `paramMap` presets only run under `usesParamPresets`, which the new families don't set (`registry.ts:163`); `output_format` was likewise already a reader-required field, folded into `apiInput`).
  Resolution (rev 2, per the reviewed explicit): `resolveForModel` handles custom model ids by either (i) an EXPLICIT provider (generation routes always send one — `lib/providers.ts:72-76` defaults `"kie"` when absent, which today makes `getDefaultBinding` throw `custom logical models are out of scope` (bindings.ts:1555) a one-step-later first-failure masked as 500) OR (ii) an `is_active` `model_bindings` row. The registered first-failure masking site stays documented: `getAvailableProvidersForModel` returns `["kie"]` for ANY unknown id (bindings.ts:1576), so the report's `bindingsByModel` seed must switch to "unknown model ⇒ custom row or empty, never a defaulted `["kie"]`."
  The settings report gains a `customModels` array (verified absent today — nothing renders without it).
- **P7a-3 two new pure-data dialect types in `bindings.ts`** (client-safe per hedge (d) — no guest/db imports; these ride their adapter lanes but are listed here because they're pure data, not adapter code):
  - `GradioArgMap`: `data[]` **index → normalized source** (`CompatFieldSource` reused), plus `constants` (index → static value) and `fileInputs` (indices whose value is an uploaded FileData dict). Position $\ne$ UI order — `/gradio_api/info`'s `named_endpoints` order is authoritative (verified: `prepare_simple_api_data` skips `skip_api` components and re-orders). **Single-file source variants (rev 2 — closes high #5):** `CompatFieldSource` today cannot express one positional file slot — its only media source (`"references"`) returns `string[]` (`openaiCompat.ts:254`). The recorded SIGNATURES require isolated slots: `input_image` (FLUX.1-Kontext, wan2-1-fast), `input_image_filepath`/`input_video_filepath` (ltx-video). The source union therefore gains: `"startFrame"`, `"endFrame"`, `"videoRef"`, `"referenceAt"` (a single item of the reference list, by index) — implemented in the shared source resolver, not re-invented per adapter.
  - `McpArgMap`: argument **name** → the same source union, plus `constants`. MCP args are named, so this is flat.
- **P7a-4 per-binding `allowPrivateUrl`.** Today `mediaStager` treats loopback/private hosts as NOT remote and re-hosts them because *cloud* providers can't fetch them. A local MCP server (`localhost:8080/mcp`) or LAN Space is the opposite case. The flag is honored by the `gradio`/`mcp` families only (the adapter checks its own `id`); every other family keeps the pinned rule byte-for-byte.
- **P7a-5 settings report** (`GET /api/settings/providers`) extends each custom backend with `kind` + a `discovery` field (`ok` / unknown), so the UI can show "2 tools found" style hints. Discovery is **user-initiated** (a button-driven fetch) per the cross-review SSRF note — the report endpoint itself never fetches user URLs (unbounded, unauthenticated, cache-less otherwise).

### P7d — Polish (explicitly post-MVP)

- SSE `generating` → job progress lines; tool description → GenerateNode tooltip; picker grouping (OpenAI-compatible / HF Spaces / MCP); custom-model preset editor (v1: models are created hand-configured, presets stay code-seeded); template-graph support once ≥2 verified backends per family; `docs/compat-endpoints.md` rows for verified Spaces/tools.

## (c) Endpoint config UI (scoped extension of the existing surface)

No new top-level place — `SettingsModal.tsx`'s "Compatible endpoints" section becomes **"Custom endpoints"**, one card per backend with a kind field (openai-compat | HF Space | MCP server). This section lands with P7a, after both adapters.

- gradio card: Space URL, HF token, (post-MVP) an "Inspect" button listing `/gradio_api/info` named endpoints; fn + arg order read-only display; binding rows carry the argMap (v1: the argMap ships in code per verified Space, hand-editable via the standard `model_bindings` override row — `binding_json` on that row, PK `(model_id, provider_id)`, per `lib/guest/db.ts:599`).
- mcp card: server URL (`…/mcp/`), optional bearer token, (post-MVP) tool listing via `/schema`; per model binding: tool name + argMap.
- Writes still go through `PUT /api/settings/providers` (extend with `kind`); `DELETE ?providerId=` unchanged — **note (rev 2, from the review)**: DELETE wipes ALL of that provider's `model_bindings` rows (`db.ts:623`), which for a custom backend orphans its `custom_models` rows; the custom-model DELETE therefore has to cascade (dropped model id included) or refuse, not silently orphan.

## (d) Build sequence (one lane, sequential commits, spike-before-bind — resequenced rev 2)

1. **Spike (doc-only, FIRST now):** for 2-3 Spaces + 1 generic MCP server, record `/gradio_api/info` arg orders, `/gradio_api/mcp/schema` tool schemas, and one recorded request/response each (recordings feed the offline fixtures). The recorded signature table freezes the argMap types BEFORE any schema ships. No bindings yet. No spend review advisable (ZeroGPU spaces charge the user's own HF quota — flag at spike time; every other run goes through the same `HELIOS_SMOKE_LIVE=1` gate).
2. **Smoke harness upgrade (commit before either fixture).** The existing stub cannot run the promised assertions: `fakeResponse` (`scripts/providers/smoke-compat.mjs:176-196`) has no `body`/`json()` and IGNORES `init.signal` — SSE replay and any AbortSignal test are unwritable until it grows a streaming Response-alike with signal handling + mid-frame chunk splitting. All negative cases listed in (e) ride this same commit (no mirror to an unpinned host; actionable custom-model error).
3. **P7b `hf-gradio` adapter**: `gradio.ts` + `GradioArgMap` + single-file source union + `smoke-gradio.mjs` (stubbed fetch player, Gradio event grammar, FileData extraction, upload + remote-url staging, private-space buffer path, per-tick abort). Commit.
4. **P7c `mcp` adapter**: `mcp.ts` + `McpArgMap` + `smoke-mcp.mjs` (same style, MCP message grammar, the four parse cases, negotiated version, session replay, images-only v1). Commit.
5. **P7a infrastructure (last, unlocks user-facing)**: P7a-0 resolve hook + dynamic enumeration + dedupe rekey; P7a-1 custom_models table + resolution + report array; dialect types; `allowPrivateUrl`; settings UI + user-initiated discovery. Commit.
6. **P7d** as described, in dependency order as demand pulls.

## (e) Validation (permanent, lightweight — repo rules)

- `npx tsc --noEmit` exit 0; `pnpm lint` with zero-new-vs-HEAD fingerprint compare on touched files.
- `pnpm check:workflows` green (the assertion count is COMPUTED at runtime by the script itself — no hardcoded total in the plan; rev 1's "623" is dropped).
- `smoke-mcp.mjs` + `smoke-gradio.mjs`: offline, stubbed fetch, NO build step (Node ≥22.18 type-stripping pattern `smoke-compat.mjs` established), zero network — **but only AFTER the harness upgrade of (d) step 2**, and this plan does not claim those fixtures hold until then. Negative cases are REQUIRED: no mirror ever initiated toward a host outside the pinned `statusUrl`/binding hop list; an unknown custom model settles with an ACTIONABLE error (naming the mechanism) rather than a generic 500.
- Every settled claim about a backend's dialect comes from a recording, not prose: "live-verified" means the offline fixture replays a captured body.

## (f) Risks & notes

- **Biggest scope item is P7a-1, not the adapters**: the custom-model lane touches routes, picker building, and gallery tagging. The adapter lanes are additive by design; review them separately.
- **SSRF hardening targets the FUNNEL, not parsing (rev 2 — rework of rev 1's wrong layer).** `poll()` has no binding parameter (`types.ts:277`), so the space/authoritative host can only be pinned via `meta.statusUrl`'s host at submit time. The actual outbound fetch the funnel performs is `fetchToBuffer` (`lib/guest/localStorage.ts:44-62`): no timeout, up to 5 redirects followed with NO host re-validation. A hostile Space can 302 the mirror to `127.0.0.1` / `169.254.169.254` and the APP SERVER does the fetching — and on mirror failure the funnel KEEPS the source urls (`jobManager.ts:104-114`), so parse-time pinning alone guarantees nothing. The mitigation is three-layer: (i) record the pinned host at submit (`provider_meta`, e.g. `pinnedHost`); (ii) `fetchToBuffer` gains a caller-supplied hop-limited redirect whitelist (same host only, or an explicit allowlist) + an abort timeout; (iii) mirror failure surfaces as a settle-time error for the NEW families (opt-in per adapter — the compat legacy keeps its keep-source-urls behavior to avoid changing existing provider semantics in this phase).
- **ZeroGPU quota**: calls bill the *caller* (auth'd HF token) — a video Space can eat 40 min/day PRO quota. The run-log records host + token source; the Settings card should label Spaces "quota-metered".
- **Gradio file outputs & versions**: `/call/v2/{fn}` named-params exists only on Gradio ≥6.13 — the plan standardizes on the positional `data` array verified across 4.x-6.x.
- **CVE-2026-59806** (SSRF/open-redirect in `/gradio_api/file=`, fixed in Gradio 6.20.0): outputs are user-media, mirrored to `/generated/`; the (f) funnel hardening above is what pins the receive side — payload parsing is NOT credited with closing it.
- **Not in this phase**: stdio MCP servers would require spawning child processes — HTTP-only keeps the server side process-clean. A user could still front a stdio server with mcp-proxy (HTTP) — same card, same code.

---

## Appendix — verified protocol brief (2026-10-29)

### MCP (spec + live Gradio Space)

- Current revision `2026-07-28` removes the `initialize` handshake, `Mcp-Session-Id`, and GET stream entirely (per-request `_meta`: `io.modelcontextprotocol/protocolVersion` + `clientCapabilities`), it also adds `Mcp-Method`/`Mcp-Name` as HTTP header MUSTs. **Gradio (mcp 1.x) rejects it — send `2025-06-18` to Spaces/most servers.**
- 2025-06-18 handshake (what this plan implements):
  ```
  POST <base>            Accept: application/json, text/event-stream
  MCP-Protocol-Version: 2025-06-18    (header is MUST per 2026-07-28; tolerated on 1.x servers)
  Authorization: Bearer <token>       (HF Space: hf_... read token; optional for public)
  {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"openmedia-studio","version":"1.0.0"}}}
  → 200 (text/event-stream)  event: message  data: {"result":{"protocolVersion":…,"serverInfo":…}}
  {"jsonrpc":"2.0","method":"notifications/initialized"}   → 202, empty
  {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
  {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":<tool>,"arguments":{…}}}
  ```
- `tools/call` result: `content[]` of `text` | `image`(base64) | `audio` | `resource`(uri + text/blob) | `resource_link`; `isError: true` = TOOL error (HTTP 200), a JSON-RPC `error` = protocol error; `structuredContent` optional JSON.
- Traps caught live: Gradio replies SSE even when offered JSON; trailing slash on `/gradio_api/mcp/` (307 without); unknown tool → 200 + `isError:true` text, NOT a -32602; image content base64 can be multi-MB — prefer the Space's `/gradio_api/file=…` URL when one is present in the text.

### HF Spaces (Gradio queue API, live-verified)

- Submit: `POST /gradio_api/call/{fn}` `{"data":[…positional…]}` → `{"event_id":…}`; poll: `GET /gradio_api/call/{fn}/{event_id}` → SSE frames `complete` (data = output array incl. `FileData` dicts with `url`), `generating`, `error`, `heartbeat` (`data: null` keep-alives).
- File upload: `POST /gradio_api/upload` (multipart `files`) → `["/tmp/gradio/…"]`, passed as `{"path": …, "meta": {"_type": "gradio.FileData"}, "orig_name": …}`. Public URLs pass through directly.
- Discovery: `GET /gradio_api/info` (`named_endpoints` with parameter order — the authoritative positional order), `GET /gradio_api/mcp/schema` (sessionless tool listing), `huggingface.co/spaces/<ns>/<repo>/agents.md` (HF's machine-readable cheat sheet).
- Space MCP endpoint: `/gradio_api/mcp/` streamable HTTP (also `/gradio_api/mcp/http`), `/gradio_api/mcp/sse` legacy. Tool-name convention `<Space_repo_normalized>` + endpoint name, **separator behavior NOT uniform** — `_`-separated on `Z_Image_Turbo_generate_image` but concatenated where the stem ends in a digit (`wan2_1_fastgenerate_video`) ⇒ resolve by `meta.endpoint_name`, never reconstruct the string (see `docs/provider-phase7-spike.md`).
- ZeroGPU: default `@spaces.GPU` runtime 60 s; free quota ~2 min/day unauth, ~5 min free, 40 min PRO (24 h rolling); always send the HF token so the user's quota is attributed, not the anonymous pool's.
- Gradio `@gradio/client` JS SDK exists (2.7.2, node ≥18) — **rejected** (same principle as compat-plan §a: a dependency buys nothing `fetch` doesn't; raw `fetch` is ~40 lines, needs the event flow exposed anyway for job/timeout control).

### Real Space signatures recorded (for the spike table)

| Space (backend id) | fn | `data` array (positional) | output |
|---|---|---|---|
| `mrfakename/Z-Image-Turbo` | `/generate_image` | prompt, height, width, num_inference_steps, seed, randomize_seed | `[ImageData, seed]` |
| `black-forest-labs/FLUX.1-schnell` | `/infer` | prompt, seed, randomize_seed, width, height, num_inference_steps | `[ImageData, seed]` |
| `black-forest-labs/FLUX.1-Kontext-Dev` | `/infer` | input_image (url), prompt, … | `[ImageData]` |
| `multimodalart/wan2-1-fast` | `/generate_video` | input_image, prompt, height, width, negative_prompt, duration_seconds, guidance_scale, steps, seed, randomize_seed | `[VideoData]` |
| `Lightricks/ltx-video-distilled` | `/text_to_video` | prompt, negative_prompt, input_image_filepath, input_video_filepath, height_ui, width_ui, mode, duration_ui, ui_frames_to_use, seed_ui, randomize_seed, ui_guidance_scale, improve_texture_flag | `[VideoData]` |

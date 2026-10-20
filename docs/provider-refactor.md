# Provider Refactor — Phase 3 Report & Implementation Guide (HeliosGen)

**Verdict: the O2-gate CONDITIONAL PASS conditions C1-C8 are resolved in `.slim/deepwork/provider-refactor-plan/design.md` (spec-level only — architecture unchanged: server-side `ProviderRegistry` + `jobManager` + single `settleJob()` funnel + `guest.db` credential/config store, with logical model capabilities decoupled from execution bindings and all HTTP responses staying uniform `{ taskId }`).** This report is the implementer's entry point: current state, target architecture, migrations, a 6-phase plan (Phases 4+5 landing together per C7c), residual risks with the required hedges, a no-touch list, and pointers to the five deepwork artifacts. All claims carry file:line references verified against the source tree; no APIs here are invented.

---

## (a) Verdict & Architecture Summary

The design is approved for implementation as remediated. In one paragraph: HeliosGen today routes image/video generation through client-supplied `localStorage` fields and hardcoded Kie/Azure/Codex branches in the API routes; the refactor replaces this with a server-side **provider registry** (`lib/providers/registry.ts`) whose **`GenerationProvider` adapters** (`submit`/`poll`/`checkReadiness`/`uploadMedia`) execute models through **execution bindings** (`lib/providers/bindings.ts` + SQLite `model_bindings`, multi-binding PK `(model_id, provider_id)`, default-binding rule: all 28 catalog models get a static Kie binding via `upstreamModelId = apiId`), while the **logical model catalog** (`lib/modelConfig.ts`) keeps every capability clients read (`apiInput`, `textOnlyPromptMaxLength`, `useMotionControl` handle semantics, handles/ratios/modes/resolutions). All jobs are **uniformly pre-minted** a `taskId` and persist a `pending` row *before* the upstream call, guarded by an in-process `activeSubmits`/boot-id registry so `resumeJob` cannot false-kill live jobs; every completion path — sync, in-process background, or async poll — settles through one `settleJob()` that mirrors media locally, writes `jobStore` + `generations` (now with `provider_id` and pinned `provider_meta` JSON), emits the SSE `job:${taskId}` event, and releases registry entries. Credentials, base URLs, deployments, and per-model provider preferences move from two `settings` rows and three `localStorage` keys into `provider_configs` + `model_bindings`, exposed via `GET/PUT/DELETE /api/settings/providers` (including `bindingsByModel`), with one-shot, marker-guarded migrations in both directions (SQLite and browser). Delivery is six phases where 1-3 are additive and **Phases 4+5 ship as one release** so no user — Azure-only, Codex-only, or Kie — regresses at any point.

---

## (b) Current-State Map (condensed from `inventory.md`)

### Model catalog
- **Single source**: `lib/modelConfig.ts` — `IMAGE_MODELS` (11 entries, `:129-383`) and `VIDEO_MODELS` (17 entries, `:513-1033`) = **28 models**. `ImageModel` metadata at `:11-94` includes `apiId`, display-only `provider` label, `apiInput{…}` incl. `promptMaxLength`, `textOnlyApiId`/`textOnlyPromptMaxLength` (`:61-65`), plus Azure fields baked into the shared catalog (`azureQualityOptions`, `azureSizeMap` — only `gpt-image-2` has it, `:326`). `VideoModel` metadata at `:387-511` includes `imageApiId` (i2v slot: `:401`, `:655`, `:681`, `:938`), `handles[]`, modes/resolutions, and **9 boolean payload flags** in `apiInput` (`:457-509`). **No endpoint/URL/key fields exist in the catalog.**
- Other catalogs: `lib/models.ts:12-40` (chat LLMs only), `app/api/generate-image/route.ts:18-24` (orphan Replicate 3-model map). Stale duplicates: `components/nodes/ImageGenNode.tsx:9-13`, `VideoGenNode.tsx:9-13` (zero importers).

### Provider routing
- **Registry**: `lib/providers.ts:8-12` `PROVIDERS = [kie, azure, codex]` (closed union `:14`); selection in browser `localStorage["aiui-model-providers"]` (`:16`), default `"kie"` (`:34-36`). Multi-provider gate `MULTI_PROVIDER_MODEL_IDS = filter(m => !!m.azureSizeMap)` (`:48-53`) → effectively `gpt-image-2` only.
- **Server branches on client-supplied body fields**, not on `providers.ts`: `app/api/generate/route.ts:326` (`if (azureBaseUrl && azureDeployment)`) → `:451` (`codexProvider`) → `:499` Kie fallback; hardcoded upstreams at `:19-20`. Video is **Kie-only**: `app/api/generate-video/route.ts:53-54`, 9-way payload switch `:77-361`, Veo endpoint divergence `:399-405`. Codex = local `codex-imagegen` spawn (`generate/route.ts:225-270`, no key). Replicate = sync orphan route `app/api/generate-image/route.ts:3-74` (env key, no UI caller).
- **Four duplicated client branch builders** read `localStorage` inline: `components/nodes/GenerateNode.tsx:630-664`, `app/gallery/page.tsx:1632-1648`, `:2903-2908` (retry already drifted — drops `azureResolution`), plus video pair `VideoGeneratorNode.tsx:981-1008` / `gallery:1726-1754`.

### Request lifecycle
- Client submit: `GenerateNode.generate()` `:568-725` → 3s cancel window → `POST /api/generate` → poll `GET /api/job-status` every 3s (`:499-553`); `VideoGeneratorNode` uses SSE `EventSource('/api/job-stream')` (`:479-506`); gallery polls + resumes `aiui-pending-gens` (`gallery:658,909,932`).
- taskId minting: Kie = raw upstream id (`generate:549-552`, `generate-video:442-443`, inserted **after** the upstream call); Azure = `azure-…` (`generate:343`); Codex = `codex-…` (`:452`).
- Store/lifecycle: `lib/jobStore.ts:5-34` (whole-file `.job-store.json`), `lib/jobEvents.ts:6-9` (in-process bus), `lib/kieJobPoller.ts:19-62` (3s/12min), `:48-50` prefix guard `isKieTaskId`, settle `:136-170`. `lib/pendingJobs.ts` is dead. Azure/Codex run detached IIFEs that write `jobStore` on success **without** `jobEvents.emit` (SSE hangs) and **without** a pending `generations` row (`generate:431,484` → no restart recovery). Prefix checks: `job-status/route.ts:35,43`, `job-stream/route.ts:53`.
- Wait endpoints: `app/api/job-status/route.ts:6-58` (miss → `guestDb.recoverJob`), `app/api/job-stream/route.ts:32-97` (25s heartbeat, 12min cap).

### Credentials
- Server secrets: SQLite `settings` (`lib/guest/db.ts:224-253`: `kie_api_token`, `azure_api_key`) with env fallback — **name mismatch**: `db.ts:227` reads `KIE_API_KEY` while `generate-video:53` falls back to `KIE_API_TOKEN`. Wrappers `lib/getKieToken.ts` / `lib/getAzureKey.ts`. CRUD routes `app/api/settings/kie-key/route.ts:8-24` and `azure-key/route.ts:8-24` (no auth check). Endpoint config is **client-side**: `localStorage aiui-azure-base-url`, `aiui-azure-endpoints`, `aiui-model-providers`, transmitted per POST (`SettingsModal.tsx:26-88`). Presence flags: `AppSidebar.tsx:676-688` → `store.kieKeySet`/`azureKeySet`. Upload staging hardcoded: `lib/kieUpload.ts:16`.

### UI wiring
- `SettingsModal.tsx`: `ProviderToggle :216-244` (fixed `PROVIDERS` + icons at `:167`, duplicated `GenerateNode:1556`), image toggle gated by `azureSizeMap` (`:987`), **video provider UI inert** (`:1032` `hasAzureDeployment:false`), key save `:1421-1452`. `GenerateNode` pill `:1128-1159`, gate `:1435` (`!isCodexProvider && kieKeySet === false` — kills Azure when Kie key missing). `VideoGeneratorNode:1993` and `gallery:1787,2201` hard-gate on `kieKeySet`. `KieBanner.tsx:8` global red banner. Catalog consumers (capability reads, must stay client-side): `PromptNode:170,173`, `GenerateNode:31-32,404`, `VideoGeneratorNode:401,587,831,1235,1269,1714,1792`, `VideoInputNode:455-456`, `WorkflowCanvas:925-926,1053`, `store.ts:419`.

### Top blockers (from inventory's ranked 10)
1. No endpoint concept in the data model (`modelConfig:11-94`, `providers:8-12`, `generate:326`).
2. Client-driven routing + 4 duplicated branch builders (`GenerateNode:630-664`, `gallery:1632-1648`, `:2903-2908`).
3. Hardcoded upstream base URLs (`generate:19-20`, `generate-video:11,399-401`, `kieJobPoller:19,75`, `kieUpload:16`, `generate-image:27,60`).
4. 9-way boolean payload switch (`generate-video:77-361`).
5. Kie-shaped, prefix-namespaced poller (`kieJobPoller:48-50`, `job-status:35,43`, `job-stream:53`).
6. Exactly-2-keys credential model + env var mismatch (`db.ts:227` vs `generate-video:53`).
7. Provider-choice gate derived from an Azure-only field (`providers:48-53`; video forced off `SettingsModal:1032`).
8. Stale leaf-node model lists (`ImageGenNode:9-13`, `VideoGenNode:9-13`) + duplicated provider icons.
9. Dead divergent `WorkflowCanvas.runAll` (`:1155-1389`, expects `data.videoUrl` the route never returns) — **verified dead, delete don't refactor** (O1 §1.6).
10. Sync-only orphan route `generate-image/route.ts:3-74` + dead `lib/pendingJobs.ts`.

---

## (c) Target Architecture (per remediated `design.md` §1-§4)

### Registry & static bindings (`design.md` §1.1, §1.4 — **C1, C5, C6**)
- **Logical catalog** (`lib/modelConfig.ts`) retains all capability fields — including **`apiInput` (whole object) and `textOnlyPromptMaxLength`**, because clients read them at every enumerated call site: `PromptNode.tsx:170,173`, `GenerateNode.tsx:31-32,404`, `VideoGeneratorNode.tsx:401,587,831,1235,1269,1714,1792`, `VideoInputNode.tsx:455-456`, `WorkflowCanvas.tsx:925-926,1053`, `store.ts:419`. **`useMotionControl` is pinned as a logical-model capability** (used client-side for handle coloring) even though the Kie adapter also derives its payload family from it. Execution-only fields move out: `apiId`/`textOnlyApiId`/`imageApiId`.
- **Binding interface** (`ModelProviderBinding`): `{ modelId, providerId, upstreamModelId, textOnlyUpstreamId?, imageUpstreamId?, family?, paramMap?, mediaStaging?, mediaStagingByOperation?, isCustom? }` + `type VideoPayloadFamily = "kie-motion-control" | "kie-minimax-h3" | "kie-happy-horse" | "kie-kling-turbo" | "kie-google-veo" | "kie-gemini-omni" | "kie-image-urls" | "kie-kling-elements" | "standard"` — the **full 9-family taxonomy**, one per payload branch in `generate-video/route.ts:77,94,164,208,234,275,361,368` + default.
- **C1 default-binding rule**: all **28** models (11 image + 17 video) carry a static, code-defined Kie binding (`upstreamModelId = apiId`, `textOnlyUpstreamId = textOnlyApiId` for image, `imageUpstreamId = imageApiId` for video) in `lib/providers/bindings.ts`; if no `model_bindings` row marks an active provider, active = `"kie"`. **Polarity pinned**: `textOnlyUpstreamId` = "no input media" variant (image t2v); `imageUpstreamId` = "input frames present" variant (video i2v) — video's `imageApiId` never maps into `textOnlyUpstreamId`.
- **Single table (C6)**: `model_bindings` with `PRIMARY KEY (model_id, provider_id)` (multi-binding: openai-compat + replicate + fal coexist per model); names `custom_endpoints` and `model_provider_prefs` are dropped. **Custom logical models are scoped out** — custom bindings attach only to the existing 28 models.
- Registry: `registry.get(providerId)` + `registry.resolveForModel(modelId, explicitProviderId?)` (implements the default rule). A **minimal registry lands in Phase 2** (C7b) so `resumeJob` works before adapters exist.

### `GenerationProvider` interface incl. media-staging contract (`design.md` §1.3 — **finding 1i/1ii/1iii**)
```ts
interface GenerationProvider {
  readonly id: ProviderId; readonly label: string;
  readonly mediaStaging: MediaStagingStrategy;          // provider-level DEFAULT only
  uploadMedia?(localPathOrDataUrl, mimeType, cfg): Promise<string>;   // "remote-url" (kieUpload.ts)
  checkReadiness(cfg, binding?): { ready: boolean; reason?: string }; // azure: baseUrl AND deployment
                                                                        //   (generate/route.ts:326)
                                                                        // codex: keySource "cli" branch
                                                                        //   (codex-status/route.ts)
  submit(input: GenerateInput): Promise<SubmitOutcome>;  // sync result | async upstreamTaskId
  poll?(upstreamTaskId, kind, cfg, meta?: ProviderMeta): Promise<PollOutcome>;
}
```
- **Staging is per-binding** (finding 1i): resolution `binding.mediaStagingByOperation[op]` → `binding.mediaStaging` → `provider.mediaStaging`; operations `"image-generate" | "image-edit" | "video-generate"` (Azure needs JSON-b64 vs multipart — `generate/route.ts:376`; Replicate/fal `data-url`; Kie `remote-url`). **Already-remote `https://` inputs pass through unchanged under every strategy.**
- `PollOutcome = pending | done | error` — **no new state**; fal folds its result fetch into `poll()` (below).
- `ProviderMeta` (C3, pinned shape): `{ upstreamTaskId, family, statusUrl, responseUrl?, upstreamModelId }`.

### `jobManager` + `settleJob` (`design.md` §2 — **C2, C3, C4**)
- **Uniform pre-mint**: `submitJob()` mints `taskId = "${provider.id}-${Date.now()}-${rand}"` for **every** provider (Kie included) and writes the `pending` row to `jobStore` **and** `guestDb` **before** the upstream call (fixes the `generate:549-555` orphan window); the upstream id goes into `provider_meta.upstreamTaskId`, never becomes the canonical `taskId`.
- **C2**: server boot generates a `bootId`; `activeSubmits = Map<taskId, bootId>`; the managed background task wraps `provider.submit()` in **try/catch → `settleJob({status:"error"})`**; `settleJob` is the single release point for `activeSubmits` and `activePollers`. `isActive()` = entry in either registry **from the current boot** → `resumeJob` (called on "pending && !active") can no longer mark a live Azure/Codex job `"Server restarted"` on the client's first poll.
- **`settleJob(taskId, kind, providerId, outcome)`** funnel: mirror media (`uploadBuffer`/`mirrorToR2` → `MEDIA_DIR`) → `jobStore.set` → `guestDb.updateGeneration` → **`jobEvents.emit(\`job:${taskId}\`, …)`** (fixes the O1 SSE-hang bug where Azure/Codex never emitted) → release registry entries; idempotent.
- **C4**: `FalProvider.poll()` reads `meta.statusUrl` (`IN_QUEUE`/`IN_PROGRESS` → `pending`), and on `COMPLETED` fetches `meta.responseUrl`; a **404 right after COMPLETED → `pending`/retry, not `error`** (12-min deadline bounds retries). **kie-veo is a Phase-4 spike**: `/api/v1/veo/record-info` + field mapping must be verified first (`generate-video:481-482` today deliberately doesn't poll Veo); if it fails, Veo stays unpolled exactly as today.
- **`resumeJob`**: reads `provider_id`/`provider_meta` from `jobStore` or `guestDb.recoverJob`; legacy prefix fallback keeps old Kie-upstream-id rows readable; restarts `startPolling` when meta has `upstreamTaskId`, else settles `error`.

### Credential/config store + `/api/settings/providers` (`design.md` §3 — **C7a, C8**)
- `provider_configs(provider_id PK, api_key, base_url, extra_json, updated_at)` — `extra_json` holds Azure per-model deployments. Env fallback chain: kie `DB → KIE_API_KEY → KIE_API_TOKEN` (unifies `db.ts:227` / `generate-video:53`), azure `DB → AZURE_API_KEY` (+`AZURE_BASE_URL`), replicate `DB → REPLICATE_API_TOKEN`, fal `DB → FAL_KEY`, openai-compat `DB → OPENAI_API_KEY`, codex `~/.codex/auth.json` (`CODEX_HOME`).
- **C7a**: one-shot `settings → provider_configs` copy guarded by marker `provider_configs_migrated='v1'`, **legacy `kie_api_token`/`azure_api_key` rows deleted after copy**; legacy `/api/settings/kie-key` & `/azure-key` routes read **and write** `provider_configs` — deleted keys cannot resurrect on restart.
- `GET /api/settings/providers` → `{ providers{…, keySource: "db"|"env"|"cli"|"none", deployments, ready}, modelPrefs, customBindings, bindingsByModel }` (**C8**: `bindingsByModel: Record<modelId, ProviderId[]>` is how the client learns "≥2 → show ProviderToggle"). `PUT` upserts config/prefs/bindings; `DELETE ?providerId=` clears the key.
- UI: `store.providerStatus` + `modelProviders` + `isModelReady(modelId, providerId?)` replace the `kieKeySet` kill-switch at `GenerateNode:1435`, `VideoGeneratorNode:1993`, `gallery:1787,2201`, `KieBanner.tsx:8` (`store.kieKeySet` remains derived for chat compatibility).

### Client/server cut (`design.md` §4 — **C7c, C7d, C8**)
- Delete the 4 branch builders' `localStorage` reads and `isVeo` alternate bodies; clients send normalized `{ model, providerId?, prompt, aspectRatio, quality, resolution, customWidth, customHeight, duration, mode, sound, seed, imageUrls, startFrame, endFrame, … }`; server defaults provider from `model_bindings`.
- **C7d**: one-time localStorage migration — POST once, **delete keys only on 2xx**, versioned marker `aiui-provider-config-migrated="v1"`; failure keeps keys and retries.
- **C8**: `lib/providers.ts` `getModelProvider`/`setModelProvider` rewire to `store.modelProviders` + `PUT` **in the same release as the key deletion** (its importers `GenerateNode.tsx:19`, `gallery/page.tsx:6`, `SettingsModal.tsx:6` keep signatures). `lib/providers/bindings.ts` stays **pure (no `guest/db` import)** — the client never reads the binding module's server side.
- Download proxy: drop `runtime="edge"`, authorize URLs present in `generations.image_url | video_url` only — **flagged separately, see (f)g**.

---

## (d) SQLite Migrations & Env Unification

In `lib/guest/sqlite.ts` `createSchema()` (all idempotent):
1. `ALTER TABLE generations ADD COLUMN provider_id TEXT;` + `ADD COLUMN provider_meta TEXT;` — meta JSON per C3 `{upstreamTaskId, family, statusUrl, responseUrl?, upstreamModelId}` (guarded by `PRAGMA table_info(generations)`; today's schema at `lib/guest/sqlite.ts:33-45` has no provider column at all).
2. `CREATE TABLE IF NOT EXISTS provider_configs (provider_id TEXT PRIMARY KEY, api_key TEXT, base_url TEXT, extra_json TEXT, updated_at TEXT);`
3. `CREATE TABLE IF NOT EXISTS model_bindings (model_id TEXT NOT NULL, provider_id TEXT NOT NULL, binding_json TEXT, is_active INTEGER NOT NULL DEFAULT 0, is_custom INTEGER NOT NULL DEFAULT 0, updated_at TEXT, PRIMARY KEY (model_id, provider_id));` — `binding_json NULL` ⇒ use the static C1 default; at most one `is_active=1` per model, enforced transactionally in `setModelActiveBinding()`.
4. **One-shot legacy copy (C7a)**: if `settings.provider_configs_migrated` ≠ `'v1'`: copy `kie_api_token`/`azure_api_key` → `provider_configs`, **DELETE the two legacy `settings` rows**, set marker `'v1'`. `getKieApiToken()`/`getAzureApiKey()` (`lib/guest/db.ts`) delegate to `getProviderConfig("kie"|"azure")` so `/api/assistant` is untouched.

**Env unification**: single resolver `getProviderRuntimeConfig(providerId)` in `lib/guest/db.ts` — kie `DB → KIE_API_KEY → KIE_API_TOKEN` (kills the `db.ts:227` vs `generate-video:53` mismatch), azure `DB → AZURE_API_KEY` (+`AZURE_BASE_URL`), replicate `DB → REPLICATE_API_TOKEN`, fal `DB → FAL_KEY`, openai-compat `DB → OPENAI_API_KEY` (all rejecting placeholder `your_kie_api_key_here`), codex via `CODEX_HOME` auth-file existence (`app/api/settings/codex-status/route.ts`).

---

## (e) Migration Phases 1-6 (C7 ordering fixes applied)

**Phase 1 — Dead-code deletion.**
Scope: delete `lib/pendingJobs.ts`, `components/nodes/ImageGenNode.tsx`, `components/nodes/VideoGenNode.tsx` (zero importers, verified); remove dead `runAll` (`components/WorkflowCanvas.tsx:1157-1388`).
Validation: `npm run build` / `tsc --noEmit` clean; live workflow via `lib/usePipelineRunner.ts` unchanged.

**Phase 2 — `settleJob()` funnel, `generations.provider_id`, minimal registry, SSE fix.**
Scope: idempotent `provider_id`/`provider_meta` ALTERs; `lib/jobManager.ts` with `settleJob`, `startPolling`, `resumeJob`, `activeSubmits`+`bootId` (C2) and managed-task try/catch; **C7b — minimal `lib/providers/registry.ts` (Map + `get()` with Phase-2 shims: Kie → wrapped `pollKieJob`, azure/codex → no `poll`)** so `resumeJob` resolves providers before Phase 4; Azure/Codex branches pre-insert pending rows and settle via `settleJob` (SSE emit fix); `job-status:35,43` / `job-stream:53` prefix checks replaced by `resumeJob`. Kie keeps upstream-first order until Phase 4 uniform pre-mint (tracked in residual risk).
Validation: Azure/Codex job + `/api/job-stream` resolves on completion (no 12-min hang); `generations.provider_id` populated; **C2 race test** — first poll of a live job does not mark it "Server restarted".

**Phase 3 — Unified credential/config store.**
Scope: `provider_configs` + **`model_bindings`** (C6) + one-shot `settings` migration with marker & legacy-row clear (C7a); `KIE_API_KEY ?? KIE_API_TOKEN` unification; `app/api/settings/providers/route.ts` (`GET` incl. `bindingsByModel` per C8, `PUT`, `DELETE`); legacy key routes write `provider_configs`; client localStorage migration with 2xx-then-delete + versioned marker (C7d).
Validation: `GET` readiness accurate for kie/azure/codex/replicate/fal and `bindingsByModel` lists `"kie"` for all 28 models; restart after `DELETE ?providerId=kie` → key does **not** resurrect; failed migration POST → localStorage keys survive.

**Phase 4+5 — JOINT LANDING (C7c): registry + adapters + client-branch strip + UI readiness.**
Scope (internal order): `lib/providers/{types,mediaStager,bindings,registry}.ts` (static C1 set + `resolveForModel` upgrade); extract `adapters/kie.ts` (absorb `kieUpload.ts` as `uploadMedia`, 9 family builders from `generate-video:77-361`, uniform pre-mint, **kie-veo `record-info` spike per C4 — verify before wiring, else keep today's no-poll Veo**), `adapters/azure.ts`, `adapters/codex.ts` (incl. `checkReadiness` azure-deployment + `keySource:"cli"` branches); slim both routes to thin controllers over `jobManager.submitJob()`; strip client branching (`GenerateNode:630-664`, `VideoGeneratorNode:981-1008`, `gallery:1632-1648,1726-1754,2903-2908`); **rewire `lib/providers.ts` to the store (C8)**; replace `kieKeySet` gates with `isModelReady` (`GenerateNode:1435`, `VideoGeneratorNode:1993`, `gallery:1787,2201`, `KieBanner`); provider selector for any model with ≥2 providers in `bindingsByModel`; consolidate icons into `components/ui/ProviderIcon.tsx`.
Why joint: Phase 4 strips client branching while Phase 5 adds selector/readiness — shipping them separately regresses Azure/Codex-only users in between (C7c). There is no intermediate commit where the rewire (C8) and key deletion are apart.
Validation: Kie/Azure/Codex image+video from node, video node, gallery (incl. retry) all return `{taskId}` and settle via `jobManager`; Kie-key-unset + Azure-only config → `KieBanner` hidden, generation allowed; provider choice persists across reload.

**Phase 6 — Replicate, fal, openai-compat adapters + download route.**
Scope: `adapters/replicate.ts` — **async-poll only** (`Prefer: wait` sync deferred as future option), then delete orphan `app/api/generate-image/route.ts`; `adapters/fal.ts` with C4 status+result-fetch and COMPLETED-then-404→pending; `adapters/openaiCompat.ts` + custom-endpoint UI (bindings into `model_bindings`, existing models only); `app/api/download/route.ts` drop `runtime="edge"` + authorize URLs present in `generations` — **separate review, see (f)g**.
Validation: configure Replicate/fal key or custom endpoint, bind a model, generate image+video in canvas and gallery, verify local mirroring + download.

---

## (f) Residual Risks & Explicit Hedges (o2-gate finding 6, a-g)

- **(a) Provisional data**: the `provider_meta` shape and the 9-family taxonomy are **pinned in design.md** (C1/C3) but the *per-model family assignments* and status/response URL templates remain provisional until implemented and exercised against live payloads — treat them as spec constants to verify, not measured facts.
- **(b) Bindings don't exist yet**: the built-in static binding set (28 models × Kie) is a **Phase-4 deliverable in code** (`lib/providers/bindings.ts`), with the C1 default-binding rule; **no SQLite rows exist today** for it. Do not read the API/DB as if `model_bindings` were pre-populated.
- **(c) Custom logical models are out of scope**: users can add custom *bindings* to existing models only; "register a new logical model" has no table and no catalog merge — reject/scope any request for it.
- **(d) Client/server boundary**: `lib/providers/bindings.ts` must stay **pure — no `guest/db` import** or client bundles break; the client learns available providers **from `GET /api/settings/providers` (`bindingsByModel`/`modelPrefs`)**, never from the binding module.
- **(e) Client-side capability fields (stay on the logical model)**: `apiInput` in full (incl. `promptMaxLength`, `qualityOptions`, `qualityKey`, `videoRefMaxDuration`, `durationMax`, `useMotionControl`, …) and `textOnlyPromptMaxLength`, read at `PromptNode:170,173`, `GenerateNode:31-32,404`, `VideoGeneratorNode:401,587,831,1235,1269,1714,1792`, `VideoInputNode:455-456`, `WorkflowCanvas:925-926,1053`, `store.ts:419`. Moving any of these to server-side bindings silently breaks UI.
- **(f) Per-phase no-regression guarantee**: Phases 1-3 are additive; Phases 4+5 ship **as one release**, so there is no state where client branching is stripped but readiness/selectors/`providers.ts` rewire are absent. Azure-only/Codex-only users (no Kie key) must keep a working path end-to-end — validate explicitly each release.
- **(g) Download-route change flagged separately**: replacing the 3-domain allowlist (`app/api/download/route.ts:10-15`) with "URL exists in `generations.image_url | video_url`" broadens a server-side fetch primitive to any upstream-supplied URL ever stored. It stays bounded **only** by the `image_url`/`video_url`-columns-only check — do not widen it to arbitrary stored URLs, and give it its own review rather than riding along with Phase 6 adapters.
- **Additional residual risks (design.md §6)**: in-process job loss on hard crash (azure/codex/openai-compat) — `resumeJob` settles them `error`; Kie pre-mint orphan window persists until Phase 4; kie-veo stays unpolled if the spike fails; `>25MB` data-url staging limits; `.job-store.json` whole-file contention preserved deliberately.

---

## (g) What NOT to Touch

- **`src-tauri/`** — zero Rust changes, no IPC commands, no OS keyring/Stronghold (rejected in O1 §3.1; the Tauri shell is a thin launcher around the Node sidecar).
- **`lib/executor.ts` and `lib/usePipelineRunner.ts`** — wave scheduling, topological sort, handle resolution, and the exact `NodeData.status` transitions (`pending` 3s cancel → `running` → `done|error`, `usePipelineRunner:78-91`) are contract.
- **`/api/assistant` and `lib/models.ts` (chat LLMs)** — out of scope; legacy `getKieApiToken()`/`getAzureApiKey()` wrappers must keep working.
- **Webhook ingestion** — no `/api/callback`; poll/SSE only (desktop has no public ingress).
- **`.job-store.json` format** — keep backward-compatible reads (legacy Kie-upstream-id keys must remain readable via `resumeJob` prefix fallback).
- **Logical model ids stay bare** — do **not** adopt `provider:model` addressing (`NodePickerMenu:192-205` relies on bare ids; default `"nano-banana-2"`).
- **Keyring/Stronghold/OS credential stores** — keep SQLite `guest.db` + env fallback.
- **Do not refactor dead code — delete it**: `WorkflowCanvas.runAll` (`:1157-1388`), `ImageGenNode`, `VideoGenNode`, `lib/pendingJobs.ts`, and `/api/generate-image/route.ts` once Replicate is an adapter (Phase 6).

---

## (h) Deepwork Artifacts (all under `.slim/deepwork/provider-refactor-plan/`)

1. **`inventory.md`** — as-is architecture map with file:line refs + the 10 ranked blockers (Phase 1 explorer output; source for section (b)).
2. **`patterns.md`** — provider-registry research (Vercel AI SDK, LiteLLM), API-shape comparison table (OpenAI/Replicate/fal), credential-store findings (keyring rejected in O1), and the original `GenerationProvider` adapter sketch (source for section (c)).
3. **`o1-gate.md`** — O1 CONDITIONAL PASS: factual spot-check corrections (dead `runAll`, SSE emit bug, `KIE_API_KEY`/`KIE_API_TOKEN` mismatch), 5 completeness gaps (kill-switch, media staging, status machine, download allowlist, `generations.provider_id`), keyring rejection, `{taskId}`+`settleJob` constraint, and the 5 ordered Phase-2 design inputs + no-touch list.
4. **`design.md`** — the architecture under remediation: §1 registry/binding/`GenerationProvider` split (C1, C5, C6), §2 `jobManager`/`settleJob`/`resumeJob` (C2, C3, C4), §3 SQLite + `/api/settings/providers` (C7a, C8), §4 client/server cut (C7d, C8), §5 phases (C7b, C7c), §6 residual risks (finding 1iv). **All C1-C8 conditions and findings 1-4 are resolved in-place — read it as the binding spec.**
5. **`o2-gate.md`** — O2 CONDITIONAL PASS: binding conditions C1-C8 (now resolved in `design.md`) and findings 1-6 (hedges reproduced in section (f)).

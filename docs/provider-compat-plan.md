# Provider Compat Plan — Rescoped Phase 6 (OpenAI-Compatible Family)

Status: draft. Supersedes design.md §5 Phase 6 and docs/provider-adapters-starter.md as build plans (both retained as research archives).

## (a) Direction & decision log

- Product bet (user): the workflow/UI canvas is the appeal; backends are interchangeable plumbing. No vendor locks — hard constraint.
- Rejected: fal.ai (single hosted vendor + credit markup), hosted aggregators generally (kie-clones, Replicate-billed, SpicyAPI), HuggingFace wrapper (new dep, zero bindings), Segmind BYOK (full-proxy data path + thin legal docs — see .slim/segmind-privacy.md; consumer-grade only).
- Adopted: **one `openai-media-compat` binding family** — provider = `{baseURL, keyEnv, paramMap}` triplet (LiteLLM custom-provider pattern), user-pointed backends, no single throat to choke.
- Per-model params on **needs basis only**: seed each binding's paramMap with the handful of models actually used; unknown params pass through.
- Robustness = **stored param presets** referenced by bindings, not manual per-model entry (user requirement).
- Q3 ruled: no full harness day — one lightweight permanent smoke fixture inside the build lane instead.
- Q4 ruled: design Phase 6 trio SUPERSEDED (replicate/fal dedicated adapters dead; full custom-endpoint UI dead; endpoint config survives only scoped to compat bindings).

## (b) Target shape

One provider id, `openai-compat`, implemented once in `lib/providers/adapters/openaiCompat.ts`:

- `submit`: `POST {baseUrl}/images/generations` (sync; `b64_json` → buffers or `url` → mirror), `POST {baseUrl}/images/edits` when reference media present (multipart-buffer staging). Responses normalize to `SubmitOutcome` sync form. Dialect overrides (OpenRouter `/images` path, `aspect_ratio`/`resolution`/`input_references` names) live in the binding's `paramMap` + `pathOverride`, not in code branches.
- `poll`: undefined (sync-only family). Async compat backends are explicitly out of scope until the harness question reopens.
- `checkReadiness`: key present (DB/env) + baseUrl configured. No deployment concept (that's Azure's).
- `mediaStaging`: `data-url` default; per-binding override (multipart-buffer for edits endpoints that need it).
- `provider_meta`: `{upstreamTaskId: null, family: "standard", statusUrl: null, responseUrl: null, upstreamModelId}`.

Backends ride the family by configuration, not code: OpenAI direct, Azure (already covered — stays on its dedicated adapter, no change), OpenRouter (dialect binding), Pollinations sync leg (`/v1/images/generations`), user-run LiteLLM/new-api gateways, any future OpenAI-speaking endpoint.

## (c) Preset layer (robustness requirement)

**Implemented (P6b).** `param_presets` table + code-seeded rows in
`lib/providers/presets.ts` (seeded by `lib/guest/sqlite.ts`, read by
`lib/guest/db.ts`); the resolution order lives in `registry.resolveForModel`
(`preset params ← binding.paramMap ← custom-binding overrides`) and applies to
the `openai-compat` family only (`GenerationProvider.usesParamPresets`); an
unknown preset id fails the job loudly (`binding.presetError` → the adapter
throws → the job settles with the message).

New table `param_presets` (`preset_id TEXT PRIMARY KEY`, `family TEXT`, `params_json TEXT NOT NULL`, `updated_at TEXT`) + resolution rule: binding effective params = preset params ← binding `paramMap` ← `custom_binding_json` overrides. Seed presets for the shapes encountered so far (standard image, image-edit, OpenRouter dialect, Pollinations sync). A binding references at most one preset; validation rejects unknown keys loudly (fail fast on typos, per the "robust" requirement). UI: preset picker in the compat endpoint config (dropdown + view-only JSON preview first; no preset editor in v1 — presets ship as code-seeded rows, editing is a later task).

## (d) Endpoint config UI (scoped)

**Implemented (P6b).** The SettingsModal's API-Keys panel gained a
"Compatible endpoints" section: one card per compat backend (OpenRouter +
`openai-compat`) with base URL, API key and the preset picker (dropdown +
view-only JSON preview). Writes go through `PUT /api/settings/providers`
(extended with `presetId`; an unknown id → 400) and `DELETE ?providerId=`;
`GET /api/settings/providers` now also returns the preset list.

Extend the P5 SettingsModal providers section (no new top-level surface): for `openai-compat` bindings, base URL + key fields + preset picker, written through the existing `PUT /api/settings/providers` (already accepts baseUrl/apiKey; extend with `presetId`). Delete flow reuses `DELETE ?providerId=`. This is the user-pointed-backend story — the deferred B1 delete already landed, so no localStorage involvement.

## (e) Build sequence (one lane, sequential commits)

1. **Binding-availability spike (doc-only):** written table catalog-model → compat backend + upstream id, from live listings (OpenRouter `/images/models`, Pollinations `/image/models`). Ship a backend only with ≥3 real rows. No code.
2. **Compat provider + first bindings:** `openaiCompat.ts`, registry registration, seed bindings for spike-cleared models (OpenRouter dialect + Pollinations sync first), smoke fixture `scripts/providers/smoke-compat.mjs` (stub submit→settle→mirror, staging data-url, readiness gating, bindingsByModel union, one live smoke needing a key). Commit.
3. **Presets + endpoint UI:** `param_presets` table + resolution + seed presets, SettingsModal wiring, validation. Commit.
4. **Backlog (explicitly not this phase):** async compat backends (reopens poll + `done.buffers` + full harness), custom logical models, download-proxy change (own review), kie retirement.

## (f) Validation (permanent, lightweight)

- `tsc --noEmit` exit 0; eslint zero-new-vs-HEAD on touched files.
- Smoke fixture runnable offline except the single live step; checks: sync submit→settle→DB+jobStore+emit, buffer mirroring path, readiness gates, union bindings, preset resolution order (preset ← binding ← custom override).
- No oracle gate required for the spike (doc-only); one tight gate before the provider commit (new external integration), same bar as O5.

## (g) Kill list (explicit)

Dead and staying dead: 4 starter dedicated adapters (as code — backends survive as compat bindings), fal/Replicate/SpicyAPI/HF integration work, Kie-family payload expansion (freeze at current coverage; kie stays the legacy backend), full custom-endpoint/model UI, download-proxy change (separate review), conformance-harness day (replaced by the smoke fixture).

## (h) Open items

- Async compat backends (Pollinations `Prefer: respond-async`, gateway video routes): need poll + `done.buffers` + harness — reopens Q3. Not started.
- Kie retirement: only when compat coverage demonstrably replaces the catalog models users actually generate with. No date set.

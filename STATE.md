# STATE
status: done        # active | paused | blocked | done
focus: Settings trio + debrand landed on feat/pluggable-providers (assistant BYOK 989ba4f, debrand c96db3c); branch ready for review/merge
next: User call - merge feat/pluggable-providers, workflow automations + experimentation, or next scope item
blockers: none
updated: 2026-10-21

## Notes

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

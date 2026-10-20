# /api/generate-image — Replicate text-to-image (sync)

## Responsibility
Minimal synchronous image generation via Replicate predictions. Separate from the
main `/api/generate` path (no jobStore, no DB row) — used for quick/simple renders.

## Design
- `POST` body `{ prompt, model? }` where `model` ∈
  `flux-schnell` (default) | `flux-dev` | `sdxl`, mapped to Replicate model
  identifiers (`modelMap`); a `owner/name:version` string falls back to `flux-schnell`.
- Requires `REPLICATE_API_TOKEN` env (500 if unset).
- Uses the Predictions API with `Prefer: wait=60` so completed jobs return inline;
  otherwise polls `GET /v1/predictions/{id}` every 2 s for up to 30 iterations (~60 s).
- No persistence: the result URL is returned directly and never recorded in
  `generations`/`uploads`.

## Flow
1. Validate `prompt`.
2. `POST https://api.replicate.com/v1/predictions` with
   `{ model | version, input: { prompt, num_outputs: 1 } }`.
3. If `status === "succeeded"` → return `{ imageUrl }` (first output entry).
4. Else poll until `succeeded` / `failed`; timeout → 504, failure → 500.

## Integration
- **Replicate**: `POST /v1/predictions`, `GET /v1/predictions/{id}`, Bearer token.
- **Response**: `{ imageUrl }` on success; `{ error }` with 500/504 on failure.
- No jobStore / guest DB / storage involvement.

# Adding a Space or an MCP server

Practical guide for pointing OpenMedia Studio at a backend you own or trust.
Two families are covered: a **Hugging Face Space** (Gradio queue API) and an
**MCP server** (streamable HTTP). Both are "custom endpoints" — the app never
ships a catalogue of them, and you supply the credentials.

Already-bound Spaces (no setup needed): `moss-image-8-step-dmd`,
`smd-minimax-h3-ref2va-few-step`, plus the earlier `z-image-turbo` and
`wan2-1-fast`. The signatures are recorded in
[`provider-phase7-spike.md`](./provider-phase7-spike.md).

## 1. Add the backend

Settings → **Custom endpoints** → **Add backend**.

| Field | HF Space | MCP server |
|---|---|---|
| id | any stable slug, e.g. `mflux` | e.g. `my-mcp` |
| family | `HF Space` | `MCP server` |
| base URL | `https://<owner>-<space>.hf.space` | the MCP endpoint, **with a trailing slash** for a Space: `https://<space>.hf.space/gradio_api/mcp/` |
| token | HF token (`hf_…`) — optional for a public Space, required for a private one | bearer token, if the server wants one |
| label | free text | free text |

The same thing over the API:

```bash
curl -X PUT http://127.0.0.1:3000/api/settings/providers \
  -H 'Content-Type: application/json' \
  -d '{"providerId":"mflux","kind":"gradio","baseUrl":"https://owner-space.hf.space","apiKey":"hf_...","label":"My Space"}'
```

`kind` is `openai-compat` (default when absent), `gradio`, or `mcp`. The id is
free-form: the family is read from `kind`, so the same adapter serves any number
of your backends.

**Send the HF token even for a public Space.** ZeroGPU bills the *caller*: with a
token the quota lands on your account; without one it comes from the anonymous
pool and is far smaller. It also decides a code path — with a token the Space is
treated as private and the result bytes are fetched in-process, without one the
result URL is handled by the normal media mirror.

## 2. Point a model at it

Two options.

**An existing catalogue model** — set its provider preference:

```bash
curl -X PUT http://127.0.0.1:3000/api/settings/providers \
  -H 'Content-Type: application/json' \
  -d '{"modelPrefs":{"my-model-id":"mflux"}}'
```

**A model the catalogue does not have** (the usual case for a Space — mflux is
not a shipped model). Create the logical model, then bind it:

```bash
# 1. the logical model (schema fields only; everything else defaults neutral)
curl -X POST http://127.0.0.1:3000/api/settings/providers \
  -H 'Content-Type: application/json' \
  -d '{"id":"mflux","kind":"image","label":"MFlux (my Space)","ratios":["1:1","16:9"]}'

# 2. the binding: the fn name for a Space, the tool name for MCP
curl -X PUT http://127.0.0.1:3000/api/settings/providers \
  -H 'Content-Type: application/json' \
  -d '{"customBindings":[{"modelId":"mflux","providerId":"mflux",
        "binding":{"upstreamModelId":"/generate","mediaStaging":"remote-url",
                   "argMap":{"sources":{"0":"prompt","4":"seed"},
                             "constants":{"1":1024,"2":1024}}}}]}'
```

`upstreamModelId` is the Space's **fn channel** (`/generate`, `/generate_image`)
or the MCP **tool** name. The model appears in the canvas and gallery pickers
once it has a binding; until then it is listed but disabled with `no backend`.

## 3. The argMap is positional, and it is not the UI order

A Gradio call takes a required positional `data[]` array, and `/gradio_api/info`
is the only authority on that order:

```bash
curl -s https://owner-space.hf.space/gradio_api/info | jq '.named_endpoints'
```

Two real Spaces, same task, different positions: Z-Image-Turbo puts `seed` at
index 4, FLUX.1-schnell at index 1. `smd-minimax-h3-ref2va-few-step` is worse —
its `variant` string sits **between** `reference_2` and `reference_3`, so a map
that assumes refs are contiguous stuffs a step count into an image slot.

argMap keys:

- `sources` — index → normalized source (`prompt`, `seed`, `aspectRatio`,
  `startFrame`, `endFrame`, `videoRef`, `{kind:"referenceAt",index:0}`, …)
- `constants` — index → static upstream value
- `fileInputs` — indices whose value must be wrapped as a Gradio FileData dict
- `valueMap` — index → normalized value → upstream literal. Use it when the
  Space takes an enum instead of numbers (minimax's `canvas` carries the
  resolution *and* the ratio as one string, so the ratio picker maps through it)

Unmapped indices are sent as literal `null` ("use the upstream default"). The
array never shrinks — position is the contract.

For MCP the map is named, not positional: argument name → source.

## 4. MCP specifics

- **Tool names are not reconstructable.** `Z_Image_Turbo_generate_image` is
  underscore-separated; `wan2_1_fastgenerate_video` has no separator where the
  repo stem ends in a digit. Resolve the tool from `meta.endpoint_name` in
  `GET /gradio_api/mcp/schema`; never rebuild the string.
- **A 404 from `/gradio_api/mcp/schema` means "MCP not enabled on this Space"**,
  not a network failure. The Gradio queue lane still works on the same Space.
- The adapter negotiates protocol version: it advertises `2025-06-18` as a floor
  and adopts whatever the server answers, so a future SDK-2.x server does not
  need a second dialect. Gradio's mcp 1.x rejects the 2026-07-28 revision
  outright.
- **v1 is images only.** A video tool result is refused loudly: video needs the
  URL branch (`/gradio_api/file=…`) rather than an unbounded base64 buffer.
- Staging is `data-url`. A tool that needs an uploaded file must name its own
  upload path, otherwise a local reference fails loudly rather than silently.

## 5. Gotchas that cost time

- **Trailing slash.** `…/gradio_api/mcp` 307s; `…/gradio_api/mcp/` is the
  endpoint.
- **`isError: true` is a tool error, not a transport error** — HTTP 200 with an
  error body. It settles the job as an error and is not retried.
- **Enum params.** Anything Gradio types as a `Literal` (`scheduler`,
  `frame_multiplier`, `canvas`, `variant`) needs a constant or a `valueMap`; a
  raw source will not coerce.
- **Output links go stale.** A Space's `/gradio_api/file=…` pointer is valid
  briefly, which is why results are mirrored into local media immediately.
- **Private Space media is never handed to the mirror.** The bytes are fetched
  in-adapter with your token and stored directly, so the mirror never sends an
  unauthenticated request at a token-gated URL.
- **Foreign hosts are refused.** Any file URL a Space or tool returns must sit
  on the origin you configured; otherwise the job fails with a `foreign origin`
  error. That is deliberate — a compromised backend should not be able to point
  the server at `127.0.0.1` or a metadata endpoint.

## 6. Verifying a new Space before you bind it

```bash
# positional order + defaults
curl -s https://owner-space.hf.space/gradio_api/info | jq '.named_endpoints'
# is MCP on? (404 = not enabled)
curl -s -o /dev/null -w '%{http_code}\n' https://owner-space.hf.space/gradio_api/mcp/schema
```

Then replay it offline before shipping: `node scripts/providers/smoke-gradio.mjs`
and `smoke-mcp.mjs` run against captured bodies with a stubbed fetch, so a new
binding can be proven without spending quota.

## Known gaps

- `prithivMLmods/FireRed-Image-Edit-1.0-Fast` is **not bound**. Its
  `images_b64_json` slot is a bare `str` whose encoding is not published — it is
  a `data-url` lane, not the upload lane, and guessing the shape would produce
  silent wrong. Needs one deliberate live probe.
- No UI form for creating custom *models*; that stays API-driven (step 2). The
  Add backend card covers backends only.

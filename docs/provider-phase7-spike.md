# Phase 7 Spike — live endpoint captures (step 1 of the build sequence)

**Date:** 2026-10-29 · **Mode:** read-only discovery — GET `/gradio_api/info` + GET
`/gradio_api/mcp/schema` on three public HF Spaces, plus one protocol-level
`initialize` + `tools/list` against a public generic (non-Gradio) MCP server
(`mcp.deepwiki.com/mcp`). **No generation endpoints were called; no ZeroGPU
quota was spent.** The generic MCP leg deliberately stays at handshaking —
tool results were never requested.

Purpose: freeze the positional `data[]` signatures and the MCP discovery
shapes that `GradioArgMap` / `McpArgMap` (P7a-3) encode, and seed the offline
fixtures for `smoke-gradio.mjs` / `smoke-mcp.mjs` (steps 3–4).

## Fixtures

All raw response bodies captured unmodified into `docs/fixtures/phase7/`
(+ the request/reply transcript for the generic MCP handshake):

| Fixture | Source | Size |
|---|---|---|
| `z-image-turbo-info.json` | `GET https://mrfakename-z-image-turbo.hf.space/gradio_api/info` · HTTP 200, `application/json` | 9,401 B |
| `z-image-turbo-mcp-schema.json` | `GET …/gradio_api/mcp/schema` · HTTP 200 | 1,420 B |
| `flux1-schnell-info.json` | `GET https://black-forest-labs-flux-1-schnell.hf.space/gradio_api/info` · HTTP 200 | 3,263 B |
| `flux1-schnell-mcp-schema.404.json` | `GET …/gradio_api/mcp/schema` · **HTTP 404** (negative capture) | 22 B |
| `wan2-1-fast-info.json` | `GET https://multimodalart-wan2-1-fast.hf.space/gradio_api/info` · HTTP 200 | 13,016 B |
| `wan2-1-fast-mcp-schema.json` | `GET …/gradio_api/mcp/schema` · HTTP 200 | 2,252 B |
| `generic-mcp-initialize.txt` | `POST https://mcp.deepwiki.com/mcp` `initialize` · HTTP 200, `text/event-stream`, **no `Mcp-Session-Id` issued** | 4,089 B |
| `generic-mcp-tools-list.txt` | `POST …` `tools/list` (after `notifications/initialized` → no body read) · HTTP 200 | 1,608 B |

All Bodies are the complete server responses (byte-exact), suitable as
`smoke-lib.mjs` replay fixtures without further editing.

## Space positional signatures (authoritative param order from `named_endpoints`)

`/gradio_api/info` → `named_endpoints["/<fn>"].parameters` is the
authoritative positional order. Captured in capture order (i.e. exactly the
order a submit's `data` array must use):

### `mrfakename/Z-Image-Turbo` · fn `/generate_image` (image)

| # | Param | Gradio type | Default |
|---|---|---|---|
| 0 | `prompt` | string | — (required) |
| 1 | `height` | number | 1024 |
| 2 | `width` | number | 1024 |
| 3 | `num_inference_steps` | number | 9 |
| 4 | `seed` | integer | 42 |
| 5 | `randomize_seed` | boolean | true |

Returns: `object` (ImageData — `.url` points at `/gradio_api/file=<path>` when
the response is fresh; the file link goes stale on the server side shortly
after), `number` (seed actually used). Matches the plan appendix verbatim.

### `black-forest-labs/FLUX.1-schnell` · fn `/infer` (image)

| # | Param | Gradio type | Default |
|---|---|---|---|
| 0 | `prompt` | string | — (required) |
| 1 | `seed` | number | 0 |
| 2 | `randomize_seed` | boolean | true |
| 3 | `width` | number | 1024 |
| 4 | `height` | number | 1024 |
| 5 | `num_inference_steps` | number | 4 |

Returns: `object` (ImageData), `number`. Note the **shape-identical-in-kind**
but **different position** layout vs Z-Image-Turbo (`seed`/`randomize_seed`
at [1..2] here vs [4..5]; width/height swapped) — the concrete proof of the
plan's "position ≠ UI order ≠ another Space's order" caveat. argMap must be
per-binding recorded, never family-guessed.

### `multimodalart/wan2-1-fast` · fn `/generate_video` (video/image→video)

| # | Param | Gradio type | Default |
|---|---|---|---|
| 0 | `input_image` | **object** (FileData) | — (required) |
| 1 | `prompt` | string | "make this image come alive, cinematic motion…" |
| 2 | `height` | number | 512 |
| 3 | `width` | number | 896 |
| 4 | `negative_prompt` | string | "Bright tones, overexposed, static…blurry, low resolution" |
| 5 | `duration_seconds` | number | 2 |
| 6 | `guidance_scale` | number | 1 |
| 7 | `steps` | number | 4 |
| 8 | `seed` | number | 42 |
| 9 | `randomize_seed` | boolean | true |

Returns: `object` (VideoData), `number`. Slot 0 is the single-file positional
case: this is the binding lane that motivated rev-2's `source: "startFrame"`
style single-slot file variants (`referenceAt`-equivalent for video-ref) — the
submitted value must be a `{"path": …, "meta": {"_type": "gradio.FileData"}}`
dict from `POST /gradio_api/upload`. Matches the plan appendix verbatim.

## MCP discovery findings

### `GET /gradio_api/mcp/schema` (sessionless tool listing — Gradio-native)

Shape (both enabled Spaces agree): a **bare JSON array** (not an MCP envelope)
of `{name, description, inputSchema, meta: {endpoint_name, mcp_type: "tool",
file_data_present}}`:

- Z-Image-Turbo exposes `Z_Image_Turbo_generate_image` (endpoint_name
  `/generate_image`) among 3 tools; wan2-1-fast exposes
  `wan2_1_fastgenerate_video` (endpoint_name `/generate_video`) plus two
  `handle_image_upload_for_dims_*` helpers.
- **Naming convention (recorded, not idealized):** tool name = normalized repo
  stem + endpoint name, **with NO separator** where the stem already ends in a
  digit (`wan2_1_fastgenerate_video`), and `_`-separated elsewhere
  (`Z_Image_Turbo_generate_image`). The adapter must resolve the tool by
  `meta.endpoint_name` — never by reconstructing the convention (rev-2 plan's
  `/mcp/` discovery section accordingly takes the recorded list as the source
  of truth).
- `inputSchema` is standard JSON Schema with `description`/`default` filled
  from the Space's UI metadata — the same shape a binding's `McpArgMap` keys
  against by argument NAME.

**Negative capture:** FLUX.1-schnell (a Space with MCP **not** enabled)
answers `HTTP 404, {"detail":"Not Found"}` on `/gradio_api/mcp/schema`. The
settings card's "Inspect" action must treat 404 as "MCP not enabled on this
Space" (the Gradio queue lane still works — `/info` on the same Space is
healthy), never as a network error.

### Generic (non-Gradio) MCP server — `mcp.deepwiki.com/mcp`

- `initialize` (advertised `2025-06-18`) → HTTP 200, `text/event-stream`
  body `event: message\ndata: {"result":{"protocolVersion":"2025-06-18",…,
  "serverInfo":{"name":"DeepWiki","version":"2.14.3"}}}`.
  **Negotiates to the advertised floor** — the rev-2 negotiated-version rule
  holds on a fresh server. No HTTP POST-JSON reply; SSE framing even when
  Accept offered both — the "branch on response content-type" contract is
  confirmed on a non-Gradio server too.
- **No `Mcp-Session-Id` issued** — session-less servers are the norm, not a
  Gradio quirk; the "capture and resend when present" path stays optional.
- `notifications/initialized` → accepted (no reply body read).
- `tools/list` → HTTP 200 SSE envelope with `result.tools[]` carrying
  `name`/`description`/`inputSchema`/`_meta` (fastmcp tags) — the schema shape
  `McpArgMap` keys against by name. Raw transcript in the fixtures dir.

## Implications carried forward (no code changes in this step)

1. **P7a-3 fixtures frozen:** the three `/info` bodies here are the argMap
   seeds; `smoke-gradio.mjs` will replay them byte-exact via the upgraded
   harness (step 2's stream-capable `fakeResponse`).
2. `wan2-1-fast` slot 0 (`input_image`) is the first confirmed
   single-file positional slot — `GradioArgMap.fileInputs` + the
   `referenceAt`/`startFrame` source variants have a recorded consumer.
3. Tool resolution goes through `endpoint_name`; the name-convention
   (`Space-stem + fn`, separatorless where digit-adjacent) is a string
   observation, not a contract.
4. 404 on `/mcp/schema` = "MCP not enabled", a distinct UI/pathology state
   from network failure — the gradio card wires this, not the mcp card.
5. The generic server data points (SSE-always, no session id, negotiated
   version) come from deepwiki at handshake-only depth — a sessionful server
   (one that issues `Mcp-Session-Id`) remains to be exercised in step 4's
   fixtures, replayed offline from a captured frame like any other wire shape.

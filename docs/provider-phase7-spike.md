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

## Addendum — the `tools/call` capture (P7c, 2026-10-29)

`docs/fixtures/phase7/deepwiki-tools-call.txt` is a **real capture, not
synthesized**: one `tools/call` (`read_wiki_structure`, `repoName:
"facebook/react"`) against `https://mcp.deepwiki.com/mcp` on the same day,
HTTP 200 `text/event-stream`, no `Mcp-Session-Id` issued. It post-dates the
"handshake-only" scope above — the generic MCP leg was later exercised one step
further to freeze the tool-result envelope (`content[]` text +
`structuredContent`, `isError:false`) that `smoke-mcp.mjs` replays byte-exact.
No generation endpoint was called and no ZeroGPU quota was spent. It is a
text-only success (no media), which is exactly the loud `no media in tool
result (content types: text)` case the adapter must settle rather than a silent
empty success.

## Operator-supplied target Spaces — `/gradio_api/info` verified 2026-10-29

Three Spaces requested as high-value targets. Signatures below are the
AUTHORITATIVE positional order read back from `/gradio_api/info` (not the
generated client SDKs, whose keyword form hides the wire order).

### `hugging-apps/moss-image-8-step-dmd` · fn `/generate` (image)

base `https://hugging-apps-moss-image-8-step-dmd.hf.space`

| # | Param | Type | Default |
|---|---|---|---|
| 0 | `prompt` | str | — (required) |
| 1 | `height` | float | 1024 |
| 2 | `width` | float | 1024 |
| 3 | `num_steps` | float | 8 |
| 4 | `seed` | int | 0 |
| 5 | `randomize_seed` | bool | true |
| 6 | `lora_strength` | float | 0.7 |

Returns `[ImageData, seed]`. Straight image lane — note `num_steps` is a FLOAT
and there is a `lora_strength` slot no other recorded Space has.

### `hugging-apps/smd-minimax-h3-ref2va-few-step` · fn `/generate` (video)

base `https://hugging-apps-smd-minimax-h3-ref2va-few-step.hf.space`

| # | Param | Type | Default |
|---|---|---|---|
| 0 | `prompt` | str | — (required) |
| 1 | `reference_1` | filepath | null |
| 2 | `reference_2` | filepath | null |
| 3 | `variant` | Literal['4-step','8-step'] | '4-step' |
| 4 | `reference_3` | filepath | null |
| 5 | `canvas` | Literal['1344x768 · 16:9 (trained)', '960x544 · 16:9 fast', '768x1344 · 9:16', '544x960 · 9:16 fast', '768x768 · 1:1', '1024x768 · 4:3', '768x1024 · 3:4'] | '1344x768 · 16:9 (trained)' |
| 6 | `duration` | float | 5 |
| 7 | `seed` | int | 42 |
| 8 | `randomize_seed` | bool | false |

Returns `[VideoData, seed]`. **`variant` sits BETWEEN `reference_2` and
`reference_3`** — the sharpest yet "position ≠ UI order" case: a reference
slot map that assumes refs are contiguous puts the step-count string into an
image slot. `canvas` is a Literal carrying the resolution + ratio, so the
ratio picker maps through a valueMap rather than width/height slots.

### `prithivMLmods/FireRed-Image-Edit-1.0-Fast` · fn `/edit_image` (image edit)

base `https://prithivmlmods-firered-image-edit-1-0-fast.hf.space`

| # | Param | Type | Default |
|---|---|---|---|
| 0 | `images_b64_json` | str | — (required) |
| 1 | `prompt` | str | — (required) |
| 2 | `seed` | int | — |
| 3 | `randomize_seed` | bool | — |
| 4 | `guidance_scale` | float | — |
| 5 | `steps` | int | — |

UNRESOLVED: `images_b64_json` is a `str`, not a filepath/FileData slot, so the
encoding (a bare base64 string? a JSON array? data URLs?) is not derivable
from `/info` and NO default is published. It is a `data-url`-ish lane, not the
`remote-url` upload lane, and it must NOT be bound on a guess. Also present:
`/check_safety` (one `prompt`) and `/load_example` (one `idx`), both helpers —
not generation paths.

### Reviewed but deliberately UNBOUND — `JCisHERE/wan2-2-i2v-v3`

Not bound by product decision (its `lora_groups` slot is a large adult-content
enum; exposing that as a model param is a different call than provider
plumbing). The doc was still worth mining for wire facts, which are recorded
here because they constrain code we already ship:

1. **A REQUIRED start+end frame pair exists in the wild.** `input_image` and
   `last_image` are both required `Image` (FileData) slots — the first observed
   Space where the end frame is mandatory, which is exactly what the
   `startFrame`/`endFrame` sources were added for.
2. **FileData is a typed record, not a bare string**:
   `{path, url, size, orig_name, mime_type, is_stream, meta}` where `path` is a
   *local file* and `url` is a *publicly available URL or base64 image*. Our
   wrapper used to put public URLs in `path` only; `gradio.ts#fileDataOf` now
   carries BOTH for absolute references (and `path` alone for an uploaded
   `/tmp/gradio/…` path), matching `gradio_client`'s `handle_file`.
3. **Enum-valued params recur** (`scheduler`, `frame_multiplier`; minimax's
   `variant`/`canvas`): they need Literal constants or a `valueMap`, never a raw
   source — the same class as the `canvas` ratio picker.
4. **Multi-output payloads exist**: `[Video, File(Download), Seed]`. First-file
   wins is correct for this shape, but a payload that leads with a download
   artifact would mis-scan; the parse should prefer an entry whose extension
   matches the requested kind. Noted, not yet implemented (no observed Space
   exhibits it).
5. **`seed` is typed `float` on some Spaces** — the source resolver's numeric
   return needs no coercion.



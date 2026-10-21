# Workflow Template Pack

Seven starting points on the workflow dashboard, defined as data in
`lib/workflowTemplates.ts`. Each one is a plain graph
(`nodes` / `edges` / `nodeCounters`) handed to `createSpace()`, so it resolves
through exactly the same registry and bindings as a hand-built canvas.

Validate offline:

```bash
pnpm check:workflows        # 623 structural assertions, no network
```

---

## The pack

| Template | Shape | Inputs | Models exercised |
|---|---|---|---|
| **Product Ad — Still to Motion** | product photo → 2 stills (16:9 + 9:16) → 2 clips | image | nano-banana-pro, seedream-5-lite, veo3_fast, seedance-2-fast |
| **Character Consistency — Editorial Set** | character sheet → 3 looks (3:4 / 1:1 / 9:16) → 1 clip | image | nano-banana-pro, grok-imagine-image, seedream-5-pro, kling-3.0 |
| **Campaign Kit — One Brief, Three Formats** | assistant brief → 3 formats → 1 clip | text (assistant) | assistant, gpt-image-2, seedream-5-lite, nano-banana-2, seedance-2-mini |
| **Storyboard — Scene Transition** | 2 stills → 1 clip interpolating between them | text | seedream-5-lite, veo3_fast |
| **Reference Clip Remix** | source clip + style frame → restyled clip | video + image | seedance-2-5-edit |
| **Motion Transfer** | motion clip + character frame → new performance | video + image | kling-2.6-motion-control |
| **UGC Repurposer (classic)** | avatar → 4 stills → 4 talking-head clips | image | nano-banana-pro, seedance-2 |

### Why these six

They are not feature demos; each maps to a job that recurs in production:

1. **Product Ad** — the canonical still-to-motion pipeline, plus the vertical
   cut everyone forgets until the placement is booked.
2. **Character Set** — same subject across three image models and three
   aspect ratios: the honest way to compare models without re-prompting.
3. **Campaign Kit** — text-to-campaign with a branch. The Assistant node writes
   the brief; one text output fans out to three formats, one of which animates.
4. **Scene Transition** — first frame and last frame from two different
   prompts, then interpolation. The reliable way to make a shot land on an edit
   point.
5. **Clip Remix** — video in, video out, style image as the anchor. The shape
   most brand refreshes actually take.
6. **Motion Transfer** — timing comes from footage, identity comes from a
   frame. No prompt has to describe choreography.

The classic UGC board stays because it is the high-volume batch shape, and it
is the only template with pre-loaded "done" results as demo content.

---

## Conventions

- **Generators start `idle`.** Templates wire prompts and references; they never
  claim a result they have not produced. The validator fails any new template
  whose generator is `done`/`running` (`legacy: true` is the documented
  exemption, used only by the classic board).
- **Reference inputs may be pre-loaded** from `public/placeholders/`. They are
  inputs the user replaces, not results.
- **Models resolve to their default binding** (legacy backend) unless the user
  has activated a compat provider for that model. Templates deliberately avoid
  models that exist only behind a compat binding.
- **The graph is provider-agnostic by construction.** Pointing a model at
  OpenRouter or Pollinations in Settings re-runs the same template through that
  endpoint — the nodes, edges and prompts never change. That is the point of the
  binding layer: one graph, several backends.
- **One prompt wire per generator**, matching the canvas rules: `prompt`,
  `startFrame` and `endFrame` are single-slot; `image` / `resource` accept many.
- **Node ids are prefixed** (`tpl-pa-…`, `tpl-cc-…`) so they never collide with
  user-created nodes.
- **Layout is left-to-right by stage**: references on the left, stills in the
  middle, motion on the right, prompts directly above their consumer.

---

## Adding a template

1. Build a `makeX()` function with the local helpers (`add`, `prompt`,
   `imageGen`, `videoGen`, `link`, `finish`) and export it through
   `WORKFLOW_TEMPLATES` with `id`, `name`, `tagline`, `description`, `tags`,
   `models`, `accent`, `preview`.
2. Run `pnpm check:workflows`. It verifies, per template:
   - unique ids; finite positions; no self-loops; no dangling edges
   - every model id exists in the catalog
   - every ratio is in the model's `ratios`
   - every quality is in the model's `qualityOptions`
   - every incoming handle is in the model's `handles`
   - durations are in the model's `durations`
   - single-slot handles are wired once
   - prompt edges come from text nodes; assistant edges use `textOut`
   - reference inputs carry content; generators start idle
   - `nodeCounters` equal the real per-type counts
3. Run `npx tsc --noEmit`.

The validator exists because the failure mode that matters here is a graph that
looks correct and cannot run — an edge into a handle the model never exposes, or
a ratio the provider rejects. Both are cheap to catch offline and expensive to
catch in a browser.

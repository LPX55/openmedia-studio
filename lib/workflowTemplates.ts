/**
 * Workflow template pack — the starting points shown on the workflow dashboard.
 *
 * A template is pure data: nodes + edges + nodeCounters, exactly what
 * `createSpace(name, template)` expects. Nothing here talks to a provider; the
 * graphs are resolved by the same registry/binding path as a hand-built canvas,
 * so a template that runs is a template that is wired correctly.
 *
 * Design rules for anything added here:
 *   1. Realistic shape first — a template should read like a job someone
 *      actually does (product stills, character sets, storyboards, edits), not
 *      like a feature demo.
 *   2. Every edge must point at a handle the target model really exposes
 *      (`modelConfig.ts` `handles` / `supportsImages`).  The
 *      `check:workflows` script enforces this offline.
 *   3. Generation nodes start `idle` with their prompts already wired, so the
 *      template is immediately runnable and never claims a result it has not
 *      produced. Reference inputs may be pre-loaded (local placeholders) —
 *      they are inputs the user replaces.
 *   4. Prefer models whose default binding is the legacy backend (kie) so a
 *      template works for a user who has not configured a compat provider.
 *
 * The classic UGC repurposer lives in `lib/templates.ts` and is exposed here as
 * one more entry, so the dashboard has a single ordered list.
 */
import type { Node, Edge } from "@xyflow/react";
import type { NodeData } from "./store";
import { edgeStyle } from "./edgeStyles";
import { makeUGCTemplate } from "./templates";

// ── Types ────────────────────────────────────────────────────────────────────

export interface WorkflowGraph {
  nodes: Node<NodeData>[];
  edges: Edge[];
  nodeCounters: Record<string, number>;
}

export interface WorkflowTemplate {
  /** Stable id — used by the dashboard and by persisted spaces' provenance. */
  id: string;
  name: string;
  /** One line, shown under the name on the card. */
  tagline: string;
  /** Longer description for the card's detail view / tooltip. */
  description: string;
  /** Short uppercase badges ("IMAGE → VIDEO", "BRAND KIT", …). */
  tags: string[];
  /** Model ids exercised by the graph — rendered as chips on the card. */
  models: string[];
  /** Card accent (matches the node palette). */
  accent: string;
  /** Up to four preview images, in reading order. */
  preview: string[];
  /**
   * Legacy templates ship pre-loaded "done" results as demo content (the
   * classic UGC board). New templates must start idle — see the validator.
   */
  legacy?: boolean;
  make(): WorkflowGraph;
}

// ── Small builders ───────────────────────────────────────────────────────────

const PH = (n: number) => `/placeholders/thumb-${n}.svg`;

const IMAGE_SIZE = { w: 280, h: 280 };
const VIDEO_SIZE = { w: 320, h: 220 };
const PROMPT_SIZE = { w: 300, h: 230 };
const INPUT_SIZE = { w: 260, h: 240 };

interface GraphBuilder {
  nodes: Node<NodeData>[];
  edges: Edge[];
  counts: Record<string, number>;
}

function createGraph(): GraphBuilder {
  return { nodes: [], edges: [], counts: {} };
}

function add(
  g: GraphBuilder,
  type: string,
  id: string,
  x: number,
  y: number,
  size: { w: number; h: number },
  data: NodeData,
): string {
  g.nodes.push({
    id,
    type,
    position: { x, y },
    style: { width: size.w, height: size.h },
    data,
  });
  g.counts[type] = (g.counts[type] ?? 0) + 1;
  return id;
}

function prompt(
  g: GraphBuilder,
  id: string,
  label: string,
  text: string,
  x: number,
  y: number,
  size = PROMPT_SIZE,
): string {
  return add(g, "promptNode", id, x, y, size, { label, status: "idle", prompt: text });
}

function imageGen(
  g: GraphBuilder,
  id: string,
  label: string,
  model: string,
  aspectRatio: string,
  quality: string | undefined,
  x: number,
  y: number,
): string {
  return add(g, "generateNode", id, x, y, IMAGE_SIZE, {
    label,
    status: "idle",
    model,
    aspectRatio,
    ...(quality ? { quality } : {}),
  });
}

function videoGen(
  g: GraphBuilder,
  id: string,
  label: string,
  videoModel: string,
  x: number,
  y: number,
  opts: { aspectRatio?: string; duration?: number; sound?: boolean; klingMode?: string } = {},
): string {
  return add(g, "videoGeneratorNode", id, x, y, VIDEO_SIZE, {
    label,
    status: "idle",
    videoModel,
    ...opts,
  });
}

function link(
  g: GraphBuilder,
  id: string,
  source: string,
  target: string,
  targetHandle: string,
  sourceHandle?: string,
): void {
  g.edges.push({
    id,
    source,
    target,
    targetHandle,
    ...(sourceHandle ? { sourceHandle } : {}),
    animated: false,
    style: edgeStyle(targetHandle),
  });
}

function finish(g: GraphBuilder): WorkflowGraph {
  return { nodes: g.nodes, edges: g.edges, nodeCounters: { ...g.counts } };
}

// ── 1. Product Ad — Still to Motion ─────────────────────────────────────────

const PRODUCT_STILL =
  "Studio product photograph of the item in the reference image, standing on a matte " +
  "concrete plinth turned about 35 degrees toward the camera. One large soft key light " +
  "from upper left, deep falloff into a charcoal backdrop, soft contact shadow, no second " +
  "light source. Shot on an 85 mm lens at f/5.6, focus on the front label edge, true-to-" +
  "material color. No props, no text overlays, no reflections of the room.";

const PRODUCT_VERTICAL =
  "Vertical e-commerce crop of the same product and lighting as the reference. Product " +
  "centered in the upper two thirds, clean empty space below for a caption, plinth edge " +
  "visible at the bottom of frame. Keep the label legible and facing camera. Same matte " +
  "concrete and charcoal palette, same single soft key light.";

const PRODUCT_MOTION =
  "Slow fifteen-degree orbital push around the product at plinth height, constant speed, " +
  "no zoom and no handheld drift. The plinth and product stay rigid; the label faces the " +
  "camera at the first frame. Studio lighting unchanged, faint atmospheric haze behind " +
  "the product, no cuts, no text appearing.";

const PRODUCT_MOTION_VERTICAL =
  "Vertical product clip: a slow tilt up the product from the plinth edge to the label, " +
  "then a two-second hold. Camera steady, no shake, no zoom. Lighting and backdrop match " +
  "the reference exactly. No hands, no cuts, no overlays.";

function makeProductAd(): WorkflowGraph {
  const g = createGraph();

  add(g, "imageInputNode", "tpl-pa-product", -380, 120, INPUT_SIZE, {
    label: "Product photo",
    status: "idle",
    r2Url: PH(3),
    imageNaturalRatio: "1 / 1",
  });

  prompt(g, "tpl-pa-p1", "Hero still — prompt", PRODUCT_STILL, -20, -360);
  prompt(g, "tpl-pa-p2", "Vertical still — prompt", PRODUCT_VERTICAL, 400, -360);
  prompt(g, "tpl-pa-p3", "Hero motion — prompt", PRODUCT_MOTION, 820, -360);
  prompt(g, "tpl-pa-p4", "Vertical motion — prompt", PRODUCT_MOTION_VERTICAL, 1240, -360);

  imageGen(g, "tpl-pa-still", "Hero still — 16:9", "nano-banana-pro", "16:9", "2k", -20, 0);
  imageGen(g, "tpl-pa-vert", "Vertical still — 9:16", "seedream-5-lite", "9:16", "4k", 400, 0);

  videoGen(g, "tpl-pa-motion", "Hero motion — 16:9", "veo3_fast", 820, 0, {
    aspectRatio: "16:9",
    sound: false,
  });
  videoGen(g, "tpl-pa-motion-v", "Vertical motion — 9:16", "seedance-2-fast", 1240, 0, {
    aspectRatio: "9:16",
    duration: 5,
    sound: true,
  });

  link(g, "tpl-pa-e1", "tpl-pa-product", "tpl-pa-still", "image");
  link(g, "tpl-pa-e2", "tpl-pa-product", "tpl-pa-vert", "image");
  link(g, "tpl-pa-e3", "tpl-pa-p1", "tpl-pa-still", "prompt");
  link(g, "tpl-pa-e4", "tpl-pa-p2", "tpl-pa-vert", "prompt");
  link(g, "tpl-pa-e5", "tpl-pa-still", "tpl-pa-motion", "startFrame");
  link(g, "tpl-pa-e6", "tpl-pa-p3", "tpl-pa-motion", "prompt");
  link(g, "tpl-pa-e7", "tpl-pa-vert", "tpl-pa-motion-v", "startFrame");
  link(g, "tpl-pa-e8", "tpl-pa-p4", "tpl-pa-motion-v", "prompt");

  return finish(g);
}

// ── 2. Character Consistency — Editorial Set ────────────────────────────────

const CHAR_STUDIO =
  "Editorial studio portrait of the person in the reference image. Three-quarter turn, " +
  "chin level, eyes to camera. Single beauty dish at 45 degrees with a subtle rim light, " +
  "seamless warm-grey backdrop. Wardrobe and grooming unchanged from the reference. " +
  "Skin texture retained, no retouch smoothing, no color grading beyond a neutral base.";

const CHAR_CLOSE =
  "Tight editorial close-up of the same person, cropped at the collarbone. Direct gaze, " +
  "relaxed mouth, hair exactly as in the reference. Soft window light from camera left, " +
  "gentle shadow falloff on the right side of the face. Natural skin texture, visible " +
  "pores, no beauty filter, no makeup changes.";

const CHAR_STREET =
  "Vertical street portrait of the same person at golden hour, standing against a painted " +
  "brick wall. Half-body framing, hands relaxed at the sides, slight lean into the wall. " +
  "Warm low sun from behind camera right, long soft shadows, shallow depth of field at " +
  "f/2. Keep the face and hair identical to the reference.";

const CHAR_MOTION =
  "Locked-off medium shot of the person from the reference frame. A slow, natural head " +
  "turn from three-quarter to camera, then a single blink and a small settling breath. " +
  "No camera movement, no zoom, no reframing. Lighting and wardrobe unchanged, ambient " +
  "room tone only, no music.";

function makeCharacterSet(): WorkflowGraph {
  const g = createGraph();

  add(g, "imageInputNode", "tpl-cc-ref", -380, 180, INPUT_SIZE, {
    label: "Character sheet",
    status: "idle",
    r2Url: "/placeholders/avatar.svg",
    imageNaturalRatio: "9 / 16",
  });

  prompt(g, "tpl-cc-p1", "Studio — prompt", CHAR_STUDIO, -20, -360);
  prompt(g, "tpl-cc-p2", "Close-up — prompt", CHAR_CLOSE, 400, -360);
  prompt(g, "tpl-cc-p3", "Street — prompt", CHAR_STREET, 820, -360);
  prompt(g, "tpl-cc-p4", "Motion — prompt", CHAR_MOTION, 1240, -360);

  imageGen(g, "tpl-cc-studio", "Studio — 3:4", "nano-banana-pro", "3:4", "2k", -20, 0);
  imageGen(g, "tpl-cc-close", "Close-up — 1:1", "grok-imagine-image", "1:1", undefined, 400, 0);
  imageGen(g, "tpl-cc-street", "Street — 9:16", "seedream-5-pro", "9:16", "2k", 820, 0);

  videoGen(g, "tpl-cc-motion", "Head-turn — 9:16", "kling-3.0", 1240, 0, {
    aspectRatio: "9:16",
    duration: 5,
    sound: true,
    klingMode: "pro",
  });

  link(g, "tpl-cc-e1", "tpl-cc-ref", "tpl-cc-studio", "image");
  link(g, "tpl-cc-e2", "tpl-cc-ref", "tpl-cc-close", "image");
  link(g, "tpl-cc-e3", "tpl-cc-ref", "tpl-cc-street", "image");
  link(g, "tpl-cc-e4", "tpl-cc-p1", "tpl-cc-studio", "prompt");
  link(g, "tpl-cc-e5", "tpl-cc-p2", "tpl-cc-close", "prompt");
  link(g, "tpl-cc-e6", "tpl-cc-p3", "tpl-cc-street", "prompt");
  link(g, "tpl-cc-e7", "tpl-cc-street", "tpl-cc-motion", "startFrame");
  link(g, "tpl-cc-e8", "tpl-cc-p4", "tpl-cc-motion", "prompt");

  return finish(g);
}

// ── 3. Campaign Kit — One Brief, Three Formats ──────────────────────────────

const BRIEF_LABEL = "Campaign brief";

const BRIEF_INSTRUCTIONS =
  "You are a creative director writing production-ready image prompts. " +
  "Given a product and an audience, return exactly four short paragraphs and nothing else: " +
  "1) a one-line positioning statement; 2) the hero 16:9 image prompt; " +
  "3) the square 1:1 crop prompt; 4) the vertical 9:16 story prompt. " +
  "Each prompt names the subject, the light, the lens or framing, the palette and what " +
  "must not appear. No marketing adjectives, no emoji, no headings.";

const BRIEF_OUTPUT =
  "Reusable cold-brew concentrate for people who make coffee at home but skip it on busy mornings.\n" +
  "\n" +
  "Hero 16:9: a glass bottle of cold-brew concentrate on a pale oak counter beside a filled " +
  "glass, morning window light from camera left, soft shadow across the wood, shallow depth " +
  "of field at f/2.8, palette of oak, amber and off-white. No people, no text, no coffee beans " +
  "scattered as props.\n" +
  "\n" +
  "Square 1:1: flat-lay from directly above — bottle, glass, a folded linen napkin and a " +
  "small spoon on pale oak, even north-facing daylight, no hard shadow, same amber and " +
  "off-white palette. No hands, no labels other than the bottle's own.\n" +
  "\n" +
  "Vertical 9:16: the same bottle held at chest height in a bright kitchen, subject cropped " +
  "at the shoulders, window light behind camera, clean empty upper third for a caption, " +
  "palette held to oak and amber. No text, no second product.";

function makeCampaignKit(): WorkflowGraph {
  const g = createGraph();

  // Tall enough to show the whole pre-filled brief: the node's output pane is
  // read-only, so clipping it would hide the very text the three generators use.
  add(g, "assistantNode", "tpl-ck-brief", -400, -140, { w: 340, h: 560 }, {
    label: BRIEF_LABEL,
    status: "done",
    model: "claude-sonnet-4-6",
    localPrompt:
      `${BRIEF_INSTRUCTIONS}\n\n---\n` +
      "Product: cold-brew coffee concentrate, sold direct to home drinkers.\n" +
      "Audience: people who make coffee at home but skip it on busy mornings.\n" +
      "Tone: calm, practical, no hype.",
    outputText: BRIEF_OUTPUT,
  });

  imageGen(g, "tpl-ck-hero", "Hero — 16:9", "gpt-image-2", "16:9", "2k", 40, 0);
  imageGen(g, "tpl-ck-square", "Square — 1:1", "seedream-5-lite", "1:1", "4k", 420, 0);
  imageGen(g, "tpl-ck-story", "Story — 9:16", "nano-banana-2", "9:16", "2k", 800, 0);

  prompt(g, "tpl-ck-p1", "Story motion — prompt",
    "Slow push in on the bottle from waist height to a chest-height hold, then a two-second " +
    "pause. Window light stays behind camera, no reframing after the push, no hands entering " +
    "frame, no text. Ambient kitchen room tone only.",
    1180, -360);

  videoGen(g, "tpl-ck-motion", "Story motion — 9:16", "seedance-2-mini", 1180, 0, {
    aspectRatio: "9:16",
    duration: 5,
    sound: true,
  });

  link(g, "tpl-ck-e1", "tpl-ck-brief", "tpl-ck-hero", "prompt", "textOut");
  link(g, "tpl-ck-e2", "tpl-ck-brief", "tpl-ck-square", "prompt", "textOut");
  link(g, "tpl-ck-e3", "tpl-ck-brief", "tpl-ck-story", "prompt", "textOut");
  link(g, "tpl-ck-e4", "tpl-ck-story", "tpl-ck-motion", "startFrame");
  link(g, "tpl-ck-e5", "tpl-ck-p1", "tpl-ck-motion", "prompt");

  // The assistant brief is pre-filled so the graph is legible before the first
  // run; re-running the Assistant node rewrites it from BRIEF_SYSTEM.
  return finish(g);
}

// ── 4. Storyboard — Scene Transition ────────────────────────────────────────

const SCENE_A =
  "Wide establishing shot of a small harbour at blue hour, shot from the quay. Fishing boats " +
  "moored in a row, wet stone reflecting the last light, a single streetlamp on the left " +
  "third. Overcast sky, cool blue and slate palette, 24 mm lens at f/5.6, deep focus. " +
  "No people, no text.";

const SCENE_B =
  "The same harbour from the identical camera position twenty minutes later: the sky has " +
  "darkened to indigo, the streetlamp is now the key light, the boats have shifted slightly " +
  "on their moorings, a low mist sits on the water. Same framing, same lens, no new objects " +
  "in frame.";

const TRANSITION =
  "Locked-off camera on the harbour. The light falls from blue hour into night over the clip, " +
  "the streetlamp becomes the dominant source, mist creeps in from the right, and the nearest " +
  "boat drifts a few centimetres on its line. No camera movement, no cuts, no people entering " +
  "frame, no text.";

function makeSceneTransition(): WorkflowGraph {
  const g = createGraph();

  prompt(g, "tpl-st-p1", "Scene A — prompt", SCENE_A, -60, -400);
  prompt(g, "tpl-st-p2", "Scene B — prompt", SCENE_B, 360, -400);
  prompt(g, "tpl-st-p3", "Transition — prompt", TRANSITION, 560, 380);

  imageGen(g, "tpl-st-a", "Scene A — 16:9", "seedream-5-lite", "16:9", "4k", -60, -60);
  imageGen(g, "tpl-st-b", "Scene B — 16:9", "seedream-5-lite", "16:9", "4k", 360, -60);

  videoGen(g, "tpl-st-move", "Transition — 16:9", "veo3_fast", 180, 380, {
    aspectRatio: "16:9",
    sound: false,
  });

  link(g, "tpl-st-e1", "tpl-st-p1", "tpl-st-a", "prompt");
  link(g, "tpl-st-e2", "tpl-st-p2", "tpl-st-b", "prompt");
  link(g, "tpl-st-e3", "tpl-st-a", "tpl-st-move", "startFrame");
  link(g, "tpl-st-e4", "tpl-st-b", "tpl-st-move", "endFrame");
  link(g, "tpl-st-e5", "tpl-st-p3", "tpl-st-move", "prompt");

  return finish(g);
}

// ── 5. Reference Clip Remix (video edit) ────────────────────────────────────

const REMIX_PROMPT =
  "Restyle the source clip as hand-painted 2D animation. Keep the camera motion, timing and " +
  "subject blocking identical to the source. Flatten the lighting into two cel bands, keep " +
  "the silhouette and screen position locked to the style frame, and hold the palette to " +
  "four colors. No new cuts, no added elements, no text or logos.";

function makeClipRemix(): WorkflowGraph {
  const g = createGraph();

  add(g, "videoInputNode", "tpl-rr-src", -380, -60, { w: 280, h: 300 }, {
    label: "Source clip",
    status: "idle",
    videoUrl: "/placeholders/video-2.mp4",
    videoAspectRatio: "16 / 9",
  });

  add(g, "imageInputNode", "tpl-rr-style", -380, 300, INPUT_SIZE, {
    label: "Style frame",
    status: "idle",
    r2Url: PH(4),
    imageNaturalRatio: "16 / 9",
  });

  prompt(g, "tpl-rr-p1", "Restyle — prompt", REMIX_PROMPT, 0, -400);

  videoGen(g, "tpl-rr-edit", "Restyled clip", "seedance-2-5-edit", 0, -20, {
    sound: true,
  });

  link(g, "tpl-rr-e1", "tpl-rr-p1", "tpl-rr-edit", "prompt");
  link(g, "tpl-rr-e2", "tpl-rr-src", "tpl-rr-edit", "referenceVideo", "videoRefOut");
  link(g, "tpl-rr-e3", "tpl-rr-style", "tpl-rr-edit", "resource");

  return finish(g);
}

// ── 6. Motion Transfer (motion control) ─────────────────────────────────────

const MOTION_PROMPT =
  "Transfer the body mechanics and timing from the reference clip onto the character in the " +
  "start frame. Match step length, arm swing and pause points; keep wardrobe, hair and " +
  "framing unchanged. Camera locked at chest height, no shake, no zoom. Background stays as " +
  "in the start frame. No new people, no text.";

function makeMotionTransfer(): WorkflowGraph {
  const g = createGraph();

  // The video-input node sizes itself to the clip's 9:16 frame (~500px tall at
  // this width), so the character frame sits below it rather than alongside.
  add(g, "videoInputNode", "tpl-mt-src", -380, -80, { w: 280, h: 300 }, {
    label: "Motion reference",
    status: "idle",
    videoUrl: "/placeholders/video-3.mp4",
    videoAspectRatio: "9 / 16",
  });

  add(g, "imageInputNode", "tpl-mt-character", -380, 520, INPUT_SIZE, {
    label: "Character frame",
    status: "idle",
    r2Url: "/placeholders/avatar.svg",
    imageNaturalRatio: "9 / 16",
  });

  prompt(g, "tpl-mt-p1", "Motion transfer — prompt", MOTION_PROMPT, 20, -420);

  videoGen(g, "tpl-mt-out", "Motion transfer", "kling-2.6-motion-control", 20, 0, {
    sound: false,
  });

  link(g, "tpl-mt-e1", "tpl-mt-p1", "tpl-mt-out", "prompt");
  link(g, "tpl-mt-e2", "tpl-mt-src", "tpl-mt-out", "videoRef", "videoRefOut");
  link(g, "tpl-mt-e3", "tpl-mt-character", "tpl-mt-out", "startFrame");

  return finish(g);
}

// ── Registry ─────────────────────────────────────────────────────────────────

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    id: "product-ad",
    name: "Product Ad — Still to Motion",
    tagline: "One product photo → two stills → two clips",
    description:
      "Takes a single product reference through two framings and animates both. Shows the " +
      "core i2v shape: still → startFrame → motion, with a separate vertical cut for stories.",
    tags: ["IMAGE → VIDEO", "PRODUCT", "I2V"],
    models: ["nano-banana-pro", "seedream-5-lite", "veo3_fast", "seedance-2-fast"],
    accent: "#2DD4BF",
    preview: [
      "/placeholders/templates/product-ad-1.svg",
      "/placeholders/templates/product-ad-2.svg",
      "/placeholders/templates/product-ad-3.svg",
      "/placeholders/templates/product-ad-4.svg",
    ],
    make: makeProductAd,
  },
  {
    id: "character-set",
    name: "Character Consistency — Editorial Set",
    tagline: "One character sheet → three looks → one clip",
    description:
      "Same reference attached to three image models at three aspect ratios, then the " +
      "vertical frame becomes a start frame. The model-comparison lane: identical subject, " +
      "different rendering.",
    tags: ["CHARACTER", "MULTI-MODEL", "I2V"],
    models: ["nano-banana-pro", "grok-imagine-image", "seedream-5-pro", "kling-3.0"],
    accent: "#818cf8",
    preview: [
      "/placeholders/templates/character-set-1.svg",
      "/placeholders/templates/character-set-2.svg",
      "/placeholders/templates/character-set-3.svg",
      "/placeholders/templates/character-set-4.svg",
    ],
    make: makeCharacterSet,
  },
  {
    id: "campaign-kit",
    name: "Campaign Kit — One Brief, Three Formats",
    tagline: "Assistant brief → 16:9, 1:1 and 9:16 → one clip",
    description:
      "An Assistant node writes the brief, then one text output fans out into three " +
      "formats on three image models, and the vertical one animates. The text-to-campaign " +
      "lane, with the brief pre-filled so the graph reads without a run.",
    tags: ["BRIEF → CAMPAIGN", "MULTI-FORMAT", "BRANCH"],
    models: ["assistant", "gpt-image-2", "seedream-5-lite", "nano-banana-2", "seedance-2-mini"],
    accent: "#FBBF24",
    preview: [
      "/placeholders/templates/campaign-kit-1.svg",
      "/placeholders/templates/campaign-kit-2.svg",
      "/placeholders/templates/campaign-kit-3.svg",
      "/placeholders/templates/campaign-kit-4.svg",
    ],
    make: makeCampaignKit,
  },
  {
    id: "scene-transition",
    name: "Storyboard — Scene Transition",
    tagline: "Two stills → one clip between them",
    description:
      "Two prompts produce the first and last frames of the same shot; the video generator " +
      "interpolates between them. The endFrame lane — the cleanest way to guarantee a shot " +
      "ends where the edit needs it to.",
    tags: ["STORYBOARD", "FIRST/LAST FRAME"],
    models: ["seedream-5-lite", "veo3_fast"],
    accent: "#22d3ee",
    preview: [
      "/placeholders/templates/scene-transition-1.svg",
      "/placeholders/templates/scene-transition-2.svg",
      "/placeholders/templates/scene-transition-3.svg",
      "/placeholders/templates/scene-transition-4.svg",
    ],
    make: makeSceneTransition,
  },
  {
    id: "clip-remix",
    name: "Reference Clip Remix",
    tagline: "Source clip + style frame → restyled clip",
    description:
      "A reference video and a style image go into a video model that edits rather than " +
      "generates from scratch. The video-input lane, and the shape most brand refreshes " +
      "actually take.",
    tags: ["VIDEO EDIT", "VIDEO + IMAGE REF"],
    models: ["seedance-2-5-edit"],
    accent: "#a78bfa",
    preview: [
      "/placeholders/templates/clip-remix-1.svg",
      "/placeholders/templates/clip-remix-2.svg",
      "/placeholders/templates/clip-remix-3.svg",
      "/placeholders/templates/clip-remix-4.svg",
    ],
    make: makeClipRemix,
  },
  {
    id: "motion-transfer",
    name: "Motion Transfer",
    tagline: "Motion clip + character frame → new performance",
    description:
      "A motion reference drives a character still through the motion-control model: " +
      "same body mechanics, different subject. The video-to-video lane that does not need " +
      "a prompt to describe timing.",
    tags: ["MOTION CONTROL", "VIDEO → VIDEO"],
    models: ["kling-2.6-motion-control"],
    accent: "#f472b6",
    preview: [
      "/placeholders/templates/motion-transfer-1.svg",
      "/placeholders/templates/motion-transfer-2.svg",
      "/placeholders/templates/motion-transfer-3.svg",
      "/placeholders/templates/motion-transfer-4.svg",
    ],
    make: makeMotionTransfer,
  },
  {
    id: "ugc-repurposer",
    name: "UGC Repurposer (classic)",
    tagline: "4× image → 4× video, avatar-driven",
    description:
      "The original bundled starter: one avatar reference feeds four image prompts, each " +
      "becomes the start frame of a talking-head clip. Kept as the high-volume batch shape.",
    tags: ["BATCH", "AVATAR", "4 × IMAGE → VIDEO"],
    models: ["nano-banana-pro", "seedance-2"],
    accent: "#5EEAD4",
    preview: [
      "/placeholders/templates/ugc-repurposer-1.svg",
      "/placeholders/templates/ugc-repurposer-2.svg",
      "/placeholders/templates/ugc-repurposer-3.svg",
      "/placeholders/templates/ugc-repurposer-4.svg",
    ],
    legacy: true,
    make: makeUGCTemplate,
  },
];

export function getWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.id === id);
}

/** The graph for a template id, or undefined for an unknown id. */
export function makeWorkflowTemplate(id: string): WorkflowGraph | undefined {
  return getWorkflowTemplate(id)?.make();
}

/**
 * Param presets — compat-plan §(c) (Deepwork P6b, step 3).
 *
 * A preset is the BASE layer of a compat binding's effective params:
 *
 *   preset params ← binding.paramMap ← custom-binding overrides
 *
 * Presets ship as CODE-SEEDED rows (`param_presets`, see `lib/guest/sqlite.ts`)
 * and carry PARAMS ONLY — never model bindings. v1 has no preset editor: the
 * Settings-modal picker is a dropdown + a view-only JSON preview; editing a
 * preset is a later task (compat-plan §d).
 *
 * The seeds are stored as RAW JSON so a typo in a seed is a PARSE error, not a
 * silently-wrong dialect: `parseParamPresetParams()` validates the JSON AND
 * the shape (unknown keys / unknown field sources are rejected loudly — the
 * "fail fast on typos" requirement of compat-plan §c).
 *
 * PURE MODULE: no DB, no node builtins, no route imports — the rows are seeded
 * by `lib/guest/sqlite.ts` and read by `lib/guest/db.ts`.
 */
import type { CompatFieldSource, CompatParamMap } from "./bindings";

/** The normalized sources a preset may map a body key to (bindings.ts). */
const FIELD_SOURCES: readonly CompatFieldSource[] = [
  "prompt",
  "aspectRatio",
  "tier",
  "quality",
  "resolution",
  "size",
  "seed",
  "references",
  "outputFormat",
];

/** The top-level members of a preset's params (a partial compat dialect). */
const PARAM_KEYS = ["fields", "valueMaps", "constants", "modelKey", "maxReferences"] as const;

/** A code-seeded preset row. */
export interface ParamPresetSeed {
  /** Primary key of the `param_presets` row. */
  presetId: string;
  /** Dialect family the preset belongs to ("standard" | "openrouter" | …). */
  family: string;
  /** The preset's params as raw JSON — parsed + validated at seed time. */
  paramsJson: string;
}

/**
 * The four code-seeded presets (compat-plan §c: "seed presets for the shapes
 * encountered so far — standard image, image-edit, OpenRouter dialect,
 * Pollinations sync").
 *
 * They are the BASE layer only: a binding's own `paramMap` overrides them, and
 * a custom binding's overrides override the binding.
 */
export const PARAM_PRESET_SEEDS: readonly ParamPresetSeed[] = [
  {
    // The plain OpenAI-compatible image shape: `model` + `prompt` + the
    // optional `size` / `quality` / `seed` body keys.
    presetId: "standard-image",
    family: "standard",
    paramsJson: `{
      "modelKey": "model",
      "fields": {
        "prompt": "prompt",
        "size": "size",
        "quality": "quality",
        "seed": "seed"
      }
    }`,
  },
  {
    // The image-EDIT shape: the staged reference media rides its own body key
    // (`image`) next to the prompt. The compat family stages references as an
    // ARRAY of urls — a gateway that wants a single image overrides the key
    // (and the array) at the binding level.
    presetId: "image-edit",
    family: "standard",
    paramsJson: `{
      "modelKey": "model",
      "fields": {
        "prompt": "prompt",
        "image": "references",
        "size": "size",
        "quality": "quality"
      }
    }`,
  },
  {
    // The OpenRouter image dialect (spike: .slim/binding-spike.md) — the
    // `aspect_ratio` / `resolution` / `input_references` names and the
    // UPPERCASE 1K/2K/4K resolution enum. Mirrors the code-seeded OpenRouter
    // bindings, so a user-pointed OpenRouter-style backend gets the same
    // dialect for free.
    presetId: "openrouter-dialect",
    family: "openrouter",
    paramsJson: `{
      "modelKey": "model",
      "fields": {
        "prompt": "prompt",
        "aspect_ratio": "aspectRatio",
        "resolution": "tier",
        "input_references": "references"
      },
      "valueMaps": {
        "resolution": { "1k": "1K", "2k": "2K", "4k": "4K" }
      }
    }`,
  },
  {
    // Pollinations' OpenAI-compatible SYNC leg (`/v1/images/generations`):
    // the standard body plus the two privacy switches the backend understands.
    // The size/seed keys follow the OpenAI-style leg — a backend that wants
    // `width`/`height` instead overrides them at the binding level.
    presetId: "pollinations-sync",
    family: "pollinations",
    paramsJson: `{
      "modelKey": "model",
      "fields": {
        "prompt": "prompt",
        "size": "size",
        "seed": "seed"
      },
      "constants": {
        "nologo": "true",
        "private": "true"
      }
    }`,
  },
];

/** The stored params of a preset — a partial compat dialect. */
export type ParamPresetParams = Partial<CompatParamMap> & Record<string, unknown>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Parse + validate a preset's params JSON.
 *
 * Throws with a clear message when the JSON is malformed, is not an object, or
 * carries a key the dialect does not know (a typo must fail loudly, never
 * silently produce a half-applied dialect).
 */
export function parseParamPresetParams(presetId: string, json: string): ParamPresetParams {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(
      `param preset "${presetId}": params JSON is malformed — ${(e as Error).message}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`param preset "${presetId}": params JSON must be an object`);
  }

  for (const key of Object.keys(parsed)) {
    if (!(PARAM_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `param preset "${presetId}": unknown param key "${key}" ` +
          `(known keys: ${PARAM_KEYS.join(", ")})`,
      );
    }
  }

  const fields = parsed.fields;
  if (fields !== undefined) {
    if (!isPlainObject(fields)) {
      throw new Error(`param preset "${presetId}": "fields" must be an object`);
    }
    for (const [bodyKey, source] of Object.entries(fields)) {
      if (typeof source !== "string" || !FIELD_SOURCES.includes(source as CompatFieldSource)) {
        throw new Error(
          `param preset "${presetId}": field "${bodyKey}" maps to an unknown source ` +
            `"${String(source)}" (known sources: ${FIELD_SOURCES.join(", ")})`,
        );
      }
    }
  }

  const valueMaps = parsed.valueMaps;
  if (valueMaps !== undefined) {
    if (!isPlainObject(valueMaps)) {
      throw new Error(`param preset "${presetId}": "valueMaps" must be an object`);
    }
    for (const [bodyKey, map] of Object.entries(valueMaps)) {
      if (!isPlainObject(map)) {
        throw new Error(`param preset "${presetId}": valueMap "${bodyKey}" must be an object`);
      }
      for (const [from, to] of Object.entries(map)) {
        if (typeof to !== "string") {
          throw new Error(
            `param preset "${presetId}": valueMap "${bodyKey}.${from}" must be a string`,
          );
        }
      }
    }
  }

  const constants = parsed.constants;
  if (constants !== undefined) {
    if (!isPlainObject(constants)) {
      throw new Error(`param preset "${presetId}": "constants" must be an object`);
    }
    for (const [bodyKey, value] of Object.entries(constants)) {
      if (typeof value !== "string") {
        throw new Error(`param preset "${presetId}": constant "${bodyKey}" must be a string`);
      }
    }
  }

  if (parsed.modelKey !== undefined && typeof parsed.modelKey !== "string") {
    throw new Error(`param preset "${presetId}": "modelKey" must be a string`);
  }
  if (
    parsed.maxReferences !== undefined &&
    (typeof parsed.maxReferences !== "number" || !Number.isFinite(parsed.maxReferences))
  ) {
    throw new Error(`param preset "${presetId}": "maxReferences" must be a finite number`);
  }

  return parsed as ParamPresetParams;
}

/**
 * Merge compat param layers, LOWEST precedence first:
 *
 *   preset params ← binding.paramMap ← custom-binding overrides
 *
 * The merge is deep for the record-shaped members (`fields`, `valueMaps`,
 * `constants`): a later layer overrides only the keys it actually names, so a
 * preset can supply the dialect skeleton while a binding overrides single
 * body keys. Scalars (`modelKey`, `maxReferences`) are replaced wholesale.
 */
export function mergeParamMaps(
  ...layers: Array<Record<string, unknown> | undefined | null>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!isPlainObject(layer)) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      const current = out[key];
      if (isPlainObject(value) && isPlainObject(current)) {
        out[key] = { ...current, ...value };
      } else {
        out[key] = value;
      }
    }
  }
  return out;
}

import { randomUUID, createHash } from "crypto";
import { existsSync } from "fs";
import { homedir } from "node:os";
import { join } from "path";
import { db } from "./sqlite";
import { parseParamPresetParams } from "../providers/presets";
import type { ProviderMeta } from "../jobStore";

/**
 * Guest-mode data access. SQLite-backed (see ./sqlite), but the exported API is
 * unchanged from the old JSON implementation so every caller stays the same.
 */

interface Generation {
  id: string;
  user_id: string | null;
  task_id: string;
  generation_type: string;
  status: string;
  prompt?: string;
  model?: string;
  aspect_ratio?: string;
  quality?: string;
  azure_resolution?: string;
  duration?: number;
  kling_mode?: string;
  sound?: boolean;
  reference_image_urls?: string[];
  image_url?: string;
  image_urls?: string[];
  video_url?: string;
  error_msg?: string;
  created_at: string;
  updated_at: string;
  provider_id?: string;
  provider_meta?: ProviderMeta;
}

interface Upload {
  id: string;
  user_id: string;
  r2_url: string;
  mime_type?: string | null;
  source: string;
  created_at: string;
}

interface FolderRecord {
  id: string;
  user_id: string;
  name: string;
  parent_id: string | null;
  order_index: number;
  created_at: string;
  updated_at: string;
  color?: string | null;
}

interface FolderItemRecord {
  folder_id: string;
  item_id: string;
  user_id: string;
  created_at: string;
}

const now = (): string => new Date().toISOString();
const parseArr = (v: unknown): string[] | undefined =>
  typeof v === "string" && v ? (JSON.parse(v) as string[]) : undefined;
const parseProviderMeta = (v: unknown): ProviderMeta | undefined =>
  typeof v === "string" && v ? (JSON.parse(v) as ProviderMeta) : undefined;

type GenRow = Record<string, unknown>;
function rowToGeneration(r: GenRow): Generation {
  return {
    id: r.id as string,
    user_id: (r.user_id as string) ?? null,
    task_id: r.task_id as string,
    generation_type: r.generation_type as string,
    status: r.status as string,
    prompt: (r.prompt as string) ?? undefined,
    model: (r.model as string) ?? undefined,
    aspect_ratio: (r.aspect_ratio as string) ?? undefined,
    quality: (r.quality as string) ?? undefined,
    azure_resolution: (r.azure_resolution as string) ?? undefined,
    duration: (r.duration as number) ?? undefined,
    kling_mode: (r.kling_mode as string) ?? undefined,
    sound: r.sound == null ? undefined : Boolean(r.sound),
    reference_image_urls: parseArr(r.reference_image_urls),
    image_url: (r.image_url as string) ?? undefined,
    image_urls: parseArr(r.image_urls),
    video_url: (r.video_url as string) ?? undefined,
    error_msg: (r.error_msg as string) ?? undefined,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    provider_id: (r.provider_id as string) ?? undefined,
    provider_meta: parseProviderMeta(r.provider_meta),
  };
}

export function hashBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ── Generations ────────────────────────────────────────────────────────────

export function insertGeneration(data: Omit<Generation, "id" | "created_at" | "updated_at">): void {
  const ts = now();
  db()
    .prepare(`
      INSERT INTO generations
        (id, user_id, task_id, generation_type, status, prompt, model, aspect_ratio,
         quality, azure_resolution, duration, kling_mode, sound, reference_image_urls,
         image_url, image_urls, video_url, error_msg, created_at, updated_at,
         provider_id, provider_meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO NOTHING
    `)
    .run(
      randomUUID(), data.user_id ?? null, data.task_id, data.generation_type, data.status,
      data.prompt ?? null, data.model ?? null, data.aspect_ratio ?? null, data.quality ?? null,
      data.azure_resolution ?? null, data.duration ?? null, data.kling_mode ?? null,
      data.sound ? 1 : 0,
      data.reference_image_urls ? JSON.stringify(data.reference_image_urls) : null,
      data.image_url ?? null, data.image_urls ? JSON.stringify(data.image_urls) : null,
      data.video_url ?? null, data.error_msg ?? null, ts, ts,
      data.provider_id ?? null,
      data.provider_meta ? JSON.stringify(data.provider_meta) : null,
    );
}

export function updateGeneration(
  taskId: string,
  updates: Partial<Pick<Generation, "status" | "image_url" | "image_urls" | "video_url" | "error_msg" | "provider_meta">>,
): void {
  const sets: string[] = ["updated_at = ?"];
  const vals: unknown[] = [now()];
  if ("status" in updates) { sets.push("status = ?"); vals.push(updates.status ?? null); }
  if ("image_url" in updates) { sets.push("image_url = ?"); vals.push(updates.image_url ?? null); }
  if ("image_urls" in updates) { sets.push("image_urls = ?"); vals.push(updates.image_urls ? JSON.stringify(updates.image_urls) : null); }
  if ("video_url" in updates) { sets.push("video_url = ?"); vals.push(updates.video_url ?? null); }
  if ("error_msg" in updates) { sets.push("error_msg = ?"); vals.push(updates.error_msg ?? null); }
  if ("provider_meta" in updates) { sets.push("provider_meta = ?"); vals.push(updates.provider_meta ? JSON.stringify(updates.provider_meta) : null); }
  vals.push(taskId);
  db().prepare(`UPDATE generations SET ${sets.join(", ")} WHERE task_id = ?`).run(...(vals as never[]));
}

export function recoverJob(
  taskId: string,
): Pick<
  Generation,
  "status" | "generation_type" | "video_url" | "image_url" | "image_urls" | "error_msg" | "provider_id" | "provider_meta"
> | null {
  const r = db().prepare("SELECT * FROM generations WHERE task_id = ?").get(taskId) as GenRow | undefined;
  return r ? rowToGeneration(r) : null;
}

export function getGenerations(userId: string, type: "image" | "video"): Generation[] {
  const urlCol = type === "video" ? "video_url" : "image_url";
  const rows = db()
    .prepare(`
      SELECT * FROM generations
      WHERE user_id = ? AND generation_type = ? AND status = 'done'
        AND ${urlCol} IS NOT NULL AND ${urlCol} != ''
      ORDER BY created_at DESC
      LIMIT 5000
    `)
    .all(userId, type) as GenRow[];
  return rows.map(rowToGeneration);
}

export function deleteGeneration(id: string, userId: string): void {
  db().prepare("DELETE FROM generations WHERE id = ? AND user_id = ?").run(id, userId);
}

// ── Uploads ────────────────────────────────────────────────────────────────

export function insertUpload(data: Omit<Upload, "id" | "created_at">): void {
  db()
    .prepare("INSERT INTO uploads (id, user_id, r2_url, mime_type, source, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), data.user_id, data.r2_url, data.mime_type ?? null, data.source, now());
}

export function getUploads(userId: string, mimeTypePrefix: string): Upload[] {
  const rows = db()
    .prepare(`
      SELECT * FROM uploads
      WHERE user_id = ? AND COALESCE(mime_type, '') LIKE ? || '%'
      ORDER BY created_at DESC LIMIT 5000
    `)
    .all(userId, mimeTypePrefix) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    user_id: r.user_id as string,
    r2_url: r.r2_url as string,
    mime_type: (r.mime_type as string) ?? null,
    source: r.source as string,
    created_at: r.created_at as string,
  }));
}

export function deleteUpload(id: string, userId: string): void {
  db().prepare("DELETE FROM uploads WHERE id = ? AND user_id = ?").run(id, userId);
}

// ── Asset Cache ────────────────────────────────────────────────────────────

export function lookupAssetHash(hash: string): string | null {
  const r = db().prepare("SELECT cdn_url FROM asset_cache WHERE hash = ?").get(hash) as
    | { cdn_url: string }
    | undefined;
  if (r) console.log("[guest/asset-cache] HIT:", hash.slice(0, 8));
  return r?.cdn_url ?? null;
}

export function storeAssetHash(hash: string, cdnUrl: string, mimeType: string, byteSize: number): void {
  db()
    .prepare(`
      INSERT INTO asset_cache (hash, cdn_url, mime_type, byte_size) VALUES (?, ?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET cdn_url = excluded.cdn_url,
        mime_type = excluded.mime_type, byte_size = excluded.byte_size
    `)
    .run(hash, cdnUrl, mimeType, byteSize);
}

// ── Settings ───────────────────────────────────────────────────────────────

// ── Provider configs (Phase 3, design.md §3.1-§3.2) ────────────────────────

export type ProviderKeySource = "db" | "env" | "cli" | "none";

export interface ProviderConfig {
  providerId: string;
  apiKey: string | null;
  baseUrl: string | null;
  extra: Record<string, unknown>;
}

/** Stored config + resolved key/base-url + where the key came from (never the raw env list). */
export interface ProviderRuntimeConfig extends ProviderConfig {
  keySource: ProviderKeySource;
}

interface ProviderConfigRow {
  provider_id: string;
  api_key: string | null;
  base_url: string | null;
  extra_json: string | null;
  updated_at: string | null;
}

function rowToProviderConfig(r: ProviderConfigRow): ProviderConfig {
  let extra: Record<string, unknown> = {};
  if (r.extra_json) {
    try {
      const parsed = JSON.parse(r.extra_json) as unknown;
      if (parsed && typeof parsed === "object") extra = parsed as Record<string, unknown>;
    } catch { /* malformed extra_json — treat as empty */ }
  }
  return {
    providerId: r.provider_id,
    apiKey: r.api_key ?? null,
    baseUrl: r.base_url ?? null,
    extra,
  };
}

/** Raw stored row for `providerId`, or null when never configured. */
export function getProviderConfig(providerId: string): ProviderConfig | null {
  const r = db()
    .prepare("SELECT * FROM provider_configs WHERE provider_id = ?")
    .get(providerId) as unknown as ProviderConfigRow | undefined;
  return r ? rowToProviderConfig(r) : null;
}

// The historical `.env.example` placeholder must never count as a real key.
const PLACEHOLDER_API_KEY = "your_kie_api_key_here";
const realKey = (v: string | null | undefined): string | null =>
  v && v !== PLACEHOLDER_API_KEY ? v : null;

/** Env fallbacks per provider — `kie` unifies KIE_API_KEY ?? KIE_API_TOKEN (§3.2). */
function envFallbackKey(providerId: string): string | null {
  switch (providerId) {
    case "kie":          return realKey(process.env.KIE_API_KEY) ?? realKey(process.env.KIE_API_TOKEN);
    case "azure":        return realKey(process.env.AZURE_API_KEY);
    case "replicate":    return realKey(process.env.REPLICATE_API_TOKEN);
    case "fal":          return realKey(process.env.FAL_KEY);
    case "openai-compat":return realKey(process.env.OPENAI_API_KEY);
    // The chat BYOK credential (Assistant settings) — an OpenAI-compatible
    // key the user brought for the assistant. It is stored in
    // `provider_configs` like every other credential; the env var is only
    // the fallback when nothing was saved in Settings.
    case "chat":         return realKey(process.env.CHAT_API_KEY);
    // OpenRouter rides the openai-compat family but keeps its OWN key — the
    // family never shares one key across backends (its binding's `keyEnv`).
    // Listed here so the readiness report and the adapter agree on the key.
    case "openrouter":   return realKey(process.env.OPENROUTER_API_KEY);
    // Pollinations rides the openai-compat family with its OWN key (its
    // binding's `keyEnv`). Listed here so the readiness report and the
    // adapter agree on the key.
    case "pollinations": return realKey(process.env.POLLINATIONS_API_KEY);
    default:             return null;
  }
}

function codexAuthPath(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
}

/**
 * Resolve a provider's runtime config: stored `provider_configs` row first,
 * then env fallbacks (rejecting the `your_kie_api_key_here` placeholder).
 * `codex` has no per-user key — it reports `keySource: "cli"` iff the shared
 * `~/.codex/auth.json` session exists (as in app/api/settings/codex-status).
 */
export function getProviderRuntimeConfig(providerId: string): ProviderRuntimeConfig {
  const cfg = getProviderConfig(providerId) ?? {
    providerId,
    apiKey: null,
    baseUrl: null,
    extra: {},
  };

  if (providerId === "codex") {
    return { ...cfg, keySource: existsSync(codexAuthPath()) ? "cli" : "none" };
  }

  const dbKey = realKey(cfg.apiKey);
  const envKey = dbKey ? null : envFallbackKey(providerId);
  const apiKey = dbKey ?? envKey;
  const keySource: ProviderKeySource = dbKey ? "db" : envKey ? "env" : "none";

  let baseUrl = cfg.baseUrl;
  if (!baseUrl && providerId === "azure") baseUrl = process.env.AZURE_BASE_URL || null;
  // The chat BYOK credential may point at any OpenAI-compatible endpoint.
  if (!baseUrl && providerId === "chat") baseUrl = process.env.CHAT_BASE_URL || null;

  return { ...cfg, apiKey, baseUrl, keySource };
}

export function setProviderApiKey(providerId: string, apiKey: string): void {
  db()
    .prepare(`
      INSERT INTO provider_configs (provider_id, api_key, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET api_key = excluded.api_key, updated_at = excluded.updated_at
    `)
    .run(providerId, apiKey, now());
}

/** Clears the stored DB key (env fallbacks still apply). Used by DELETE routes. */
export function clearProviderApiKey(providerId: string): void {
  db()
    .prepare(`
      INSERT INTO provider_configs (provider_id, api_key, updated_at) VALUES (?, NULL, ?)
      ON CONFLICT(provider_id) DO UPDATE SET api_key = NULL, updated_at = excluded.updated_at
    `)
    .run(providerId, now());
}

export function setProviderBaseUrl(providerId: string, baseUrl: string | null): void {
  db()
    .prepare(`
      INSERT INTO provider_configs (provider_id, base_url, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET base_url = excluded.base_url, updated_at = excluded.updated_at
    `)
    .run(providerId, baseUrl, now());
}

/** Merges `deployments` (modelId → deployment name) into `extra_json`. */
export function setProviderDeployments(providerId: string, deployments: Record<string, string>): void {
  const cfg = getProviderConfig(providerId);
  const extra = { ...(cfg?.extra ?? {}) };
  extra.deployments = { ...((extra.deployments as Record<string, string> | undefined) ?? {}), ...deployments };
  db()
    .prepare(`
      INSERT INTO provider_configs (provider_id, extra_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET extra_json = excluded.extra_json, updated_at = excluded.updated_at
    `)
    .run(providerId, JSON.stringify(extra), now());
}

/**
 * Stores (or clears) the provider-level PARAM PRESET id (compat-plan §c) in
 * `extra_json.presetId`.
 *
 * The provider-level preset is the DEFAULT for the provider's bindings; a
 * custom binding may override it with its own `"preset"` key.
 */
export function setProviderPresetId(providerId: string, presetId: string | null): void {
  const cfg = getProviderConfig(providerId);
  const extra = { ...(cfg?.extra ?? {}) };
  if (presetId) extra.presetId = presetId;
  else delete extra.presetId;
  db()
    .prepare(`
      INSERT INTO provider_configs (provider_id, extra_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET extra_json = excluded.extra_json, updated_at = excluded.updated_at
    `)
    .run(providerId, JSON.stringify(extra), now());
}

// ── Param presets (compat-plan §c) ───────────────────────────────────────────

/** One stored param preset (the base layer of a compat binding's params). */
export interface ParamPreset {
  presetId: string;
  family: string;
  /** The preset's params (parsed + validated). */
  params: Record<string, unknown>;
  updatedAt: string | null;
}

interface ParamPresetRow {
  preset_id: string;
  family: string | null;
  params_json: string;
  updated_at: string | null;
}

function rowToParamPreset(r: ParamPresetRow): ParamPreset {
  return {
    presetId: r.preset_id,
    family: r.family ?? "standard",
    // A malformed stored row throws with a clear message (never a silent
    // empty dialect).
    params: parseParamPresetParams(r.preset_id, r.params_json) as Record<string, unknown>,
    updatedAt: r.updated_at,
  };
}

/** All stored presets (id + family + params) — the picker's data source. */
export function getParamPresets(): ParamPreset[] {
  const rows = db()
    .prepare("SELECT preset_id, family, params_json, updated_at FROM param_presets ORDER BY preset_id")
    .all() as unknown as ParamPresetRow[];
  return rows.map(rowToParamPreset);
}

/** One stored preset, or `null` when the id is unknown. */
export function getParamPreset(presetId: string): ParamPreset | null {
  const r = db()
    .prepare("SELECT preset_id, family, params_json, updated_at FROM param_presets WHERE preset_id = ?")
    .get(presetId) as unknown as ParamPresetRow | undefined;
  return r ? rowToParamPreset(r) : null;
}

// ── Model bindings (C6: single model_id×provider_id table) ─────────────────

interface ModelBindingRow {
  model_id: string;
  provider_id: string;
  binding_json: string | null;
  is_active: number;
  is_custom: number;
  updated_at: string | null;
}

export interface CustomModelBinding {
  modelId: string;
  providerId: string;
  binding: Record<string, unknown>;
}

/** Active provider per model (`is_active = 1`); absence means the C1 "kie" default. */
export function getModelPrefs(): Record<string, string> {
  const rows = db()
    .prepare("SELECT model_id, provider_id FROM model_bindings WHERE is_active = 1")
    .all() as Array<{ model_id: string; provider_id: string }>;
  return Object.fromEntries(rows.map((r) => [r.model_id, r.provider_id]));
}

export function getCustomModelBindings(): CustomModelBinding[] {
  const rows = db()
    .prepare("SELECT * FROM model_bindings WHERE is_custom = 1")
    .all() as unknown as ModelBindingRow[];
  const out: CustomModelBinding[] = [];
  for (const r of rows) {
    let binding: Record<string, unknown> = {};
    if (r.binding_json) {
      try {
        const parsed = JSON.parse(r.binding_json) as unknown;
        if (parsed && typeof parsed === "object") binding = parsed as Record<string, unknown>;
      } catch { /* malformed — keep empty binding */ }
    }
    out.push({ modelId: r.model_id, providerId: r.provider_id, binding });
  }
  return out;
}

/** Per-model union of providers with a stored row (custom + prefs). */
export function getModelBindingsByModel(): Record<string, string[]> {
  const rows = db()
    .prepare("SELECT model_id, provider_id FROM model_bindings")
    .all() as Array<{ model_id: string; provider_id: string }>;
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.model_id] ??= []).push(r.provider_id);
  return out;
}

/** P4b: shape-compatible with `ModelBindingRowLike` (lib/providers/registry.ts). */
export interface ModelBindingRowData {
  modelId: string;
  providerId: string;
  /** Parsed `binding_json` — null when the row is a pure active-provider preference. */
  binding: Record<string, unknown> | null;
  isActive: boolean;
  isCustom: boolean;
}

/**
 * All `model_bindings` rows for one model — passed to
 * `registry.resolveForModel(modelId, explicitProviderId?, rows)` by the
 * generation controllers (the registry itself performs no queries).
 */
export function getModelBindingRows(modelId: string): ModelBindingRowData[] {
  const rows = db()
    .prepare("SELECT * FROM model_bindings WHERE model_id = ?")
    .all(modelId) as unknown as ModelBindingRow[];
  return rows.map((r) => {
    let binding: Record<string, unknown> | null = null;
    if (r.binding_json) {
      try {
        const parsed = JSON.parse(r.binding_json) as unknown;
        if (parsed && typeof parsed === "object") binding = parsed as Record<string, unknown>;
      } catch { /* malformed — treat as no override */ }
    }
    return {
      modelId: r.model_id,
      providerId: r.provider_id,
      binding,
      isActive: r.is_active === 1,
      isCustom: r.is_custom === 1,
    };
  });
}

/** Transactionally clears sibling active flags, then marks (modelId, providerId) active. */
export function setModelActiveProvider(modelId: string, providerId: string): void {
  const d = db();
  const ts = now();
  d.exec("BEGIN");
  try {
    d.prepare("UPDATE model_bindings SET is_active = 0, updated_at = ? WHERE model_id = ?").run(ts, modelId);
    d.prepare(`
      INSERT INTO model_bindings (model_id, provider_id, binding_json, is_active, is_custom, updated_at)
      VALUES (?, ?, NULL, 1, 0, ?)
      ON CONFLICT(model_id, provider_id) DO UPDATE SET is_active = 1, updated_at = excluded.updated_at
    `).run(modelId, providerId, ts);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

/** Upserts a user-defined binding (custom endpoint) for an existing model. */
export function upsertCustomModelBinding(modelId: string, providerId: string, binding: Record<string, unknown>): void {
  db()
    .prepare(`
      INSERT INTO model_bindings (model_id, provider_id, binding_json, is_active, is_custom, updated_at)
      VALUES (?, ?, ?, 0, 1, ?)
      ON CONFLICT(model_id, provider_id)
        DO UPDATE SET binding_json = excluded.binding_json, is_custom = 1, updated_at = excluded.updated_at
    `)
    .run(modelId, providerId, JSON.stringify(binding), now());
}

/** Removes all model_bindings rows for a provider (DELETE /api/settings/providers). */
export function deleteProviderModelBindings(providerId: string): void {
  db().prepare("DELETE FROM model_bindings WHERE provider_id = ?").run(providerId);
}

// ── Legacy key wrappers (kept for /api/assistant + lib/getKieToken.ts) ──────
// Phase 3: these now delegate to `provider_configs` so the legacy `settings`
// rows are never re-created after the one-shot C7a migration (DELETE stays
// deleted across restarts).

export function getKieApiToken(): string | null {
  return getProviderRuntimeConfig("kie").apiKey;
}

export function setKieApiToken(token: string): void {
  setProviderApiKey("kie", token);
}

export function deleteKieApiToken(): void {
  clearProviderApiKey("kie");
}

export function getAzureApiKey(): string | null {
  return getProviderRuntimeConfig("azure").apiKey;
}

/**
 * The BYOK chat credential (Settings → Assistant) — the user's own key for
 * assistant/chat requests. Stored in `provider_configs` under the `chat`
 * provider id; `CHAT_API_KEY` is the env fallback.
 */
export function getChatApiKey(): string | null {
  return getProviderRuntimeConfig("chat").apiKey;
}

/**
 * The full BYOK chat credential: the key plus the optional base URL of the
 * OpenAI-compatible endpoint it belongs to (stored in `provider_configs.base_url`,
 * `CHAT_BASE_URL` as the env fallback).
 */
export function getChatCredential(): { apiKey: string | null; baseUrl: string | null } {
  const cfg = getProviderRuntimeConfig("chat");
  return { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl ?? null };
}

export function setAzureApiKey(key: string): void {
  setProviderApiKey("azure", key);
}

export function deleteAzureApiKey(): void {
  clearProviderApiKey("azure");
}

// ── Folders ────────────────────────────────────────────────────────────────

function rowToFolder(r: Record<string, unknown>): FolderRecord {
  return {
    id: r.id as string,
    user_id: r.user_id as string,
    name: r.name as string,
    parent_id: (r.parent_id as string) ?? null,
    order_index: (r.order_index as number) ?? 0,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    color: (r.color as string) ?? null,
  };
}

export function getFolders(userId: string): FolderRecord[] {
  const rows = db()
    .prepare("SELECT * FROM folders WHERE user_id = ? ORDER BY order_index")
    .all(userId) as Record<string, unknown>[];
  return rows.map(rowToFolder);
}

export function insertFolder(data: Omit<FolderRecord, "created_at" | "updated_at">): FolderRecord {
  const ts = now();
  db()
    .prepare(`
      INSERT INTO folders (id, user_id, name, parent_id, order_index, created_at, updated_at, color)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(data.id, data.user_id, data.name, data.parent_id ?? null, data.order_index ?? 0, ts, ts, data.color ?? null);
  return { ...data, parent_id: data.parent_id ?? null, created_at: ts, updated_at: ts };
}

export function updateFolder(
  id: string,
  userId: string,
  updates: Partial<Pick<FolderRecord, "name" | "parent_id" | "order_index" | "color">>,
): void {
  const sets: string[] = ["updated_at = ?"];
  const vals: unknown[] = [now()];
  if ("name" in updates) { sets.push("name = ?"); vals.push(updates.name); }
  if ("parent_id" in updates) { sets.push("parent_id = ?"); vals.push(updates.parent_id ?? null); }
  if ("order_index" in updates) { sets.push("order_index = ?"); vals.push(updates.order_index); }
  if ("color" in updates) { sets.push("color = ?"); vals.push(updates.color ?? null); }
  vals.push(id, userId);
  db().prepare(`UPDATE folders SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).run(...(vals as never[]));
}

export function deleteFolder(id: string, userId: string): void {
  const d = db();
  d.exec("BEGIN");
  d.prepare("DELETE FROM folders WHERE id = ? AND user_id = ?").run(id, userId);
  d.prepare("DELETE FROM folder_items WHERE folder_id = ?").run(id);
  d.exec("COMMIT");
}

// ── Folder Items ───────────────────────────────────────────────────────────

export function getFolderItems(userId: string): FolderItemRecord[] {
  const rows = db()
    .prepare("SELECT * FROM folder_items WHERE user_id = ?")
    .all(userId) as Record<string, unknown>[];
  return rows.map((r) => ({
    folder_id: r.folder_id as string,
    item_id: r.item_id as string,
    user_id: r.user_id as string,
    created_at: r.created_at as string,
  }));
}

export function insertFolderItems(folderId: string, itemIds: string[], userId: string): void {
  const stmt = db().prepare(
    "INSERT INTO folder_items (folder_id, item_id, user_id, created_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(folder_id, item_id) DO NOTHING",
  );
  const ts = now();
  for (const itemId of itemIds) stmt.run(folderId, itemId, userId, ts);
}

export function deleteFolderItems(folderId: string, itemIds: string[], userId: string): void {
  if (itemIds.length === 0) return;
  const placeholders = itemIds.map(() => "?").join(", ");
  db()
    .prepare(`DELETE FROM folder_items WHERE folder_id = ? AND user_id = ? AND item_id IN (${placeholders})`)
    .run(folderId, userId, ...itemIds);
}

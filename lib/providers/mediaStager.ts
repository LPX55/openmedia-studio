/**
 * Media staging — design.md §1.3 (Phase 4, P4a).
 *
 * SERVER-ONLY module (node:fs / node:path / node:crypto + MEDIA_DIR): never
 * import it from client components — the client never sees staging; it posts
 * raw `/generated/…` or `http(s)://` references to the API (hedge (d)).
 * Generalises the file-reading / MIME logic of `lib/kieUpload.ts` and its
 * upload-dedupe cache into the per-strategy contract below.
 *
 * Pinned rules (O2 finding 1i):
 *  - Resolution order per media item:
 *      binding.mediaStagingByOperation[op] → binding.mediaStaging → provider.mediaStaging
 *    (build the chain with `createStagingResolver`, whose strategy half comes
 *    from `resolveMediaStagingStrategy` in types.ts).
 *  - Already-remote `http(s)://` URLs pass through UNCHANGED under every
 *    strategy — no re-upload, no data-url conversion, no buffer read. Staging
 *    applies only to `/generated/…` local paths and `data:` URIs; anything else
 *    also passes through untouched (defensive).
 *  - EXCEPTION (o6 bullet 5): loopback/private hosts are NOT remote for our
 *    purposes — upstream providers can't fetch them — so they re-host through
 *    the strategy (kieUpload.ts parity: localhost/127.0.0.1 was never treated
 *    as reachable).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { MEDIA_DIR } from "../guest/paths";
import type { ModelProviderBinding } from "./bindings";
import type {
  GenerationProvider,
  MediaKind,
  MediaStagingOperation,
  MediaStagingStrategy,
  ProviderRuntimeConfig,
  StagedMedia,
} from "./types";
import { resolveMediaStagingStrategy } from "./types";

/** Raw, unstaged input media — the route/request shape (strings only). */
export interface RawMediaInput {
  references?: string[];
  startFrame?: string;
  endFrame?: string;
  videoRef?: string;
  referenceVideos?: string[];
  audioRefs?: string[];
  resources?: Array<{ url: string; tag?: string }>;
}

/** Output aligned with `GenerateInput.media` (types.ts). */
export interface StagedMediaGroup {
  references?: StagedMedia[];
  startFrame?: StagedMedia;
  endFrame?: StagedMedia;
  videoRef?: StagedMedia;
  referenceVideos?: StagedMedia[];
  audioRefs?: StagedMedia[];
  resources?: Array<{ media: StagedMedia; tag?: string }>;
}

/**
 * What one staging decision yields: the resolved strategy plus the provider
 * hook needed to realize `"remote-url"` (`GenerationProvider.uploadMedia`).
 */
export interface StagingPlan {
  strategy: MediaStagingStrategy;
  uploadMedia?: GenerationProvider["uploadMedia"];
}

/** Strategy-chain resolver handed to `stageInputMedia` — called once per input item. */
export type StagingChainResolver = (kind: MediaKind) => StagingPlan;

/**
 * Composes the documented resolution order with the provider's upload hook:
 * `binding.mediaStagingByOperation[operation] → binding.mediaStaging → provider.mediaStaging`.
 *
 * The BINDING is handed to the upload hook as its 4th argument: an
 * openai-compat backend uploads to the media store its binding names (the
 * endpoint is part of the dialect, not of the adapter).
 */
export function createStagingResolver(
  operation: MediaStagingOperation,
  binding: ModelProviderBinding | undefined,
  provider: Pick<GenerationProvider, "mediaStaging" | "uploadMedia">,
): StagingChainResolver {
  const upload = provider.uploadMedia;
  return () => ({
    strategy: resolveMediaStagingStrategy(operation, binding, provider.mediaStaging),
    uploadMedia: upload
      ? (raw, mimeType, cfg) => upload.call(provider, raw, mimeType, cfg, binding)
      : undefined,
  });
}

// ── File/MIME helpers (generalised from lib/kieUpload.ts) ───────────────────

const REMOTE_RE = /^https?:\/\//i;

/**
 * Loopback / private hosts (o6 bullet 5): reachable from THIS server, never
 * from an upstream provider. The pinned "remote URLs pass through" rule must
 * exclude them — HEAD's `lib/kieUpload.ts` treated localhost/127.0.0.1/0.0.0.0
 * as *not* reachable and re-hosted them, and an absolute local URL forwarded
 * verbatim to kie.ai would be unfetchable.
 */
const PRIVATE_HOST_RE =
  /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|::1|\[::1\]|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})$/i;

function isPrivateHostUrl(raw: string): boolean {
  if (!REMOTE_RE.test(raw)) return false;
  try {
    return PRIVATE_HOST_RE.test(new URL(raw).hostname);
  } catch {
    return false;
  }
}

/**
 * Fetch a loopback/private URL server-side (the server can reach what the
 * upstream cannot) — used to realize private-host refs under the
 * data-url / multipart-buffer strategies.
 */
async function fetchPrivateMedia(raw: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const res = await fetch(raw);
  if (!res.ok) throw new Error(`stageInputMedia: private-host fetch failed (${res.status}): ${raw}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get("content-type")?.split(";")[0]?.trim() || DEFAULT_MIME_BY_KIND.image;
  return { buffer, mimeType };
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
};

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
};

const DEFAULT_MIME_BY_KIND: Record<MediaKind, string> = {
  image: "image/png",
  video: "video/mp4",
  audio: "audio/mpeg",
};

interface DataUri {
  mimeType: string;
  base64: boolean;
  payload: string;
}

function parseDataUri(uri: string): DataUri | null {
  const m = /^data:([^;,]+)?((?:;[^;,]+)*),([\s\S]*)$/.exec(uri);
  if (!m) return null;
  return {
    mimeType: m[1] || DEFAULT_MIME_BY_KIND.image,
    base64: /;base64/i.test(m[2] ?? ""),
    payload: m[3] ?? "",
  };
}

/** MIME for a `/generated/…` path (extension) or `data:` URI; kind-default otherwise. */
function mimeOf(raw: string, kind: MediaKind): string {
  if (raw.startsWith("data:")) return parseDataUri(raw)?.mimeType ?? DEFAULT_MIME_BY_KIND[kind];
  const ext = basename(raw.split("?")[0]).split(".").pop()?.toLowerCase();
  return (ext && MIME_BY_EXT[ext]) || DEFAULT_MIME_BY_KIND[kind];
}

/** Resolve a `/generated/…` URL to an absolute path under MEDIA_DIR. */
function toMediaDirPath(raw: string): string {
  const rel = raw.replace(/^\/generated\//, "").replace(/^\/+/, "");
  return join(MEDIA_DIR, rel);
}

/** Read a `/generated/…` path into a base64 `data:` URI (kieUpload.ts toDataUrl parity). */
async function toDataUrl(raw: string, kind: MediaKind): Promise<string> {
  const buf = await readFile(toMediaDirPath(raw));
  return `data:${mimeOf(raw, kind)};base64,${buf.toString("base64")}`;
}

/** Read local input into `{ buffer, mimeType, filename }` for multipart/form-data. */
async function toBufferParts(
  raw: string,
  kind: MediaKind,
): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
  if (raw.startsWith("data:")) {
    const parsed = parseDataUri(raw);
    if (!parsed) throw new Error(`stageInputMedia: malformed data: URI (${kind})`);
    const buffer = parsed.base64
      ? Buffer.from(parsed.payload, "base64")
      : Buffer.from(decodeURIComponent(parsed.payload), "utf8");
    const ext = EXT_BY_MIME[parsed.mimeType] ?? "bin";
    return { buffer, mimeType: parsed.mimeType, filename: `file.${ext}` };
  }
  const buffer = await readFile(toMediaDirPath(raw));
  return { buffer, mimeType: mimeOf(raw, kind), filename: basename(raw.split("?")[0]) || `file.${extname(raw)}` };
}

/** Materialise a `data:` URI as a content-addressed file under MEDIA_DIR (for "local-file"). */
async function materializeDataUri(raw: string, kind: MediaKind): Promise<string> {
  const parsed = parseDataUri(raw);
  if (!parsed) throw new Error(`stageInputMedia: malformed data: URI (${kind})`);
  const buffer = parsed.base64
    ? Buffer.from(parsed.payload, "base64")
    : Buffer.from(decodeURIComponent(parsed.payload), "utf8");
  const hash = createHash("sha256").update(buffer).digest("hex");
  const ext = EXT_BY_MIME[parsed.mimeType] ?? "bin";
  const dir = join(MEDIA_DIR, ".staging");
  const filePath = join(dir, `${hash}.${ext}`);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, buffer); // same content ⇒ same path; rewrite is benign
  return filePath;
}

// Upload-dedupe cache (kieUpload.ts parity): same input uploads once per process.
const uploadCache = new Map<string, Promise<string>>();

function cachedUpload(
  raw: string,
  mimeType: string,
  uploadMedia: NonNullable<GenerationProvider["uploadMedia"]>,
  cfg: ProviderRuntimeConfig,
): Promise<string> {
  let pending = uploadCache.get(raw);
  if (!pending) {
    pending = uploadMedia(raw, mimeType, cfg);
    uploadCache.set(raw, pending);
    void pending.catch(() => uploadCache.delete(raw)); // don't cache failures
  }
  return pending;
}

// ── Core ────────────────────────────────────────────────────────────────────

async function stageOne(
  raw: string,
  kind: MediaKind,
  plan: StagingPlan,
  cfg: ProviderRuntimeConfig,
): Promise<StagedMedia> {
  const strategy = plan.strategy;
  const base = { originalUrl: raw, kind, strategy };

  // Pinned already-remote passthrough: every strategy leaves public http(s)://
  // alone. Loopback/private hosts are EXCLUDED (o6 bullet 5) — they fall into
  // the strategy below so they get re-hosted / fetched instead of handed to an
  // upstream that can't reach them.
  if (REMOTE_RE.test(raw) && !isPrivateHostUrl(raw)) return { ...base, url: raw };

  const isData = raw.startsWith("data:");
  const isLocal = isData || raw.startsWith("/generated/");
  const isPrivateRemote = REMOTE_RE.test(raw); // only private-host remotes reach here
  // Not a stageable form — pass through unchanged (staging targets only
  // /generated/… and data: per design §1.3).
  if (!isLocal && !isPrivateRemote) return { ...base, url: raw };

  switch (strategy) {
    case "data-url": {
      if (isPrivateRemote) {
        const { buffer, mimeType } = await fetchPrivateMedia(raw);
        return { ...base, url: `data:${mimeType};base64,${buffer.toString("base64")}`, mimeType };
      }
      const mimeType = mimeOf(raw, kind);
      const url = isData ? raw : await toDataUrl(raw, kind);
      return { ...base, url, mimeType };
    }
    case "multipart-buffer": {
      if (isPrivateRemote) {
        const { buffer, mimeType } = await fetchPrivateMedia(raw);
        const ext = EXT_BY_MIME[mimeType] ?? "bin";
        return { ...base, buffer, mimeType, filename: `file.${ext}` };
      }
      const { buffer, mimeType, filename } = await toBufferParts(raw, kind);
      return { ...base, buffer, mimeType, filename };
    }
    case "local-file": {
      if (isPrivateRemote) {
        // Nothing on disk — keep the URL; the adapter fetches it server-side
        // (stagedBytes → fetchBuffer), which reaches loopback just fine.
        return { ...base, url: raw };
      }
      const filePath = isData ? await materializeDataUri(raw, kind) : toMediaDirPath(raw);
      return {
        ...base,
        filePath,
        mimeType: mimeOf(raw, kind),
        filename: basename(filePath) || undefined,
      };
    }
    case "remote-url": {
      if (!plan.uploadMedia) {
        throw new Error(
          `stageInputMedia: staging resolved to "remote-url" for local media but the provider ` +
            `does not implement uploadMedia() (${raw})`,
        );
      }
      const mimeType = mimeOf(raw, kind);
      const url = await cachedUpload(raw, mimeType, plan.uploadMedia, cfg);
      return { ...base, url, mimeType };
    }
  }
}

/**
 * Stage every raw input for one generation: already-remote `http(s)://` URLs
 * pass through unchanged; `/generated/…` and `data:` inputs are converted per
 * the strategy returned by `resolvePlan` (see module doc for the chain order).
 * Throws on unreadable files or a missing `uploadMedia` hook — a silently
 * dropped reference is worse than a surfaced error (kieUpload.ts contract).
 *
 * @param rawMedia     raw string inputs from the request/route
 * @param resolvePlan  strategy-chain resolver — build with `createStagingResolver`
 * @param cfg          provider runtime config, forwarded to `uploadMedia()`
 */
export async function stageInputMedia(
  rawMedia: RawMediaInput,
  resolvePlan: StagingChainResolver,
  cfg: ProviderRuntimeConfig,
): Promise<StagedMediaGroup> {
  const one = (raw: string | undefined, kind: MediaKind): Promise<StagedMedia | undefined> =>
    raw ? stageOne(raw, kind, resolvePlan(kind), cfg) : Promise.resolve(undefined);
  const list = (raws: string[] | undefined, kind: MediaKind): Promise<StagedMedia[] | undefined> =>
    raws ? Promise.all(raws.map((r) => stageOne(r, kind, resolvePlan(kind), cfg))) : Promise.resolve(undefined);

  const [references, startFrame, endFrame, videoRef, referenceVideos, audioRefs, resources] = await Promise.all([
    list(rawMedia.references, "image"),
    one(rawMedia.startFrame, "image"),
    one(rawMedia.endFrame, "image"),
    one(rawMedia.videoRef, "video"),
    list(rawMedia.referenceVideos, "video"),
    list(rawMedia.audioRefs, "audio"),
    rawMedia.resources
      ? Promise.all(
          rawMedia.resources.map(async (r) => ({ media: await stageOne(r.url, "image", resolvePlan("image"), cfg), tag: r.tag })),
        )
      : Promise.resolve(undefined),
  ]);

  const staged: StagedMediaGroup = {};
  if (references) staged.references = references;
  if (startFrame) staged.startFrame = startFrame;
  if (endFrame) staged.endFrame = endFrame;
  if (videoRef) staged.videoRef = videoRef;
  if (referenceVideos) staged.referenceVideos = referenceVideos;
  if (audioRefs) staged.audioRefs = audioRefs;
  if (resources) staged.resources = resources;
  return staged;
}

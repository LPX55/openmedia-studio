/**
 * Codex CLI adapter — Phase 4 (P4b). Logic MOVED VERBATIM from the
 * `app/api/generate/route.ts` Codex branch (:458-515), wrapped as a sync
 * `submit()`. `codex-imagegen` drives OpenAI Codex's image tool using the
 * server's local `codex login` session (~/.codex/auth.json) — a single shared
 * identity, not a per-user API key.
 *
 * - `checkReadiness` (finding 1iii): the `keySource: "cli"` branch — ready iff
 *   the shared `codex login` session exists (as reported by
 *   `guestDb.getProviderRuntimeConfig("codex")`, which mirrors
 *   app/api/settings/codex-status); the api_key chain must NOT be required.
 * - Media staging: the provider-level default is "local-file" (design §1.3);
 *   staged file paths are read back into buffers for the CLI's temp-file
 *   inputs. Already-remote references pass through staging unchanged and are
 *   fetched here — the same bytes the old `fetchBuffer(ensureR2(...))` chain
 *   produced.
 */
import { spawn } from "node:child_process";
import https from "node:https";
import http from "node:http";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { MEDIA_DIR } from "../../guest/paths";
import type { ImageModel } from "../../modelConfig";
import type {
  GenerateInput,
  GenerationProvider,
  StagedMedia,
  SubmitOutcome,
} from "../types";

// codex-imagegen (https://github.com/jdmnk/codex-imagegen-cli) only accepts these four sizes.
const CODEX_SIZE_MAP: Record<string, string> = {
  auto:   "auto",
  "1:1":  "1024x1024",
  "16:9": "1536x1024",
  "9:16": "1024x1536",
  "4:3":  "1536x1024",
  "3:4":  "1024x1536",
};

/**
 * codex-imagegen's stderr wraps the underlying failure as `codex-imagegen exited
 * with code N: <tmp path> Error: <detail>`, where <detail> is either a JSON blob
 * (e.g. `HTTP 429: {"error":{"message":"..."}}`) or plain prose terminated by a
 * semicolon (e.g. `Responses stream ended without an image result; last status
 * was failed.`). Pull out just the useful part instead of showing the whole dump.
 * (Moved verbatim from app/api/generate/route.ts:202-217.)
 */
function cleanCodexError(raw: string): string {
  const match = raw.match(/Error:\s*([\s\S]*)$/);
  const tail = (match ? match[1] : raw).trim();

  const braceIdx = tail.indexOf("{");
  if (braceIdx !== -1) {
    try {
      const parsed = JSON.parse(tail.slice(braceIdx));
      const message = parsed?.error?.message;
      if (typeof message === "string" && message) return message;
    } catch { /* not valid JSON — fall through */ }
  }

  const semiIdx = tail.indexOf(";");
  return (semiIdx !== -1 ? tail.slice(0, semiIdx).trim() : tail) || raw;
}

/** Fetch any http/https URL to a Buffer, following redirects. (Moved verbatim from the old route:83-108.) */
function fetchBuffer(url: string, maxRedirects = 5): Promise<Buffer> {
  if (url.startsWith("/generated/")) {
    const rel = normalize(decodeURIComponent(url.slice("/generated/".length).split(/[?#]/)[0]));
    if (rel.startsWith("..") || rel.includes("\0")) {
      return Promise.reject(new Error(`Refusing to read outside media dir: ${url}`));
    }
    return readFile(join(MEDIA_DIR, rel));
  }
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error("Too many redirects"));
    const u   = new URL(url);
    const mod = u.protocol === "https:" ? https : (http as unknown as typeof https);
    mod.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchBuffer(res.headers.location, maxRedirects - 1).then(resolve).catch(reject);
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode} fetching image`));
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end",  () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

/** Resolve one staged reference to bytes (staged buffer → local file → remote fetch). */
async function stagedBytes(s: StagedMedia): Promise<Buffer> {
  if (s.buffer) return s.buffer;
  if (s.filePath) return readFile(s.filePath);
  return fetchBuffer(s.url ?? s.originalUrl);
}

/**
 * Runs the `codex-imagegen` CLI and reads the generated PNG back from its --out
 * path. Writes reference images to temp files (the CLI takes file paths, not
 * URLs). (Moved verbatim from app/api/generate/route.ts:226-271.)
 */
async function runCodexImagegen(opts: {
  prompt: string;
  images: Array<{ buf: Buffer; ext: string }>;
  size: string;
}): Promise<Buffer> {
  const tmpFiles: string[] = [];
  const outPath = join(tmpdir(), `codex-out-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);

  try {
    const imagePaths: string[] = [];
    for (const img of opts.images) {
      const p = join(tmpdir(), `codex-in-${Date.now()}-${Math.random().toString(36).slice(2)}.${img.ext}`);
      await writeFile(p, img.buf);
      tmpFiles.push(p);
      imagePaths.push(p);
    }

    const args = imagePaths.length > 0
      ? ["edit", ...imagePaths.flatMap((p) => ["--image", p]), "--prompt", opts.prompt, "--size", opts.size, "--out", outPath, "--force"]
      : ["generate", "--prompt", opts.prompt, "--size", opts.size, "--out", outPath, "--force"];

    const { exitCode, stderr } = await new Promise<{ exitCode: number; stderr: string }>((resolve, reject) => {
      let err = "";
      const proc = spawn("codex-imagegen", args);
      proc.stderr.on("data", (d: Buffer) => err += d.toString());
      proc.on("close", (code) => resolve({ exitCode: code ?? -1, stderr: err }));
      proc.on("error", (e) => reject(new Error(`codex-imagegen spawn failed: ${e.message} — is it installed and on PATH?`)));
    });

    if (exitCode !== 0) {
      // The useful part — codex-imagegen's final `Error: ...` line — is at the
      // *tail* of stderr, after any retry `Warning:` lines. Those warnings
      // (now including a raw failed-item dump per retry, see cli.py's
      // item_failed_no_detail handling) can push well past a head-truncated
      // slice, which cuts the real error off before cleanCodexError() ever
      // sees it. Log the untruncated stream for debugging and only cap what
      // gets wrapped into the thrown Error as a sane upper bound.
      console.error("[codex-imagegen] full stderr:", stderr || "(empty)");
      throw new Error(`codex-imagegen exited with code ${exitCode}: ${stderr.slice(-4000) || "no stderr output"}`);
    }

    return await readFile(outPath);
  } finally {
    for (const f of [...tmpFiles, outPath]) unlink(f).catch(() => {});
  }
}

export const codexProvider: GenerationProvider = {
  id: "codex",
  label: "Codex CLI",
  mediaStaging: "local-file",

  checkReadiness(cfg): { ready: boolean; reason?: string } {
    // Finding 1iii — keySource "cli" branch; the api_key chain does not apply.
    return cfg.keySource === "cli"
      ? { ready: true }
      : { ready: false, reason: "Codex CLI is not configured — run `codex login` on this machine." };
  },

  async submit(input: GenerateInput): Promise<SubmitOutcome> {
    const model = input.model as ImageModel;
    const aspectRatio = input.params.aspectRatio ?? "auto";
    const size = CODEX_SIZE_MAP[aspectRatio] ?? "auto";

    // "<<<image N>>>" tags are an in-text convention other providers resolve to a
    // URL; codex-imagegen takes images as separate file args, so just flatten the
    // tag to plain prose instead.
    // Codex's --size only offers 4 fixed canvases (no true 4:3/3:4), so spelling out
    // the intended ratio in the prompt steers composition even when the canvas itself
    // is an approximation. (Moved verbatim from :486-489.)
    const codexPrompt = (input.prompt
      .slice(0, model.apiInput.promptMaxLength ?? 8000)
      .replace(/<<<image (\d+)>>>/gi, (_m, n) => `image ${n}`)
      + (aspectRatio && aspectRatio !== "auto" ? ` Aspect ratio: ${aspectRatio}.` : "")).trim();

    const refs = (input.media.references ?? []).slice(0, 5);
    const images = await Promise.all(
      refs.map(async (s) => {
        const buf = await stagedBytes(s);
        const name = s.filename ?? s.url ?? s.originalUrl;
        const raw = name.split("?")[0].split(".").pop()?.toLowerCase() ?? "png";
        const ext = raw === "jpg" ? "jpeg" : raw;
        return { buf, ext };
      }),
    );

    try {
      const outBuf = await runCodexImagegen({ prompt: codexPrompt, images, size });
      return { mode: "sync", mediaUrls: [], rawBuffers: [{ buffer: outBuf, mimeType: "image/png" }] };
    } catch (e: unknown) {
      // Old branch settled the cleaned message; preserve it for the managed task.
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(cleanCodexError(msg));
    }
  },
};

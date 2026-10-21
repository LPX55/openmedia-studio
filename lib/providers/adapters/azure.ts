/**
 * Azure Foundry adapter — Phase 4 (P4b). Submit logic MOVED VERBATIM from the
 * `app/api/generate/route.ts` Azure branch (:327-456), wrapped as a sync
 * `submit()` (design §2: sync providers settle through the managed background
 * task in `jobManager.submitJob`, no upstream task to poll).
 *
 * - `checkReadiness` (finding 1ii): NOT ready unless `cfg.baseUrl` AND
 *   `cfg.extra.deployments[binding.modelId]` exist — mirrors today's
 *   `if (azureBaseUrl && azureDeployment)` gate, at least as strict.
 * - Media staging (finding 1i): the gpt-image-2 Azure binding declares
 *   `mediaStagingByOperation: { "image-generate": "data-url",
 *   "image-edit": "multipart-buffer" }`. Text-to-image sends JSON only (no
 *   media), so the `data-url` strategy is moot there; image-to-image edits get
 *   staged buffers, which replace the route's old `fetchBuffer()` reads of the
 *   ensureR2'd `/generated/...` paths (same bytes off the same disk files).
 */
import { spawn } from "node:child_process";
import https from "node:https";
import http from "node:http";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { MEDIA_DIR } from "../../guest/paths";
import { validateAzureCustomSize, type ImageModel } from "../../modelConfig";
import type { ModelProviderBinding } from "../bindings";
import type {
  GenerateInput,
  GenerationProvider,
  ProviderRuntimeConfig,
  StagedMedia,
  SubmitOutcome,
} from "../types";

/**
 * A minimal HTTPS POST that uses Node.js core — NOT Next.js's patched `fetch`.
 * Next.js ties its patched fetch to the request's AbortSignal, which cancels
 * any pending calls when the HTTP response commits. This helper is immune to
 * that because it goes through the raw TLS stack. (Moved verbatim from
 * app/api/generate/route.ts:29-77.)
 */
function httpsPost(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs = 1_000_000, // Azure image gen (gpt-image-2) can be slow; 1000s gives ample headroom
): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> {
  return new Promise((resolve, reject) => {
    const u       = new URL(url);
    const bodyBuf = Buffer.from(body, "utf8");

    const req = https.request(
      {
        hostname: u.hostname,
        port:     u.port ? Number(u.port) : 443,
        path:     u.pathname + u.search,
        method:   "POST",
        headers:  { ...headers, "Content-Length": bodyBuf.byteLength },
      },
      (res) => {
        const chunks: Buffer[] = [];

        // Response stream errors (e.g. ECONNRESET mid-body) must be caught here
        res.on("error", reject);
        res.on("data",  (c: Buffer) => chunks.push(c));
        res.on("end",   () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok:     (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            status: res.statusCode ?? 0,
            text:   () => Promise.resolve(raw),
          });
        });
      },
    );

    // Disable Nagle and keep-alive so the socket stays alive for long responses
    req.on("socket", (socket) => {
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 10_000);
      socket.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Azure request timed out after ${timeoutMs / 1000}s`));
      });
    });

    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

/**
 * Fetch any http/https URL to a Buffer, following redirects. Root-relative
 * "/generated/..." refs aren't valid URLs — read those straight off local
 * disk. (Moved verbatim from app/api/generate/route.ts:83-108; only needed
 * now for already-remote reference URLs that passed through staging
 * unchanged.)
 */
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

/**
 * Resolve one staged reference to the bytes Azure needs: the staged buffer
 * (multipart-buffer strategy) wins; a staged local file path is read; a
 * passthrough remote URL is fetched (same bytes the old ensureR2→fetchBuffer
 * chain produced).
 */
async function stagedBytes(s: StagedMedia): Promise<Buffer> {
  if (s.buffer) return s.buffer;
  if (s.filePath) return readFile(s.filePath);
  return fetchBuffer(s.url ?? s.originalUrl);
}

/** Extension/mime derivation moved from the route's edits branch (:376-381). */
function extAndMime(nameOrUrl: string): { ext: string; mime: string } {
  const raw = nameOrUrl.split("?")[0].split(".").pop()?.toLowerCase() ?? "png";
  const ext = raw === "jpg" ? "jpeg" : raw;
  const mime = ext === "jpeg" ? "image/jpeg" : "image/png";
  return { ext, mime };
}

/**
 * Send a multipart/form-data request via curl (bypasses Node.js TLS quirks
 * with Azure). Moved verbatim from app/api/generate/route.ts:112-175.
 */
async function curlMultipartPost(
  url:        string,
  authKey:    string,
  images:     Array<{ buf: Buffer; mime: string; ext: string }>,
  textFields: Record<string, string>,
): Promise<{ ok: boolean; status: number; body: string }> {
  const tmpFiles: string[] = [];
  const bodyPath = join(tmpdir(), `azure-resp-${Date.now()}.json`);

  try {
    for (const img of images) {
      const p = join(tmpdir(), `azure-img-${Date.now()}-${Math.random().toString(36).slice(2)}.${img.ext}`);
      await writeFile(p, img.buf);
      tmpFiles.push(p);
    }

    const args = [
      "-s", "-m", "600",
      "-X", "POST", url,
      "-H", `Authorization: Bearer ${authKey}`,
      "-o", bodyPath,
      "-w", "%{http_code}",
    ];
    for (let i = 0; i < images.length; i++) {
      args.push("-F", `image[]=@${tmpFiles[i]};type=${images[i].mime}`);
    }
    for (const [k, v] of Object.entries(textFields)) {
      args.push("-F", `${k}=${v}`);
    }

    console.log("[azure/edits/curl] args:", args.map((a) => (a.startsWith("Bearer ") ? "Bearer ***" : a)));

    const runCurl = () => new Promise<{ statusStr: string; stderr: string; exitCode: number }>((resolve, reject) => {
      let out = "";
      let err = "";
      const proc = spawn("curl", args);
      proc.stdout.on("data", (d: Buffer) => out += d.toString());
      proc.stderr.on("data", (d: Buffer) => err += d.toString());
      proc.on("close",  (code) => resolve({ statusStr: out.trim(), stderr: err, exitCode: code ?? -1 }));
      proc.on("error",  (e) => reject(new Error(`curl spawn failed: ${e.message}`)));
    });

    let statusStr: string = "", stderr: string = "", exitCode: number = -1;
    for (let attempt = 1; attempt <= 3; attempt++) {
      ({ statusStr, stderr, exitCode } = await runCurl());
      console.log(`[azure/edits/curl] attempt ${attempt} exit code:`, exitCode);
      if (stderr) console.log("[azure/edits/curl] stderr:", stderr);
      if (exitCode !== 35) break; // 35 = SSL handshake failure — retry
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }

    if (exitCode! !== 0) {
      const reason = exitCode! === 28 ? "timed out (curl -m 600 exceeded)" : `curl exited with code ${exitCode}`;
      throw new Error(`Azure curl request failed: ${reason}`);
    }

    const status = parseInt(statusStr, 10) || 0;
    const body   = await readFile(bodyPath, "utf-8").catch(() => "");
    console.log("[azure/edits/curl] status:", status, "body:", body.slice(0, 1000));
    return { ok: status >= 200 && status < 300, status, body };
  } finally {
    for (const f of [...tmpFiles, bodyPath]) unlink(f).catch(() => {});
  }
}

/** Per-user deployment name from provider_configs.extra_json (finding 1ii). */
function deploymentFor(cfg: ProviderRuntimeConfig, modelId: string): string | null {
  const deployments = (cfg.extra?.deployments as Record<string, string> | undefined) ?? {};
  return deployments[modelId] ?? null;
}

export const azureProvider: GenerationProvider = {
  id: "azure",
  label: "Azure Foundry",
  // Provider-level default; the gpt-image-2 binding refines per operation.
  mediaStaging: "data-url",
  capabilities: {
    syncSubmission: true,
    polling: false,
    mediaUpload: false,
    mediaStaging: "data-url",
    // IMAGE-ONLY backend — the video route refuses it (an Azure video request
    // would be built as an image request).
    video: false,
  },

  checkReadiness(cfg: ProviderRuntimeConfig, binding?: ModelProviderBinding): { ready: boolean; reason?: string } {
    // Finding 1ii — at least as strict as the old `azureBaseUrl && azureDeployment` gate.
    if (!cfg.apiKey) return { ready: false, reason: "Azure API key is not configured. Add it in Settings." };
    if (!cfg.baseUrl) return { ready: false, reason: "Azure base URL is not configured. Add it in Settings." };
    if (!binding || !deploymentFor(cfg, binding.modelId)) {
      return { ready: false, reason: "No Azure deployment configured for this model. Add one in Settings." };
    }
    return { ready: true };
  },

  async submit(input: GenerateInput): Promise<SubmitOutcome> {
    const model = input.model as ImageModel;
    const cfg = input.credentials;

    // Old route gate — submitJob has normally checked readiness already.
    const azureKey = cfg.apiKey;
    if (!azureKey) throw new Error("Azure API key is not configured. Add it in Settings.");
    const deployment = deploymentFor(cfg, model.id);
    if (!deployment) throw new Error("No Azure deployment configured for this model. Add one in Settings.");

    // ── Size / quality resolution (moved verbatim from :331-342) ─────────────
    const aspectRatio = input.params.aspectRatio ?? "1:1";
    const azureCustomWidth = input.params.customWidth;
    const azureCustomHeight = input.params.customHeight;
    const resSizeMaps     = model.azureResolutionSizeMaps ?? {};
    const sizeMap         = (input.params.resolution && resSizeMaps[input.params.resolution])
      ? resSizeMaps[input.params.resolution]
      : (model.azureSizeMap ?? {});
    const customSizeError = aspectRatio === "custom" && azureCustomWidth && azureCustomHeight
      ? validateAzureCustomSize(azureCustomWidth, azureCustomHeight)
      : null;
    const size            = aspectRatio === "custom" && azureCustomWidth && azureCustomHeight && !customSizeError
      ? `${azureCustomWidth}x${azureCustomHeight}`
      : (sizeMap[aspectRatio] ?? "1024x1024");
    const quality         = input.params.quality || "medium";
    const base            = (cfg.baseUrl ?? "").replace(/\/$/, "");
    const azureApiVersion = model.azureApiVersion ?? "2025-04-01-preview";
    const truncatedPrompt = input.prompt.slice(0, model.apiInput.promptMaxLength ?? 32000);

    const refs = input.media.references ?? [];
    const hasRefImages = refs.length > 0;

    let res: { ok: boolean; status: number; text: () => Promise<string> };

    if (hasRefImages) {
      // ── Image-to-image: multipart /images/edits via curl ────────────────────
      const azureUrl = `${base}/openai/deployments/${deployment}/images/edits?api-version=${azureApiVersion}`;

      const images = await Promise.all(
        refs.slice(0, model.maxImages).map(async (s) => {
          const buf = await stagedBytes(s);
          const { ext, mime } = extAndMime(s.filename ?? s.url ?? s.originalUrl);
          return { buf, ext, mime };
        }),
      );

      const textFields: Record<string, string> = {
        prompt:        truncatedPrompt,
        quality,
        output_format: "png",
        n:             "1",
      };
      if (size && size !== "auto") textFields.size = size;

      const curl = await curlMultipartPost(azureUrl, azureKey, images, textFields);
      res = { ok: curl.ok, status: curl.status, text: () => Promise.resolve(curl.body) };
    } else {
      // ── Text-to-image: JSON /images/generations ─────────────────────────────
      const azureUrl = `${base}/openai/deployments/${deployment}/images/generations?api-version=${azureApiVersion}`;

      const body: Record<string, unknown> = {
        prompt:             truncatedPrompt,
        n:                  1,
        output_format:      "png",
        output_compression: 100,
        quality,
      };
      if (size && size !== "auto") body.size = size;

      console.log("[azure/generations] request →", {
        url:    azureUrl,
        method: "POST",
        body,
      });

      res = await httpsPost(
        azureUrl,
        { "Content-Type": "application/json", Authorization: `Bearer ${azureKey}` },
        JSON.stringify(body),
      );
    }

    const txt = await res.text();
    console.log("[azure] raw response body:", txt.slice(0, 1000));
    if (!res.ok) {
      let displayError = `Azure error ${res.status}`;
      try {
        const parsed = JSON.parse(txt);
        const code   = parsed?.error?.code ?? parsed?.error?.type;
        const friendlyErrors: Record<string, string> = {
          EngineOverloaded: "Model is overloaded right now. Please try again.",
        };
        displayError = code ? (friendlyErrors[code] ?? code) : displayError;
      } catch { /* not JSON */ }
      // Old branch settled this exact message through settleJob; the managed
      // submit task in jobManager.submitJob does the same for a thrown error.
      throw new Error(displayError);
    }

    const azureJson = JSON.parse(txt);
    const b64 = azureJson?.data?.[0]?.b64_json as string | undefined;
    if (!b64) throw new Error("Azure returned no image data");

    const buf = Buffer.from(b64, "base64");
    return { mode: "sync", mediaUrls: [], rawBuffers: [{ buffer: buf, mimeType: "image/png" }] };
  },
};

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "./guest/paths";

/**
 * C3 pinned provider_meta shape (design.md §1.3/§2.1) — persisted as JSON in
 * `generations.provider_meta` and mirrored on pending jobStore entries.
 * Phase 4 moves the canonical declaration into lib/providers/types.ts; keep
 * the shapes identical until then.
 */
export interface ProviderMeta {
  upstreamTaskId: string;   // id on the upstream provider (Kie task id in Phase 2)
  family: string;           // VideoPayloadFamily | "standard" (union lands with Phase-4 bindings)
  statusUrl: string;        // fully-resolved status endpoint
  responseUrl?: string;     // result endpoint when separate from status (fal) — C4
  upstreamModelId: string;  // model string actually sent upstream
}

export type JobResult =
  | { status: "pending"; type?: "image" | "video"; userId?: string; providerId?: string; providerMeta?: ProviderMeta }
  | { status: "done"; imageUrl?: string; imageUrls?: string[]; videoUrl?: string; providerId?: string; providerMeta?: ProviderMeta }
  | { status: "error"; error: string; providerId?: string; providerMeta?: ProviderMeta };

// DATA_DIR is the repo in dev and a writable per-user dir in the packaged
// desktop app (the install dir is read-only there).
const FILE = join(DATA_DIR, ".job-store.json");

function read(): Record<string, JobResult> {
  if (!existsSync(FILE)) return {};
  try { return JSON.parse(readFileSync(FILE, "utf8")); }
  catch { return {}; }
}

function write(data: Record<string, JobResult>): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(data), "utf8");
}

export const jobStore = {
  get(taskId: string): JobResult | undefined {
    return read()[taskId];
  },
  set(taskId: string, result: JobResult): void {
    const data = read();
    data[taskId] = result;
    write(data);
  },
};

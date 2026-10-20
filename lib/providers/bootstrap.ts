/**
 * `lib/providers/bootstrap` — Phase 4 (P4b) adapter bootstrap.
 *
 * NOTE (P4b documented choice): this is NOT `lib/providers/index.ts` — the
 * client-side `lib/providers.ts` file occupies the `@/lib/providers`
 * specifier, so a directory index would be shadowed by it. Controllers import
 * `@/lib/providers/bootstrap` (and jobManager imports `./providers/bootstrap`).
 *
 * Registers the built-in adapters (KieProvider, AzureFoundryProvider,
 * CodexCliProvider) into the registry exactly once per server process.
 * Controllers import THIS module (its side effects do the registration) and
 * the re-exported registry API — they NEVER import individual adapters, so a
 * future adapter (Phase 6: replicate / fal / openai-compat) only touches this
 * file. Phase-6 custom-endpoint adapters will register from their own code
 * paths via `register()`.
 *
 * SERVER-ONLY: importing this pulls in the adapters (node:child_process,
 * node:https, kieUpload, guest paths) — never import it from client code.
 */
import { register } from "./registry";
import { kieProvider } from "./adapters/kie";
import { azureProvider } from "./adapters/azure";
import { codexProvider } from "./adapters/codex";

let registered = false;

/** Idempotent — `register()` also replaces entries on hot-reload anyway. */
export function registerBuiltinProviders(): void {
  if (registered) return;
  register(kieProvider);
  register(azureProvider);
  register(codexProvider);
  registered = true;
}

registerBuiltinProviders();

// Registry API re-exported for controllers (`resolveForModel` etc.).
export { register, get, resolveForModel } from "./registry";
export type { ModelBindingRowLike, ResolvedModelProvider } from "./registry";

# scripts/desktop/

Toolchain for packaging HeliosGen as a Tauri desktop app with a bundled Next.js sidecar server and a portable Node runtime.

Files: `dev.mjs`, `build-server.mjs`, `check-version.mjs`, `sidecar-guard.js`, `sign.env.example`.

## Responsibility

- `dev.mjs` — run `next dev` and `tauri dev` concurrently for desktop development.
- `build-server.mjs` — production build: stage a self-contained Next.js standalone server + Node runtime into `src-tauri/server/`, build the Rust sidecar shim, prune/prune node_modules, and codesign buried Mach-O on macOS.
- `check-version.mjs` — assert the app version is identical across `tauri.conf.json`, `package.json`, `Cargo.toml`, `Cargo.lock` (and matches an optional release tag / `$GITHUB_REF_NAME`).
- `sidecar-guard.js` — tiny preloaded (`node -r`) watchdog that exits the packaged server if its Tauri parent dies (orphaned-to-launchd detection).
- `sign.env.example` — template for macOS signing/notarization env vars (`APPLE_SIGNING_IDENTITY`, App Store Connect API key or Apple ID); copy to gitignored `sign.env` and `source` before a release build.

## Design

- Plain Node ESM; repo root derived from `import.meta.url`. All scripts are idempotent/fail-fast.
- `build-server.mjs`:
  - Wipes `src-tauri/server`, `src-tauri/binaries`, and `.next/standalone` first to avoid the file-tracer sweeping prior ~900 MB trees.
  - Runs `next build` with `DESKTOP_BUILD=1` and `NEXT_PUBLIC_APP_VERSION` (from `tauri.conf.json`) baked in.
  - Copies `.next/standalone` + `.next/static` + `public/` (excluding `public/generated`) into the stage; drops `sidecar-guard.js` in.
  - Replaces pnpm-symlinked `node_modules` with a clean `npm install --omit=dev`, pinning every prod dep to the exact installed version (nft is unreliable under pnpm).
  - Prunes build-only packages (`@next/swc-*`, foreign-platform `@img`/sharp binaries).
  - Bundles a portable Node binary as a *resource* (`server/node-bin/node`) — on macOS, detects Homebrew's split `libnode.*.dylib` via `otool -L` and falls back to a cached official nodejs.org build.
  - Builds the `helios-node` shim (`src-tauri/loader`) and stages it as the Tauri `externalBin` named by target triple (`rustc -Vv` host, with a platform map fallback); the shim hides from the Dock then execs the bundled node (avoids tauri#14014 Dock tile).
  - On macOS with `APPLE_SIGNING_IDENTITY`, codesigns all `*.node`/`*.dylib`/`*.so` under the staged `node_modules` plus the Node runtime, inside-out, with `entitlements.plist`.
  - `--dev` flag: only stage the shim (fast), exit.
  - Requires Node ≥ 22 (`node:sqlite`).
- `sidecar-guard.js` polls `process.ppid` every 2 s; exits 0 if the parent changes or becomes 1.
- `check-version.mjs` treats `tauri.conf.json` as canonical; leading `v` on tags tolerated.

## Flow

Dev: `pnpm desktop:dev` → `dev.mjs` spawns `next dev` (with `NEXT_PUBLIC_APP_VERSION`, `NODE_OPTIONS=--disable-warning=ExperimentalWarning`) and `tauri dev` (with `HELIOS_DEV_URL`, default `http://localhost:3000`); either child exiting triggers SIGTERM to the other.

Release: `pnpm desktop:build` → `check-version.mjs` (consistency + tag) → `tauri build` → `beforeBuildCommand` → `build-server.mjs` → shim + staged server signed and bundled → Tauri signs the app shell; notarization uses env from `sign.env`.

Runtime: Tauri spawns the `helios-node` sidecar shim → shim execs staged `node server.js` with `sidecar-guard.js` preloaded → guard exits the server if the Tauri parent disappears.

## Integration

- `package.json` scripts: `desktop:dev`, `desktop:check-version`, `desktop:build`.
- `src-tauri/tauri.conf.json`: `beforeDevCommand` / `beforeBuildCommand`; expects `externalBin` → `binaries/helios-node-<triple>`.
- `src-tauri/loader/` (Rust shim source), `src-tauri/entitlements.plist` (codesign entitlements), `next.config.ts` (`output: "standalone"`, excludes `src-tauri` from tracing).
- Reads runtime data from `public/generated` (excluded from the bundle).
- CI: version check with `$GITHUB_REF_NAME`; signing env sourced from gitignored `sign.env` (never committed).

# scripts/

Build, dev, and release automation for the project. All scripts are plain Node ESM (`.mjs`) or JS run directly with `node` — no build step, no framework.

## Responsibility

Developer/CI entry points that don't belong in app code:

- `scripts/desktop/` — the Tauri desktop shell toolchain (dev runner, sidecar build/stage, version guard, macOS signing env template). See `scripts/desktop/codemap.md` for details.

## Design

- Each script is self-contained, resolves the repo root from `import.meta.url` (`ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")`), and is invoked by name from `package.json` scripts or Tauri `before*Command` hooks.
- Fail-fast: throw or `process.exitCode = 1` with `✗`-prefixed messages on problems.

## Flow

Human or CI runs a `package.json` script → script operates on the repo tree directly (read manifests, run `next`/`cargo`/`npm` via `execFileSync`, stage files).

## Integration

- `package.json`:
  - `desktop:dev` → `scripts/desktop/dev.mjs`
  - `desktop:check-version` → `scripts/desktop/check-version.mjs`
  - `desktop:build` → `check-version.mjs && CI=true tauri build`
- `src-tauri/tauri.conf.json`: `beforeDevCommand` → `build-server.mjs --dev`, `beforeBuildCommand` → `build-server.mjs`.
- CI (GitHub Actions) calls the version check with `$GITHUB_REF_NAME` as the release tag.

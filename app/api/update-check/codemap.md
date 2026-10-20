# /api/update-check — desktop release check

## Responsibility
Asks the GitHub Releases API whether a newer tag exists than the running desktop
build, giving `components/UpdateBanner.tsx` everything for the update bar +
changelog modal. No self-install — it just links to the release page.

## Design
- `export const runtime = "nodejs"`, `dynamic = "force-dynamic"`.
- Repo hard-coded `SegFault42/HeliosGen`; endpoint `GET /repos/…/releases/latest`.
- Running version = `NEXT_PUBLIC_APP_VERSION` (baked from `src-tauri/tauri.conf.json`
  by `scripts/desktop/build-server.mjs` / `dev.mjs`), default `0.0.0`.
- In-module cache: 1 h TTL (`CACHE_TTL_MS`) to respect GitHub's unauthenticated
  60 req/h limit. 10 s `AbortSignal.timeout` on the upstream fetch.
- Version compare: `parseVersion` regex → `[major, minor, patch]` tuple
  (unparseable slots → 0), `isNewer` lexicographic-by-slot; prereleases skipped
  unless forced; drafts always skipped; 404 treated as "up to date", not an error.
- `NEXT_PUBLIC_UPDATE_CHECK_FORCE=1` injects a fake `v0.0.0-preview` payload
  (and admits prereleases) so the banner/modal can be previewed.

## Flow
1. Serve from cache when fresh.
2. Fetch latest release → build `{ updateAvailable, currentVersion, latestVersion?,
   name?, notes?, url?, publishedAt? }` → cache → respond.

## Integration
- **GitHub**: `https://api.github.com/repos/SegFault42/HeliosGen/releases/latest`
  (UA `HeliosGen-Desktop/<version>`), release page `…/releases/latest`.
- **Env**: `NEXT_PUBLIC_APP_VERSION`, `NEXT_PUBLIC_UPDATE_CHECK_FORCE`.
- **Response**: `UpdatePayload` JSON as above (never errors — failures collapse to
  `updateAvailable: false`).

# /api/open-external — OS browser opener

## Responsibility
Opens a URL in the user's OS default browser. Needed because the desktop shell's
webview traps `window.open` / `target="_blank"`; the Next.js server runs as a
local child process and can shell out.

## Design
- `export const runtime = "nodejs"`.
- `POST` body `{ url }`; must parse as a URL with `http:`/`https:` protocol only
  (anything else → 400 `unsupported protocol` / `invalid url`).
- Platform opener helper: macOS `open`, Windows `cmd /c start ""`, else `xdg-open`.
- Spawn is `detached: true`, `stdio: "ignore"` with `child.unref()` — fire-and-forget,
  the request returns before the browser launches.
- Spawn failure → 500 with the error message.

## Flow
1. Parse + protocol-check the URL.
2. `spawn(opener, [...args, url])` → unref.
3. Return `{ ok: true }`.

## Integration
- **OS**: `open` / `cmd` / `xdg-open` (no external HTTP).
- **Request/Response**: `POST { url }` → `{ ok: true }` | `{ error }` (400/500).
- **Consumers**: external links (docs, provider dashboards, release pages) from
  the webview UI.

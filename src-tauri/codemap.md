# src-tauri/

Tauri v2 desktop shell for HeliosGen. It is a thin native launcher: it boots a
bundled Node/Next.js server as a sidecar, waits for it, then navigates the
single webview from a static splash page to the live app. Almost no app logic
lives here — the product is the Next.js server.

## Responsibility

Directory layout:

- `tauri.conf.json` — app identity (`cash.sdd.helios.desktop`, v1.2.1), one
  1400×900 main window, bundle config (icons, `externalBin: binaries/helios-node`,
  `resources: server/**/*`), build hooks (`beforeDevCommand` / `beforeBuildCommand`
  run `node scripts/desktop/build-server.mjs`, `frontendDist: ./loading`).
- `Cargo.toml` / `Cargo.lock` — crate `heliosgen-desktop` (lib
  `heliosgen_desktop_lib`, `staticlib`/`cdylib`/`rlib`). Deps: `tauri` 2,
  `tauri-plugin-shell` 2, `serde`/`serde_json`. Keeps the mandatory
  `custom-protocol` feature for `tauri dev/build`.
- `build.rs` — bare `tauri_build::build()` (generates context, capability
  schemas, embeds `frontendDist`).
- `capabilities/default.json` — grants `core:default` to window `main` plus
  `shell:allow-spawn` / `shell:allow-execute` restricted to the single sidecar
  `helios-node` with arbitrary args. This is the only IPC surface exposed.
- `icons/` — bundled icon set (png/ico/icns); `icon-source.png` is the master.
- `entitlements.plist` — macOS hardened-runtime entitlements for signing.
- `loader/` — standalone crate `helios-node-loader`, bin name `helios-node`.
  A tiny shim: on macOS it demotes itself out of the Dock via
  `TransformProcessType`, then `exec`s the real Node runtime (path from
  `HELIOS_NODE_BIN`) so PID and Tauri's `CommandChild::kill()` are preserved.
  Deliberately not a workspace member (no tauri deps → sub-second builds);
  released with size opts (`opt-level=z`, LTO, strip, `panic=abort`) and staged
  as `binaries/helios-node` by `build-server.mjs`.
- `loading/index.html` — the actual `frontendDist`: a black spinner splash
  ("Starting HeliosGen…") shown until the sidecar responds.
- `src/` — main crate, see `src/codemap.md`.

## Design

- Tauri v2 idioms: plugin registry (`tauri_plugin_shell::init()`), capability
  files instead of global perms, `app.state` managed state, `generate_context!`.
- **No custom `#[tauri::command]`s.** The webview never `invoke()`s Rust; the
  only Rust→frontend contract is URL navigation. `withGlobalTauri: false`,
  `csp: null`.
- Sidecar over embedded server: Node ships as a *resource*
  (`server/node-bin/node`) to avoid the duplicate-Dock-tile bug
  (tauri-apps/tauri#14014); only the ~KB shim is a true `externalBin` sidecar.
- Fixed port preference (41730..41749) so the webview origin — and therefore
  localStorage/IndexedDB — is stable across launches; probe is
  connect-timeout based so `TIME_WAIT` sockets don't count.
- GUI environment repair: `resolve_user_path` / `resolve_user_env_var` shell out
  to the user's login shell (`$SHELL -lic`) to recover `PATH` and `.zshrc`
  overrides (`CODEX_IMAGEGEN_MODEL`) that Finder/Dock launches never source.

## Flow

Build: `build-server.mjs` compiles the loader shim, stages `server/` (standalone
Next server + `node-bin` + `sidecar-guard.js`), produces
`binaries/helios-node-<triple>` — then `tauri-build` packages resources +
sidecar and embeds `loading/`.

Runtime startup:

1. `main()` → `lib::run()` → Builder registers shell plugin + `Sidecar` state,
   `.setup()` runs.
2. If `HELIOS_DEV_URL` is set (dev path via `scripts/desktop/dev.mjs`), the
   window navigates straight to an externally-run `next dev` and setup returns.
3. Otherwise `pick_port()`, then `start_server()`: resolve
   `server/server.js` + `server/node-bin/node` under the resource dir, create
   `<app_data>/generated`, spawn `helios-node --disable-warning=ExperimentalWarning
   -r ./sidecar-guard.js server.js` with env (`PORT`, `HOSTNAME=127.0.0.1`,
   `NODE_ENV=production`, `HELIOS_DATA_DIR`, `HELIOS_MEDIA_DIR`,
   `HELIOS_NODE_BIN`, patched `PATH`/model var); store the `CommandChild` in
   managed state and drain stdout/stderr to the console.
4. A background thread polls `wait_for_server(port, 90s)` and on success
   navigates the main window from `loading/index.html` to
   `http://127.0.0.1:<port>/`.
5. On `RunEvent::Exit`, `kill_sidecar()` takes the child from state and kills
   it — required because dropping a `CommandChild` does **not** terminate the
   process. `sidecar-guard.js` is a second net: it exits the server if the
   parent Tauri process dies.

IPC: none from JS. Inbound = shell-plugin sidecar spawn/execute (capability
gated). Outbound = stdout/stderr log lines and the exit-code event.

## Integration

- Frontend and backend are the same artifact: `scripts/desktop/build-server.mjs`
  compiles the Next.js app into a standalone Node server shipped under
  `resources/server/**`. The webview talks to it over plain loopback HTTP — no
  FFI, no `invoke()` — so web and desktop share one code path.
- Rust's only product-side duties: pick a stable port, fix GUI-launch env,
  spawn/kill the server, and sequence the splash→app navigation.
- Loader's role: satisfy Tauri's sidecar signing/lookup conventions while
  behaving like an invisible process (Dock suppression + `exec`).
- Related scripts (see `scripts/desktop/codemap.md`): `build-server.mjs`
  (stage), `dev.mjs` (HELIOS_DEV_URL dev loop), `sidecar-guard.js` (orphan
  watchdog), `check-version.mjs` (version sync with `tauri.conf.json`).

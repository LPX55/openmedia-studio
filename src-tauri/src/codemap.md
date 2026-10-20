# src-tauri/src/

The entire Rust runtime of the desktop shell — two files, ~250 LOC total. All
behaviour lives in `lib.rs`; `main.rs` is the platform entry shim.

## Responsibility

- `main.rs` — canonical Tauri binary entry: suppresses the extra Windows
  console in release (`windows_subsystem = "windows"`) and calls
  `heliosgen_desktop_lib::run()`.
- `lib.rs` — everything else: sidecar lifecycle, port selection, environment
  repair, readiness wait, window navigation, and exit cleanup.

Key items in `lib.rs`:

- `struct Sidecar(Mutex<Option<CommandChild>>)` — managed state holding the
  live Next.js server process so it can be killed on exit (dropping a
  `CommandChild` does not terminate it).
- `pick_port()` — prefer fixed 41730 (scan +20) for a stable webview origin /
  localStorage; only taken if a connect-probe shows nothing listening; else
  OS-assigned ephemeral port.
- `resolve_user_path()` / `resolve_user_env_var()` — recover `PATH` and
  shell-config vars (e.g. `CODEX_IMAGEGEN_MODEL`) by running the login shell
  (`$SHELL -lic`), since GUI-launched apps get a bare env.
- `wait_for_server(port, timeout)` — TCP connect poll (150 ms) until the sidecar
  accepts connections or deadline passes.
- `start_server(app, port)` — resolve `server/server.js` and
  `server/node-bin/node` from the resource dir, mkdir `<app_data>/generated`,
  spawn the `helios-node` sidecar with `--disable-warning=ExperimentalWarning
  -r ./sidecar-guard.js server.js`, inject env (`PORT`, `HOSTNAME=127.0.0.1`,
  `NODE_ENV=production`, `HELIOS_DATA_DIR`, `HELIOS_MEDIA_DIR`,
  `HELIOS_NODE_BIN`, patched `PATH`, optional `CODEX_IMAGEGEN_MODEL`), store
  the child, and drain `CommandEvent::{Stdout,Stderr,Terminated}` to the
  console on the async runtime.
- `kill_sidecar(app)` — take-and-kill on `RunEvent::Exit`.
- `run()` — Builder: `tauri_plugin_shell::init()` + `.manage(Sidecar)` +
  `.setup()` + `generate_context!()` + event loop.

## Design

- Tauri v2 patterns: plugin registration, `Manager::state`/`manage`,
  `AppHandle` + `ShellExt::sidecar`, `tauri::async_runtime::spawn` for process
  I/O, `RunEvent::Exit` for teardown, `#[cfg_attr(mobile,
  tauri::mobile_entry_point)]` on `run()`.
- **No `#[tauri::command]` functions and no custom plugins** — the Rust side is
  fire-and-forget. The webview's only privilege (spawn `helios-node`) is
  granted by `capabilities/default.json` but the frontend doesn't use it;
  spawning is done imperatively from `setup`.
- Two-mode runtime: env-var switch (`HELIOS_DEV_URL`) for development vs.
  bundled-sidecar for production/build, so `tauri dev` never needs the staged
  server bundle.
- Blocking ops (port probe, readiness wait) are kept off the setup thread via
  `std::thread::spawn`; only the event-drain loop uses the async runtime.
- Startup ordering hazard handled explicitly: window exists before the server
  does, hence the splash (`loading/index.html`) + delayed `window.navigate`.

## Flow

```
main() ─▶ lib::run()
  Builder.plugin(shell) .manage(Sidecar)
  └ setup(app)
      ├ HELIOS_DEV_URL set? ─▶ window.navigate(dev_url); return
      ├ port = pick_port()
      ├ start_server(port)   // spawn sidecar, store CommandChild, drain logs
      └ thread: wait_for_server(90s) ─▶ window.navigate(http://127.0.0.1:port/)
  .build(generate_context!()).run(event)
      └ RunEvent::Exit ─▶ kill_sidecar()   // kill the kept CommandChild
```

IPC: the Rust process exposes no JS-callable commands. Control flows
inward (env vars, spawn events) and outward (log lines, terminal navigation);
application traffic is plain HTTP between the webview and the sidecar on
loopback.

## Integration

- **Next.js frontend**: rendered inside the single webview after it is
  navigated off the splash page. It delegates *all* native capability to this
  shell only for process/env setup — afterwards frontend ↔ server talk over
  `http://127.0.0.1:<port>/`, identical to a browser deployment.
- **Server sidecar**: `tauri-plugin-shell` spawns `helios-node` (loader shim in
  `src-tauri/loader/`) which `exec`s the bundled `server/node-bin/node` running
  `resources/server/server.js` (built by `scripts/desktop/build-server.mjs`,
  guarded by `sidecar-guard.js`). Rust passes the server its working directory,
  data/media dirs, and restored user env — that env contract is the only
  coupling surface with the Node side.
- **Exit contract**: Rust kills the sidecar on clean exit; `sidecar-guard.js`
  covers crashes of the shell itself; both are needed because orphaned Node
  would keep the fixed port bound.

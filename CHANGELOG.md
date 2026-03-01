# Changelog

## 2026-03-01

### CLI (`bin/tui.js`)

- **New CLI entry point** — `npx durable-copilot-runtime-tui` with full arg parsing via `node:util.parseArgs`.
  Two modes: `local` (embedded workers) and `remote` (client-only, kubectl log streaming).
- **Env file loading** — `.env` / `.env.remote` parsed automatically; CLI flags take precedence.
- **All flags have env var equivalents** — `--store`→`DATABASE_URL`, `--plugin`→`PLUGIN_DIRS`,
  `--worker`→`WORKER_MODULE`, `--workers`→`WORKERS`, `--model`→`COPILOT_MODEL`,
  `--system`→`SYSTEM_MESSAGE`, `--namespace`→`K8S_NAMESPACE`, `--label`→`K8S_POD_LABEL`,
  `--log-level`→`LOG_LEVEL`. Zero-flag operation possible with everything in `.env`.

### TUI (`cli/tui.js`)

- **Moved from `examples/tui.js` to `cli/tui.js`** — TUI is now part of the package, not an example.
- **Parameterized hardcoded values** — system message, K8s namespace, K8s pod label, and worker
  module path all read from env vars set by the CLI.
- **Emoji rendering fix** — monkey-patch neo-blessed's `unicode.charWidth()` to correctly report
  emoji codepoints (U+1F100–U+1FAFF, U+2300–U+27BF, etc.) as 2 cells wide. Emoji now render
  correctly instead of being stripped. Added `forceUnicode: true` to screen options.
- **Session switch repaint fix** — switching sessions now triggers the same full
  `screen.realloc()` + `relayoutAll()` cycle as pressing 'r', plus a deferred
  repaint on next tick. Fixes stale content bleeding through on first switch.
- **Log mode switch repaint fix** — pressing 'm' to change log view mode now also
  triggers the full 'r'-equivalent repaint.
- **Clean exit** — suppress `process.stdout.write` and `process.stderr.write` before
  `screen.destroy()` to prevent neo-blessed's terminfo `SetUlc` compilation dump.
  Terminal reset written via `fs.writeSync(1, ...)` to bypass suppression.
- **Suppress `SetUlc` on load** — stderr silenced during `require("neo-blessed")` and
  `blessed.screen()` creation to prevent terminfo junk on startup.

### `run.sh`

- Updated to use `node bin/tui.js local|remote` instead of setting env vars and calling
  `examples/tui.js` directly.

### `package.json`

- Added `bin` field for `durable-copilot-runtime-tui` → `bin/tui.js`.
- TUI rendering deps (`neo-blessed`, `marked`, `marked-terminal`) moved from
  `devDependencies` to `dependencies`.
- `files` includes `bin/`, `cli/tui.js`, and `plugin/`.
- NPM scripts updated to use new CLI.

### Docs

- **`building-apps.md`** — deployment topology diagrams updated to reference
  `npx durable-copilot-runtime-tui` / `node bin/tui.js`. CLI reference shows env var
  equivalents for all flags. Intro updated to remove stale `tui-apps.md` cross-ref.
- **`README.md`** — TUI example row updated to reference `cli/tui.js`.
- **`examples.md`** — TUI section header updated to `cli/tui.js`.

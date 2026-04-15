#!/usr/bin/env node

// Force the shipped TUI onto production React/Ink unless the caller
// explicitly opts into another environment for debugging.
process.env.NODE_ENV ??= "production";

const { syncBundledWorkspaceUiPackages } = await import("../src/sync-workspace-ui.js");
syncBundledWorkspaceUiPackages({ linkWorkspacePackages: true });

const { parseCliIntoEnv } = await import("../src/bootstrap-env.js");
const config = parseCliIntoEnv(process.argv.slice(2));
const { startTuiApp } = await import("../src/index.js");
await startTuiApp(config);

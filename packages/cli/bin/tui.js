#!/usr/bin/env node

// FR-027: `pilotswarm smoke <stamp> --profile <profile>`
// subcommand. Branches before any TUI/Ink boot so the smoke driver
// runs as a plain CLI without the React/Ink module graph being
// loaded. Keeps the TUI path untouched.
if (process.argv[2] === "smoke") {
    const { runSmoke } = await import("../src/smoke/cli.js");
    process.exit(await runSmoke(process.argv.slice(3)));
}

// Force the shipped TUI onto production React/Ink unless the caller
// explicitly opts into another environment for debugging.
process.env.NODE_ENV ??= "production";

const { syncBundledWorkspaceUiPackages } = await import("../src/sync-workspace-ui.js");
syncBundledWorkspaceUiPackages({ linkWorkspacePackages: true });

const { parseCliIntoEnv } = await import("../src/bootstrap-env.js");
const config = parseCliIntoEnv(process.argv.slice(2));
const { startTuiApp } = await import("../src/index.js");
await startTuiApp(config);

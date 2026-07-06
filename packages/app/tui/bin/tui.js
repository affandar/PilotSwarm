#!/usr/bin/env node

// Force the shipped TUI onto production React/Ink unless the caller
// explicitly opts into another environment for debugging.
process.env.NODE_ENV ??= "production";

const argv = process.argv.slice(2);
if (argv[0] === "auth") {
    const { runAuthCommand } = await import("../src/auth/cli.js");
    process.exitCode = await runAuthCommand(argv.slice(1)).catch((error) => {
        console.error(`[pilotswarm] ${error?.message || error}`);
        return 1;
    });
} else {
    const { parseCliIntoEnv } = await import("../src/bootstrap-env.js");
    const config = parseCliIntoEnv(argv);
    const { startTuiApp } = await import("../src/index.js");
    try {
        // startTuiApp exits the process on normal quit; a thrown error here is
        // a startup failure (e.g. Web API auth). Show it cleanly instead of an
        // unhandled-rejection stack trace — the Ink screen is not up yet.
        await startTuiApp(config);
    } catch (error) {
        console.error(`[pilotswarm] ${error?.message || error}`);
        process.exitCode = 1;
    }
}

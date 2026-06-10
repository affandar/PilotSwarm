// Vitest config — same framework as the rest of PilotSwarm (packages/sdk
// invokes the root workspace's vitest the same way).
//
// fileParallelism: false — the integration suites share one HorizonDB
// cluster; parallel suite files race on AGE/extension initialization
// ("tuple concurrently updated"), so files run sequentially (04 §7).
// Tests within a file are sequential by default, which the suites rely on.

import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.mjs"],
        fileParallelism: false,
        // Outcome-polled embedder tests legitimately take minutes
        // (charter: poll on observable outcomes with their own deadlines).
        testTimeout: 600_000,
        hookTimeout: 300_000,
    },
});

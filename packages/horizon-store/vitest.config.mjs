// Vitest config — same framework as the rest of PilotSwarm (packages/sdk
// invokes the root workspace's vitest the same way).
//
// Keep file-level parallelism enabled. Live HorizonDB tests should preserve
// throughput by default; handle preview-service connection churn with bounded
// pool sizing and retry hardening, not by silently serializing suites.

import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.mjs"],
        fileParallelism: true,
        // Outcome-polled embedder tests legitimately take minutes
        // (charter: poll on observable outcomes with their own deadlines).
        testTimeout: 600_000,
        hookTimeout: 300_000,
    },
});

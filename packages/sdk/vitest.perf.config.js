import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/perf/**/*.perf.test.js"],
        pool: "forks",
        fileParallelism: false,
        testTimeout: 300_000,
        hookTimeout: 120_000,
        env: {
            RUST_LOG: "error",
        },
    },
});

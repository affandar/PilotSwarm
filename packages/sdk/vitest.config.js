import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/local/**/*.test.js"],
        pool: "forks",
        maxWorkers: 16,
        fileParallelism: true,
        testTimeout: 300_000,
        hookTimeout: 120_000,
        env: {
            RUST_LOG: "error",
        },
    },
});

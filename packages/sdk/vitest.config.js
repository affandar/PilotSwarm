import os from "node:os";
import { defineConfig } from "vitest/config";

const availableWorkers = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
const configuredWorkers = Number(process.env.PS_TEST_MAX_WORKERS || "");
const maxWorkers = Number.isFinite(configuredWorkers) && configuredWorkers > 0
    ? configuredWorkers
    : Math.min(8, availableWorkers);

export default defineConfig({
    test: {
        include: ["test/local/**/*.test.js"],
        pool: "forks",
        maxWorkers,
        fileParallelism: true,
        testTimeout: 300_000,
        hookTimeout: 120_000,
        env: {
            RUST_LOG: "error",
        },
    },
});

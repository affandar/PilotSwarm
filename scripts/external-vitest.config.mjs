import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

const root = process.env.PILOTSWARM_EXTERNAL_TEST_ROOT;
if (!root) {
    throw new Error("PILOTSWARM_EXTERNAL_TEST_ROOT is required");
}

const availableWorkers = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
const configuredWorkers = Number(process.env.PS_TEST_MAX_WORKERS || "");
const maxWorkers = Number.isFinite(configuredWorkers) && configuredWorkers > 0
    ? configuredWorkers
    : Math.min(8, availableWorkers);

export default defineConfig({
    root: path.resolve(root),
    test: {
        include: ["**/*.test.{js,mjs,ts,mts}"],
        exclude: ["**/node_modules/**"],
        environment: "node",
        globals: true,
        pool: "forks",
        maxWorkers,
        fileParallelism: true,
        testTimeout: 300_000,
        hookTimeout: 120_000,
    },
});

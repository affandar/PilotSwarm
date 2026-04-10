import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const availableWorkers = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
const configuredWorkers = Number(process.env.PS_TEST_MAX_WORKERS || "");
const maxWorkers = Number.isFinite(configuredWorkers) && configuredWorkers > 0
    ? configuredWorkers
    : Math.min(8, availableWorkers);
const testModelProvidersPath = path.join(__dirname, "test/fixtures/model-providers.test.json");

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
            PS_MODEL_PROVIDERS_PATH: process.env.PS_MODEL_PROVIDERS_PATH || testModelProvidersPath,
        },
    },
});

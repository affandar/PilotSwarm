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
            // Cap per-worker Postgres pool sizes for the test fleet. Production
            // defaults (duroxide 10 + cms 3 + facts 3 = 16 conns/worker) are sized
            // for throughput, but integration suites run many forks in parallel
            // (maxWorkers above), and the restart-heavy suites (chaos/reliability)
            // transiently hold old + new workers plus standalone validation
            // catalogs at once. At full parallelism that peak blows past Postgres'
            // connection ceiling → "sorry, too many clients already". Tests are
            // low-throughput against isolated schemas, so small pools are ample and
            // keep worst-case demand (≈ forks × workers × pool) well under the
            // server limit. Override by exporting these before running if needed.
            DUROXIDE_PG_POOL_MAX: process.env.DUROXIDE_PG_POOL_MAX || "6",
            PILOTSWARM_CMS_PG_POOL_MAX: process.env.PILOTSWARM_CMS_PG_POOL_MAX || "2",
            PILOTSWARM_FACTS_PG_POOL_MAX: process.env.PILOTSWARM_FACTS_PG_POOL_MAX || "2",
        },
    },
});

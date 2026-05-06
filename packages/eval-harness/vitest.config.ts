import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testModelProvidersPath = path.join(
  __dirname,
  "../sdk/test/fixtures/model-providers.test.json",
);

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    // Eval samples default to 120s (sample.timeoutMs). Vitest must give the
    // runner room to enforce its own per-sample timeout *plus* setup/teardown
    // before killing the test. 180s = 120s sample default + 60s headroom.
    testTimeout: 180_000,
    hookTimeout: 60_000,
    env: {
      RUST_LOG: "error",
      PS_MODEL_PROVIDERS_PATH:
        process.env.PS_MODEL_PROVIDERS_PATH || testModelProvidersPath,
    },
  },
});

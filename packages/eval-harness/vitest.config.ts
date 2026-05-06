import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const testModelProvidersPath = path.join(
  __dirname,
  "../sdk/test/fixtures/model-providers.test.json",
);

// Auto-load monorepo-root `.env` so callers can run
//   `npx vitest run packages/eval-harness/test/*-live.test.ts`
// without the `env $(grep -v '^#' .env | xargs) …` shim. Existing
// process.env values always win — explicit shell exports remain
// authoritative. Lines are parsed with the same minimal grammar as
// dotenv: `KEY=VALUE`, optional surrounding quotes, `#` comments,
// blank lines ignored. We deliberately avoid pulling in the `dotenv`
// package to keep eval-harness deps lean.
function loadRepoEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(path.join(repoRoot, ".env"), "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) out[key] = value;
  }
  return out;
}

const repoEnv = loadRepoEnv();

// LIVE-suite parallelism discipline:
//
// Each LIVE test file spins up real `PilotSwarmWorker` instances that
// open their own Postgres connection pools. With vitest's default
// `fileParallelism: true`, multiple `*-live.test.ts` files run
// concurrently and we exhaust `max_connections` (observed: a single
// Postgres at max_connections=200 saturates with ~3 parallel live
// files, each holding an SDK pool + perf-concurrency holding many).
// The DB returns `53300 sorry, too many clients already` and every
// in-flight LiveDriver.run() fails as an infra error.
//
// Detect LIVE via either process.env or the just-loaded repoEnv (the
// shell wrapper exports LIVE=1 before invoking vitest, but we also
// support callers who set LIVE in the repo .env). When LIVE is on,
// force file-level serialization: parallel within-file `it()` is fine,
// parallel across files is not.
//
// Override via PS_EVAL_FILE_PARALLELISM=1 if you have a Postgres with
// genuinely large `max_connections` AND want the wallclock win.
const liveEnabled =
  (process.env.LIVE ?? repoEnv.LIVE ?? "0") !== "0" &&
  (process.env.LIVE ?? repoEnv.LIVE ?? "") !== "";
const forceFileParallel =
  (process.env.PS_EVAL_FILE_PARALLELISM ?? "") === "1";
const fileParallelism = forceFileParallel ? true : !liveEnabled;

// Timeout discipline:
//
//   * Default `testTimeout` (60s) applies to all unit/contract tests.
//     Unit tests should be deterministic and fast — a 60s ceiling catches
//     hangs without masking slow regressions.
//
//   * LIVE-gated tests (`*-live.test.ts`) carry their own per-it timeouts
//     derived from (max LiveDriver timeout × planned sequential cells)
//     plus setup/teardown headroom. See `test/*-live.test.ts` for the
//     explicit `it(name, fn, timeoutMs)` form on multi-trial / matrix
//     tests where the worst-case envelope exceeds 600s.
//
//   * `hookTimeout` (60s) bounds beforeAll/afterAll setup/cleanup.
//
// Why we DON'T use a single global testTimeout for LIVE:
// multi-trial and matrix LIVE tests run N sequential LLM calls,
// each capped at 240-300s. A single global timeout cannot bound
// these correctly without being either too tight (single-run tests
// timeout) or too loose (a stuck unit test wastes 10+ minutes).
// The right granularity is per-`it` for LIVE multi-cell tests.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    fileParallelism,
    setupFiles: ["./test/setup/patch-copilot-telemetry.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      ...repoEnv,
      RUST_LOG: process.env.RUST_LOG ?? repoEnv.RUST_LOG ?? "error",
      PS_MODEL_PROVIDERS_PATH:
        process.env.PS_MODEL_PROVIDERS_PATH ||
        repoEnv.PS_MODEL_PROVIDERS_PATH ||
        testModelProvidersPath,
    },
  },
});

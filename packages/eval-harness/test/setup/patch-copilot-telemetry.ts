// Workaround for an upstream bug in @github/copilot's bundled app.js:
//
//   TypeError: Cannot read properties of undefined (reading 'trim')
//     at TPn (...app.js:2510:17710)
//     at t.emitUserMessageSentimentTelemetry (...:2720:39632)
//     at t.runAgenticLoop (...:2732:933)
//     at async t.send (...:2728:3966)
//
// The bug is in the user-message sentiment telemetry path:
//
//   function TPn(t){
//     let {authInfo:e, source:r, userMessage:n, ...} = t;
//     return !e || r !== void 0 || n.trim().length === 0 || ... ? false : EJ(...);
//   }
//
// PilotSwarm's session.send() invokes the agentic loop which calls
// emitUserMessageSentimentTelemetry(undefined, undefined, ...) under
// some routing paths, so `n` is undefined and `n.trim()` throws BEFORE
// the model is ever called. The crash is not recoverable from the
// PilotSwarmJudgeClient side because it fires inside the Promise
// returned by session.send().
//
// We patch the single occurrence of `n.trim()` to `(n??"").trim()` so
// the function returns false (no telemetry) instead of throwing. The
// patch is idempotent: re-running on an already-patched file is a
// no-op. Safe across parallel vitest workers because the rewrite is
// atomic (write tmp + rename).
//
// Re-applies after every `npm ci` because node_modules is regenerated.
// Limitation acknowledged: this mutates a sibling package's installed
// JS. Acceptable as a test-only workaround until the upstream fix
// ships in a newer @github/copilot release.

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COPILOT_APP_PATH = resolve(
  __dirname,
  "../../../../node_modules/@github/copilot/app.js",
);

const BAD = "n.trim().length===0";
const FIXED = "(n??\"\").trim().length===0";

try {
  const src = readFileSync(COPILOT_APP_PATH, "utf8");
  if (src.includes(FIXED)) {
    // already patched
  } else if (src.includes(BAD)) {
    const patched = src.replace(BAD, FIXED);
    const tmp = `${COPILOT_APP_PATH}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, patched, "utf8");
    renameSync(tmp, COPILOT_APP_PATH);
    // eslint-disable-next-line no-console
    console.error(
      "[eval-harness] patched @github/copilot/app.js TPn telemetry crash workaround",
    );
  }
  // If neither marker is present the upstream layout has changed; don't
  // throw — the judge client still has its own session.error fallback
  // for benign post-response telemetry crashes (different code path).
} catch (err) {
  // Read/write failure (permissions, missing file) is non-fatal — log
  // and continue. Live judge tests will fail loudly with the original
  // error instead of being silently broken.
  // eslint-disable-next-line no-console
  console.error(
    `[eval-harness] copilot telemetry patch skipped: ${err instanceof Error ? err.message : String(err)}`,
  );
}

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(
  join(__dirname, "..", "build-windows-worker.ps1"),
  "utf8",
);

test("Windows worker builder exposes generic composition boundaries", () => {
  assert.match(script, /\[switch\]\$BaseOnly/);
  assert.match(script, /\[string\]\$WorkerBaseImage/);
  assert.match(
    script,
    /\$effectiveWorkerBase = if \(\$WorkerBaseImage\) \{ \$WorkerBaseImage \} else \{ \$baseImageRef \}/,
  );
  assert.match(
    script,
    /--build-arg',"WORKER_BASE_IMAGE=\$effectiveWorkerBase"/,
  );
  assert.ok(
    script.indexOf("if ($BaseOnly)") <
      script.indexOf("# --- Phase 0: compile the SDK"),
    "base-only mode must return before compiling or building the SDK layer",
  );
  assert.match(script, /Write-Output \$baseImageRef/);
  assert.match(script, /Write-Output \$workerRefs\[0\]/);
});

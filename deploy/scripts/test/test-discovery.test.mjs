// Guard: every *.test.mjs in deploy/scripts/test/ must be wired into the
// `test:deploy-scripts` script in root package.json. Catches the "orphaned
// test file" gap (test passes locally but never runs in CI / pre-deploy).
//
// Run individually:
//   node --test deploy/scripts/test/test-discovery.test.mjs
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");

test("every *.test.mjs in deploy/scripts/test is referenced by test:deploy-scripts", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const cmd = pkg.scripts["test:deploy-scripts"];
  assert.ok(cmd, "test:deploy-scripts script missing from package.json");

  const files = readdirSync(__dirname)
    .filter((f) => f.endsWith(".test.mjs"))
    .sort();

  const missing = files.filter((f) => !cmd.includes(`deploy/scripts/test/${f}`));
  assert.deepEqual(
    missing,
    [],
    `Orphaned test files (add to package.json#scripts.test:deploy-scripts): ${missing.join(", ")}`,
  );
});

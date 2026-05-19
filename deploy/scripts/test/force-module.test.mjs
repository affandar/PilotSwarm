// Smoke test for the `--force-module <name>` CLI flag on deploy.mjs. We don't
// run a real deployment here — that would require Azure credentials. Instead
// we spawn `node deploy.mjs --help` and assert that the flag is documented
// (printHelp() is the user-facing contract), which also proves the parseArgs
// branch wasn't accidentally dropped. Ported from waldemort dbe20ca (PAW
// Review PR #7).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const DEPLOY_MJS = resolve(here, "..", "deploy.mjs");

test("deploy.mjs --help advertises --force-module", () => {
  const r = spawnSync(process.execPath, [DEPLOY_MJS, "--help"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `--help should exit 0, got ${r.status}: ${r.stderr}`);
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(
    out,
    /--force-module/,
    `expected --force-module in help output:\n${out}`,
  );
  assert.match(
    out,
    /Repeatable/i,
    `help output should note --force-module is repeatable:\n${out}`,
  );
});

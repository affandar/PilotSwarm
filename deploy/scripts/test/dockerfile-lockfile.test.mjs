// Regression test for FR-010 + FR-011 (SC-006): the portal and worker image
// builds must use the lockfile-enforcing install mode (`npm ci`) so rebuilds
// from a given source revision are byte-reproducible.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function readDockerfile(name) {
  return readFileSync(join(REPO_ROOT, "deploy", name), "utf8");
}

// Strip `# ...` comment lines so we only flag the install verb when it
// appears in an executable RUN line.
function stripComments(src) {
  return src
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

for (const file of ["Dockerfile.portal", "Dockerfile.worker"]) {
  test(`${file} installs deps with npm ci (lockfile-enforcing)`, () => {
    const src = stripComments(readDockerfile(file));
    assert.match(
      src,
      /RUN\s+npm\s+ci\b/,
      `${file} must use 'npm ci' (lockfile-enforcing) for byte-reproducible rebuilds`,
    );
    assert.equal(
      /RUN\s+npm\s+install\b/.test(src),
      false,
      `${file} must NOT use 'npm install' on dependencies — that drifts from package-lock.json on rebuild`,
    );
  });
}

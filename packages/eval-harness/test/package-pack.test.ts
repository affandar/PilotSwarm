import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgDir = path.resolve(__dirname, "..");

// We run `npm pack --dry-run --json --ignore-scripts` which:
//   - --dry-run: does not produce a tarball, only reports what would be packed
//   - --json: emits a JSON array of pack manifests on stdout
//   - --ignore-scripts: skips lifecycle scripts (notably `prepack` => `npm run build`)
// Skipping prepack is required so this test never triggers a build during vitest.
// dist/ is expected to exist on disk from prior baseline builds; npm pack's dry-run
// expands the `files` glob against the working tree.

interface PackFile {
  path: string;
  size?: number;
  mode?: number;
}

interface PackManifest {
  name: string;
  version: string;
  files: PackFile[];
}

function getPackedFiles(): string[] {
  const out = execSync("npm pack --dry-run --json --ignore-scripts", {
    cwd: pkgDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const manifests = JSON.parse(out) as PackManifest[];
  expect(manifests.length).toBeGreaterThan(0);
  return manifests[0].files.map((f) => f.path);
}

describe("eval-harness package pack manifest", () => {
  it("includes dist/index.js and dist/index.d.ts", () => {
    const files = getPackedFiles();
    expect(files).toContain("dist/index.js");
    expect(files).toContain("dist/index.d.ts");
  });

  it("includes at least one file under datasets/", () => {
    const files = getPackedFiles();
    const datasetFiles = files.filter((f) => f.startsWith("datasets/"));
    expect(datasetFiles.length).toBeGreaterThan(0);
  });

  it("includes README.md and LICENSE", () => {
    const files = getPackedFiles();
    expect(files).toContain("README.md");
    expect(files).toContain("LICENSE");
  });

  it("excludes docs/reviews/, test/, and src/**/*.ts", () => {
    const files = getPackedFiles();
    const forbidden = files.filter(
      (f) =>
        f.startsWith("docs/reviews/") ||
        f.startsWith("test/") ||
        (f.startsWith("src/") && f.endsWith(".ts")),
    );
    expect(forbidden).toEqual([]);
  });
});

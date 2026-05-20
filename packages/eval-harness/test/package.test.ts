import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

describe("package API", () => {
  it("exports the Wave A public API names", () => {
    expect(api).toHaveProperty("discoverScenarios");
    expect(api).toHaveProperty("runScenario");
    expect(api).toHaveProperty("runManifest");
    expect(api).toHaveProperty("registerScenarioKind");
    expect(api).toHaveProperty("registerCheckType");
    expect(api).toHaveProperty("registerTool");
    expect(api).toHaveProperty("registerDriver");
    expect(api).toHaveProperty("registerReporter");
  });

  it("has build, prepack, and root workspace wiring for npm packing", async () => {
    const [pkgRaw, rootPkgRaw, lockRaw, license] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile("../../package.json", "utf8"),
      readFile("../../package-lock.json", "utf8"),
      readFile("LICENSE", "utf8"),
    ]);

    const pkg = JSON.parse(pkgRaw) as {
      private?: boolean;
      scripts?: Record<string, string>;
      files?: string[];
    };
    const rootPkg = JSON.parse(rootPkgRaw) as { scripts?: Record<string, string> };
    const lock = JSON.parse(lockRaw) as { packages?: Record<string, unknown> };

    expect(pkg.private).toBe(false);
    expect(pkg.scripts?.build).toContain("tsc");
    expect(pkg.scripts?.prepack).toBe("npm run build");
    expect(pkg.files).toContain("dist/**/*");
    expect(pkg.files).toContain("runs/**/*");
    expect(pkg.files).toContain("scenarios/**/*");
    expect(pkg.files).toContain("LICENSE");
    expect(license).toContain("MIT License");

    expect(rootPkg.scripts?.build).toContain("--workspace=pilotswarm-eval-harness");
    expect(lock.packages).toHaveProperty("packages/eval-harness");
    expect(lock.packages).toHaveProperty("node_modules/pilotswarm-eval-harness");
  });
});

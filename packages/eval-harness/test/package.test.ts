import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

describe("package API", () => {
  it("exports the v0 public API names", () => {
    const expectedRuntimeExports = [
      "discoverScenarios",
      "runScenario",
      "runManifest",
      "registerScenarioKind",
      "registerCheckType",
      "registerTool",
      "registerDriver",
      "registerReporter",
    ];
    for (const name of expectedRuntimeExports) expect(api).toHaveProperty(name);
  });

  it("re-exports registration types from the public entrypoint", async () => {
    const source = await readFile("src/index.ts", "utf8");
    const expectedTypeExports = [
      "Reporter",
      "Driver",
      "ToolRegistration",
      "ScenarioKindRegistration",
    ];
    for (const name of expectedTypeExports) expect(source).toContain(name);
  });

  it("has buildable package metadata for npm packing", async () => {
    const [pkgRaw, license] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile("LICENSE", "utf8"),
    ]);

    const pkg = JSON.parse(pkgRaw) as {
      private?: boolean;
      scripts?: Record<string, string>;
      files?: string[];
      main?: string;
      types?: string;
      exports?: Record<string, unknown>;
    };
    expect(pkg.private).toBe(false);
    expect(pkg.scripts?.build).toContain("tsc");
    expect(pkg.scripts?.prepack).toBe("npm run build");
    expect(pkg.main).toBe("./dist/src/index.js");
    expect(pkg.types).toBe("./dist/src/index.d.ts");
    expect(pkg.exports).toHaveProperty(".");
    expect(pkg.files).toContain("dist/**/*");
    expect(pkg.files).toContain("runs/**/*");
    expect(pkg.files).toContain("scenarios/**/*");
    expect(pkg.files).toContain("LICENSE");
    expect(license).toContain("MIT License");
  });
});

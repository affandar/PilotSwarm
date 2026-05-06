import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvalTask, loadEvalTaskFromDir } from "../src/loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "fixtures");

describe("loadEvalTask", () => {
  it("loads a valid JSON fixture file and returns an EvalTask", () => {
    const task = loadEvalTask(resolve(FIXTURES, "test-fixture.json"));
    expect(task.id).toBe("test-fixture");
    expect(task.name).toBe("Test Fixture");
    expect(task.version).toBe("1.0.0");
    expect(task.samples).toHaveLength(1);
    expect(task.samples[0].id).toBe("test.sample.1");
  });

  it("validates with zod and applies default values (match defaults to subset)", () => {
    const task = loadEvalTask(resolve(FIXTURES, "test-fixture.json"));
    // match default
    expect(task.samples[0].expected.toolCalls?.[0].match).toBe("subset");
    // toolSequence default
    expect(task.samples[0].expected.toolSequence).toBe("unordered");
    // timeoutMs default
    expect(task.samples[0].timeoutMs).toBe(120000);
  });

  it("throws on missing required fields", () => {
    expect(() => loadEvalTask(resolve(FIXTURES, "test-invalid.json"))).toThrow();
  });

  it("throws on invalid schemaVersion", () => {
    // test-invalid.json has schemaVersion: 2
    expect(() => loadEvalTask(resolve(FIXTURES, "test-invalid.json"))).toThrow(
      /schemaVersion|invalid/i,
    );
  });

  it("throws on file not found", () => {
    expect(() => loadEvalTask(resolve(FIXTURES, "does-not-exist.json"))).toThrow();
  });
});

describe("loadEvalTaskFromDir", () => {
  it("loads all JSON files in the directory", () => {
    const tasks = loadEvalTaskFromDir(resolve(FIXTURES, "valid-dir"));
    expect(tasks).toHaveLength(2);
    const ids = tasks.map((t) => t.id).sort();
    expect(ids).toEqual(["valid-a", "valid-b"]);
  });

  it("skips non-JSON files (e.g., README.md)", () => {
    const tasks = loadEvalTaskFromDir(resolve(FIXTURES, "valid-dir"));
    // All results should be validated EvalTask objects
    for (const task of tasks) {
      expect(task.schemaVersion).toBe(1);
      expect(typeof task.id).toBe("string");
    }
  });

  it("returns an empty array for a directory with no JSON files", () => {
    // Use __tests__ itself which has no top-level JSON files
    // Actually, __tests__ has no JSON at root (fixtures/ is a subdir). Let's verify.
    // Use the node_modules-less approach: point at a known empty-of-json dir.
    // Since our loader should not recurse, pointing at __tests__ root dir should yield 0
    // provided we only check the immediate directory.
    const tasks = loadEvalTaskFromDir(__dirname);
    // __dirname = .../__tests__ — contains .ts files only, no .json at that level.
    expect(tasks).toEqual([]);
  });
});

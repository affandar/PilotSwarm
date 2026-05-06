import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadEvalTask,
  loadEvalTaskFromDir,
  loadTrajectoryTask,
  loadTrajectoryTaskFromDir,
} from "../src/loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "fixtures");
const DATASETS = resolve(__dirname, "../datasets");

describe("loadEvalTask", () => {
  it("loads a valid JSON fixture and applies zod defaults", () => {
    const task = loadEvalTask(resolve(FIXTURES, "test-fixture.json"));
    expect(task.id).toBe("test-fixture");
    expect(task.samples).toHaveLength(1);
    expect(task.samples[0].expected.toolCalls?.[0].match).toBe("subset");
    expect(task.samples[0].expected.toolSequence).toBe("unordered");
    expect(task.samples[0].timeoutMs).toBe(120000);
  });

  it("throws on missing required fields / invalid schemaVersion", () => {
    expect(() => loadEvalTask(resolve(FIXTURES, "test-invalid.json"))).toThrow(
      /schemaVersion|invalid|required/i,
    );
  });

  it("throws a clear error when a sample has empty expected criteria", () => {
    expect(() => loadEvalTask(resolve(FIXTURES, "test-empty-expected.json"))).toThrow(
      /no expected criteria/i,
    );
  });
});

describe("loadEvalTaskFromDir", () => {
  it("loads all JSON files in the directory", () => {
    const tasks = loadEvalTaskFromDir(resolve(FIXTURES, "valid-dir"));
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.id).sort()).toEqual(["valid-a", "valid-b"]);
  });

  it("returns an empty array for a directory with no JSON files", () => {
    expect(loadEvalTaskFromDir(__dirname)).toEqual([]);
  });

  it("skips trajectory datasets when loading EvalTasks (mixed-schema dir)", () => {
    const tasks = loadEvalTaskFromDir(DATASETS);
    expect(tasks.length).toBeGreaterThan(0);
    const ids = tasks.map((t) => t.id);
    expect(ids).not.toContain("multi-turn-scenarios");
    expect(ids).toContain("tool-call-correctness");
  });

  it("invokes onSkip callback for skipped files", () => {
    const skips: Array<{ path: string; reason: string }> = [];
    loadEvalTaskFromDir(DATASETS, {
      onSkip: (path, reason) => skips.push({ path, reason }),
    } as never);
    const skip = skips.find((s) => s.path.includes("multi-turn-scenarios"));
    expect(skip).toBeDefined();
    expect(skip!.reason).toMatch(/trajectory/i);
  });
});

describe("loadTrajectoryTask", () => {
  it("loads a valid trajectory dataset", () => {
    const task = loadTrajectoryTask(resolve(DATASETS, "multi-turn-scenarios.v1.json"));
    expect(task!.id).toBe("multi-turn-scenarios");
    expect(task!.samples.length).toBeGreaterThan(0);
  });

  it("skips non-runnable trajectory datasets in live mode", () => {
    const messages: string[] = [];
    const task = loadTrajectoryTask(
      resolve(FIXTURES, "trajectory-non-runnable.json"),
      { mode: "live", onSkip: (m) => messages.push(m) },
    );
    expect(task).toBeUndefined();
    expect(messages[0]).toMatch(/skipping non-runnable dataset/i);
  });
});

describe("loadTrajectoryTaskFromDir", () => {
  it("loads trajectory tasks from a directory", () => {
    const tasks = loadTrajectoryTaskFromDir(resolve(FIXTURES, "trajectory-dir"));
    expect(tasks.map((task) => task.id)).toEqual(["trajectory-valid"]);
  });

  it("returns only trajectory tasks when scanning mixed-schema dir", () => {
    const tasks = loadTrajectoryTaskFromDir(DATASETS);
    expect(tasks.length).toBeGreaterThan(0);
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain("multi-turn-scenarios");
    expect(ids).not.toContain("tool-call-correctness");
  });
});

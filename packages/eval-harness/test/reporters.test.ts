import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_EVAL_DRIVER, DEFAULT_EVAL_MAX_CELLS, DEFAULT_EVAL_TIMEOUT_MS } from "../src/defaults.js";
import { runManifest } from "../src/index.js";

describe("reporters", () => {
  it("persists materialized effective run config defaults in report artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-harness-effective-config-"));
    const reportsDir = join(dir, "reports");
    const manifestPath = join(dir, "scenarios.jsonl");
    const configPath = join(dir, "config.json");

    await writeFile(manifestPath, '{"schemaVersion":1}\n');
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      id: "report.effective-config",
      scenarios: "./scenarios.jsonl",
      reporters: ["markdown", "jsonl"],
    }));

    const result = await runManifest({ configPath, reportsDir });

    const expectedDefaults = {
      models: [],
      trials: 1,
      isolation: "shared-worker",
      concurrent: 1,
      driver: DEFAULT_EVAL_DRIVER,
      timeoutMs: DEFAULT_EVAL_TIMEOUT_MS,
      maxCells: DEFAULT_EVAL_MAX_CELLS,
    };
    expect(result.configuration.effectiveRunConfig.defaults).toMatchObject(expectedDefaults);
    expect(result.configuration.effectiveRunConfig.output).toMatchObject({ reportsDir });
    expect(result.configuration.effectiveRunConfig.requirements).toMatchObject({ onUnsupported: "error" });

    const runDirs = await readdir(reportsDir);
    expect(runDirs).toHaveLength(1);
    const runConfig = JSON.parse(await readFile(join(reportsDir, runDirs[0] ?? "", "run-config.json"), "utf8")) as Record<string, { [key: string]: unknown }>;
    expect(runConfig.configuration.effectiveRunConfig.defaults).toMatchObject(expectedDefaults);
    expect(runConfig.configuration.effectiveRunConfig.output).toMatchObject({ reportsDir });
    expect(runConfig.configuration.effectiveRunConfig.requirements).toMatchObject({ onUnsupported: "error" });
  });

  it("does not materialize a fake model override for live configs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-harness-live-model-default-"));
    const reportsDir = join(dir, "reports");
    const manifestPath = join(dir, "scenarios.jsonl");
    const configPath = join(dir, "config.json");

    await writeFile(manifestPath, '{"schemaVersion":1}\n');
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      id: "report.live-default-model",
      scenarios: "./scenarios.jsonl",
      defaults: { driver: "live" },
      reporters: ["jsonl"],
      output: { reportsDir },
    }));

    const result = await runManifest({ configPath });

    expect(result.configuration.effectiveRunConfig.defaults).toMatchObject({
      driver: "live",
      models: [],
    });
    expect(JSON.stringify(result.configuration.effectiveRunConfig)).not.toContain("fake-model");
  });

  it("redacts secret-like passthrough run config keys in results and artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-harness-redacted-config-"));
    const reportsDir = join(dir, "reports");
    const manifestPath = join(dir, "scenarios.jsonl");
    const configPath = join(dir, "config.json");

    await writeFile(manifestPath, '{"schemaVersion":1}\n');
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      id: "report.redacted-config",
      scenarios: "./scenarios.jsonl",
      reporters: ["jsonl"],
      output: { reportsDir },
      openaiApiKey: "openai-secret",
      clientSecret: "client-secret",
      authToken: "auth-token",
      "bearer-token": "bearer-secret",
      provider: { providerApiKey: "nested-secret" },
    }));

    const result = await runManifest({ configPath });

    const returnedConfig = JSON.stringify(result.configuration.effectiveRunConfig);
    expect(returnedConfig).not.toContain("openai-secret");
    expect(returnedConfig).not.toContain("client-secret");
    expect(returnedConfig).not.toContain("auth-token");
    expect(returnedConfig).not.toContain("bearer-secret");
    expect(returnedConfig).not.toContain("nested-secret");
    expect(returnedConfig).toContain("[redacted]");

    const runDirs = await readdir(reportsDir);
    expect(runDirs).toHaveLength(1);
    const runConfig = await readFile(join(reportsDir, runDirs[0] ?? "", "run-config.json"), "utf8");
    expect(runConfig).not.toContain("openai-secret");
    expect(runConfig).not.toContain("client-secret");
    expect(runConfig).not.toContain("auth-token");
    expect(runConfig).not.toContain("bearer-secret");
    expect(runConfig).not.toContain("nested-secret");
    expect(runConfig).toContain("[redacted]");
  });

  it("stores an organized report bundle with human and machine entry points", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-harness-report-bundle-"));
    const reportsDir = join(dir, "reports");
    const scenarioPath = join(dir, "sample.scenario.json");
    const manifestPath = join(dir, "scenarios.jsonl");
    const configPath = join(dir, "config.json");

    await writeFile(scenarioPath, JSON.stringify({
      schemaVersion: 1,
      kind: "single-turn",
      id: "report.bundle.sample",
      description: "Report bundle sample.",
      input: { prompt: "Say bundle." },
      checks: [
        { type: "response-contains", any: ["bundle"] },
        { type: "llm-judge", rubric: "Confirm the response completed the report bundle task.", budgetUsd: 0.01 }
      ],
      metadata: {
        fake: {
          finalResponse: "bundle complete",
          cmsEvents: [
            {
              type: "assistant.message",
              metadata: {
                content: "visible",
                inputTokens: 12,
                authorization: "Bearer token-that-should-not-be-saved",
                encryptedContent: "ciphertext-that-should-not-be-saved",
                reasoningOpaque: "opaque-reasoning-payload",
                apiCallId: "provider-api-call-id",
                quotaSnapshots: { premium: { remainingPercentage: 100 } },
              },
            },
          ],
        },
      },
    }));
    await writeFile(manifestPath, '{"schemaVersion":1}\n{"include":"sample.scenario.json"}\n');
    const configReportsDir = join(dir, "config-reports");
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      id: "report.bundle",
      scenarios: "./scenarios.jsonl",
      defaults: { driver: "live" },
      reporters: ["console"],
      output: { reportsDir: configReportsDir },
    }));

    const result = await runManifest({ configPath, fake: true, reporters: ["markdown", "jsonl"], reportsDir });

    const runDirs = await readdir(reportsDir);
    expect(runDirs).toHaveLength(1);
    expect(runDirs[0]).toMatch(/^\d{8}-\d{6}-report-bundle$/);

    const runDir = join(reportsDir, runDirs[0] ?? "");
    const report = await readFile(join(runDir, "REPORT.md"), "utf8");
    const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf8")) as Record<string, unknown>;
    const runConfig = JSON.parse(await readFile(join(runDir, "run-config.json"), "utf8")) as Record<string, { [key: string]: unknown }>;
    const jsonl = await readFile(join(runDir, "machine", "results.jsonl"), "utf8");
    const scenarioReadme = await readFile(join(runDir, "scenarios", "report-bundle-sample", "README.md"), "utf8");
    const scenarioResult = JSON.parse(await readFile(join(runDir, "scenarios", "report-bundle-sample", "result.json"), "utf8")) as Record<string, unknown>;

    expect(report).toContain("# Eval Run report.bundle");
    expect(report).toContain("## How To Read This");
    expect(report).toContain("[report.bundle.sample](scenarios/report-bundle-sample/README.md)");
    expect(report).toContain("| Discovered scenario definitions | 1 |");
    expect(report).toContain("| Execution cells | 1 |");
    expect(summary).toMatchObject({ runId: "report.bundle", passed: 1, failed: 0, infraErrors: 0 });
    expect((summary.totals as Record<string, unknown>).discoveredScenarios).toBe(1);
    expect((summary.totals as Record<string, unknown>).executionCells).toBe(1);
    expect(result.configuration.discoveredScenarioCount).toBe(1);
    expect(result.configuration.executionCellCount).toBe(1);
    expect(result.configuration.effectiveRunConfig.defaults).toMatchObject({ driver: "fake" });
    expect(result.configuration.effectiveRunConfig.output).toMatchObject({ reportsDir });
    expect(result.configuration.effectiveRunConfig.requirements).toMatchObject({ onUnsupported: "skip" });
    expect(result.configuration.cliOverrides).toMatchObject({
      fake: true,
      reporters: ["markdown", "jsonl"],
      reportsDir,
    });
    expect(runConfig.configuration.effectiveRunConfig.defaults).toMatchObject({ driver: "fake" });
    expect(runConfig.configuration.effectiveRunConfig.output).toMatchObject({ reportsDir });
    expect(runConfig.configuration.cliOverrides).toMatchObject({
      fake: true,
      reporters: ["markdown", "jsonl"],
      reportsDir,
    });
    expect(jsonl).toContain('"scenarioId":"report.bundle.sample"');
    expect(scenarioReadme).toContain("# report.bundle.sample");
    expect(scenarioReadme).toContain("## LLM Judge");
    expect(scenarioReadme).toContain("| Verdict | PASSED |");
    expect(scenarioReadme).toContain("#### Reason");
    expect(scenarioReadme).toContain("Deterministic local judge found completion language");
    expect(scenarioResult).toMatchObject({ scenarioId: "report.bundle.sample", passed: true });
    expect(JSON.stringify(scenarioResult)).not.toContain("ciphertext-that-should-not-be-saved");
    expect(JSON.stringify(scenarioResult)).not.toContain("opaque-reasoning-payload");
    expect(JSON.stringify(scenarioResult)).not.toContain("provider-api-call-id");
    expect(JSON.stringify(scenarioResult)).not.toContain("token-that-should-not-be-saved");
    expect(JSON.stringify(scenarioResult)).not.toContain("encryptedContent");
    expect(JSON.stringify(scenarioResult)).not.toContain("reasoningOpaque");
    expect(JSON.stringify(scenarioResult)).not.toContain("apiCallId");
    expect(JSON.stringify(scenarioResult)).not.toContain("quotaSnapshots");
    expect(JSON.stringify(scenarioResult)).toContain('"inputTokens":12');
    expect(JSON.stringify(scenarioResult)).toContain("[redacted]");
  });

  it("keeps skipped scenarios out of failure triage while reporting skip status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-harness-report-skipped-"));
    const reportsDir = join(dir, "reports");
    const scenarioPath = join(dir, "live-required.scenario.json");
    const manifestPath = join(dir, "scenarios.jsonl");
    const configPath = join(dir, "config.json");

    await writeFile(scenarioPath, JSON.stringify({
      schemaVersion: 1,
      kind: "single-turn",
      id: "report.skip.live-required",
      description: "Live-required scenario skipped by fake reporter run.",
      requirements: { live: true },
      input: { prompt: "This should not run with fake." },
      checks: [{ type: "response-contains", any: ["unreachable"] }]
    }));
    await writeFile(manifestPath, '{"schemaVersion":1}\n{"include":"live-required.scenario.json"}\n');
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      id: "report.skip",
      scenarios: "./scenarios.jsonl",
      defaults: { driver: "fake" },
      requirements: { onUnsupported: "skip" },
      reporters: ["markdown"],
      output: { reportsDir },
    }));

    await runManifest({ configPath, fake: true });

    const runDirs = await readdir(reportsDir);
    expect(runDirs).toHaveLength(1);
    const report = await readFile(join(reportsDir, runDirs[0] ?? "", "REPORT.md"), "utf8");
    const failureTriage = report.slice(
      report.indexOf("## Failure Triage"),
      report.indexOf("## Scenario Index"),
    );

    expect(report).toContain("| Skipped | 1 |");
    expect(report).toContain("| [report.skip.live-required]");
    expect(report).toContain(" | SKIP | ");
    expect(failureTriage).toContain("No failing scenarios.");
    expect(failureTriage).not.toContain("report.skip.live-required");
  });
});

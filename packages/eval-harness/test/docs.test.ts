import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Wave C docs and builder template", () => {
  it("documents schema, plugin, and downstream surfaces", async () => {
    const [schema, plugins, downstream, quickstart, troubleshooting, readme] = await Promise.all([
      readFile("docs/SCHEMA.md", "utf8"),
      readFile("docs/PLUGINS.md", "utf8"),
      readFile("docs/DOWNSTREAM-GUIDE.md", "utf8"),
      readFile("docs/QUICKSTART.md", "utf8"),
      readFile("docs/TROUBLESHOOTING.md", "utf8"),
      readFile("README.md", "utf8"),
    ]);

    expect(schema).toContain("Scenario Kinds");
    expect(schema).toContain("Check Types");
    expect(plugins).toContain("registerCheckType");
    expect(plugins).toContain("--require");
    expect(downstream).toContain("Recommended Layout");
    expect(downstream).toContain("--fake");
    expect(quickstart).toContain("Eval Harness Quickstart");
    expect(quickstart).toContain("REPORT.md");
    expect(troubleshooting).toContain("Exit Code 2");
    expect(troubleshooting).toContain("No Report Files Were Written");
    expect(readme).toContain("pilotswarm-eval-harness");
    expect(readme).toContain("Fastest Path");
  });

  it("documents the implemented run-config, manifest, and scenario hierarchy", async () => {
    const [schema, quickstart, downstream, readme] = await Promise.all([
      readFile("docs/SCHEMA.md", "utf8"),
      readFile("docs/QUICKSTART.md", "utf8"),
      readFile("docs/DOWNSTREAM-GUIDE.md", "utf8"),
      readFile("README.md", "utf8"),
    ]);
    const docs = [schema, quickstart, downstream, readme].join("\n");

    expect(schema).toContain("Run config -> manifest -> scenario config");
    expect(schema).toContain("CLI flags override run config fields only; they never rewrite scenario config.");
    expect(schema).toContain("Manifest overrides may only add tags.");
    expect(schema).toContain("Non-tag behavior overrides are rejected.");
    expect(schema).toContain("Run config owns driver/live-vs-fake, models, trials, concurrency, default isolation, reporters/output, budgets, LLMJudge provider/model/run prompt/default coverage, and requirements.onUnsupported.");
    expect(schema).toContain("llmJudge.applyTo");
    expect(schema).toContain("llmJudge.defaultCheck");
    expect(schema).toContain("Bundled production configs set `llmJudge.applyTo: \"all\"`");
    expect(schema).toContain("Scenario config owns prompt, turn, check, and tool semantics, requirements.live, requirements.isolation, promptOverrides, runs.timeoutMs, runs.maxCells, and scenario-specific judge rubrics/checks.");
    expect(schema).toContain("## Managed Live Chaos");
    expect(schema).toContain("The standalone `chaos` driver is diagnostic only");

    expect(docs).toContain("packages/eval-harness/bin/run-eval.sh --run=smoke --fake");
    expect(docs).toContain("packages/eval-harness/bin/run-eval.sh --run=smoke");
    expect(docs).toContain("packages/eval-harness/bin/run-eval.sh --run=all");
    expect(docs).toContain("npm exec run-eval -- --config=eval/runs/smoke/config.json");
    expect(docs).toContain("Default bundled runs are live");
    expect(docs).toContain("`--fake` is the explicit preflight path");

    expect(schema).not.toContain("path.overrides are applied to `scenario.runs`");
    expect(schema).not.toContain('"overrides":{"driver":"fake"');
    expect(schema).not.toContain("Scenario `runs` values override run-config `defaults`");
  });

  it("documents report artifacts and LLMJudge prompt layering", async () => {
    const [schema, readme, quickstart] = await Promise.all([
      readFile("docs/SCHEMA.md", "utf8"),
      readFile("README.md", "utf8"),
      readFile("docs/QUICKSTART.md", "utf8"),
    ]);
    const docs = [schema, readme, quickstart].join("\n");

    expect(docs).toContain("run-config.json");
    expect(docs).toContain("effective config after CLI run-level overrides");
    expect(docs).toContain("discovered scenario definitions");
    expect(docs).toContain("execution cells");
    expect(docs).toContain("fixed PilotSwarm harness prefix/system context remains stable");
    expect(docs).toContain("run config can add global judge instructions");
    expect(docs).toContain("scenario checks can add rubric/check-specific guidance");
    expect(docs).toContain("reason, evidence, and issues before verdict and confidence");
    expect(docs).toContain("No numeric score or pass threshold");
  });

  it("uses production-grade PilotSwarm examples instead of toy math examples", async () => {
    const [schema, readme] = await Promise.all([
      readFile("docs/SCHEMA.md", "utf8"),
      readFile("README.md", "utf8"),
    ]);
    const docs = [schema, readme].join("\n");

    expect(docs).toContain("incident drain runbook");
    expect(docs).toContain("session.wait_started");
    expect(docs).toContain("session.hydrated");
    expect(docs).not.toContain("math.add.basic");
    expect(docs).not.toContain("Add 17 and 25");
  });

  it("links the implemented eval-harness proposal", async () => {
    const [proposal, proposalIndex] = await Promise.all([
      readFile("../../docs/proposals-impl/eval-harness.md", "utf8"),
      readFile("../../docs/proposals-impl/README.md", "utf8"),
    ]);

    expect(proposal).toContain("# Eval Harness");
    expect(proposal).toContain("Implemented status");
    expect(proposal).toContain("Run config -> manifest -> scenario config");
    expect(proposalIndex).toContain("[Eval Harness](./eval-harness.md)");
  });

  it("ships the downstream builder eval-harness template", async () => {
    const [skill, readme, plugin] = await Promise.all([
      readFile("../../templates/builder-agents/skills/eval-harness/SKILL.md", "utf8"),
      readFile("../../templates/builder-agents/README.md", "utf8"),
      readFile("../../templates/builder-agents/skills/eval-harness/eval-plugins.js", "utf8"),
    ]);

    expect(skill).toContain("PilotSwarm Eval Harness Builder Skill");
    expect(readme).toContain("eval-harness");
    expect(readme).toContain("pilotswarm-eval-harness");
    expect(skill).toContain("Run config -> manifest -> scenario config");
    expect(skill).toContain("npm exec run-eval -- --config=eval/runs/smoke/config.json --fake --require=eval/eval-plugins.js");
    expect(readme).toContain("Default bundled runs are live");
    expect(readme).not.toContain("- `eval-harness` - adds app-local eval scenarios, plugin checks/tools, and run plans for `pilotswarm-eval-harness`");
    expect(readme).toContain("npm exec run-eval -- --config=eval/runs/smoke/config.json --fake --require=eval/eval-plugins.js");
    expect(readme).toContain("npm exec run-eval -- --config=eval/runs/smoke/config.json --require=eval/eval-plugins.js");
    expect(plugin).toContain("schema: z.object");
    expect(plugin).toContain("handler: async (args)");
  });

  it("keeps the builder smoke run live by default", async () => {
    const raw = await readFile("../../templates/builder-agents/skills/eval-harness/runs/smoke/config.json", "utf8");
    const config = JSON.parse(raw) as {
      defaults?: { driver?: string };
      llmJudge?: { enabled?: boolean; applyTo?: string; defaultCheck?: { rubric?: string } };
    };

    expect(config.defaults?.driver).toBe("live");
    expect(config.llmJudge?.enabled).toBe(true);
    expect(config.llmJudge?.applyTo).toBe("all");
    expect(config.llmJudge?.defaultCheck?.rubric).toContain("CMS/session evidence");
  });
});

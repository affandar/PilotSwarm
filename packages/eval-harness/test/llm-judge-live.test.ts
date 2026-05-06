// LLM-judge LIVE — gated by LIVE=1 + LIVE_JUDGE=1. Runs a real PilotSwarm
// sample, feeds the actual final response/trace to LLMJudgeGrader with a
// real judge client, asserts criterion scores, budget accounting, and
// cross-judge agreement.

import { describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveDriver } from "../src/drivers/live-driver.js";
import { EvalRunner } from "../src/runner.js";
import { LLMJudgeGrader } from "../src/graders/llm-judge.js";
import { OpenAIJudgeClient } from "../src/graders/openai-judge-client.js";
import { PilotSwarmJudgeClient } from "../src/graders/pilotswarm-judge-client.js";
import { ModelProviderRegistry } from "pilotswarm-sdk";
import { loadEvalTask } from "../src/loader.js";
import { makeRubric } from "./fixtures/builders.js";
import { makeLiveJudgeClient } from "./helpers/judge-client-helper.js";
import type { JudgeClient } from "../src/graders/judge-types.js";
import fs from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("LLMJudgeGrader LIVE", () => {
  const run = process.env.LIVE === "1" && process.env.LIVE_JUDGE === "1" ? it : it.skip;

  run("judges real PilotSwarm responses with calibrated rubric", async () => {
    const driver = new LiveDriver({ timeout: 300_000 });
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples[0]!;
    const runner = new EvalRunner({ driver, runId: "live-llm-judge" });
    const runResult = await runner.runTask({ ...dataset, samples: [sample] });
    const observed = runResult.cases[0]!.observed;

    const sel = makeLiveJudgeClient();
    expect(sel, "no judge client could be constructed (set OPENAI_API_KEY or GITHUB_TOKEN+model providers)").toBeTruthy();
    const client = sel!.client;
    const grader = new LLMJudgeGrader({
      client,
      rubric: makeRubric({
        criteria: [
          {
            id: "correctness",
            description:
              "Did the assistant correctly compute the requested arithmetic and convey the answer?",
            scale: { min: 0, max: 1 },
            passThreshold: 0.5,
          },
        ],
      }),
      budgetUsd: 1,
    });
    const judged = await grader.grade("Was the answer correct?", observed.finalResponse);
    expect(Array.isArray(judged.scores)).toBe(true);
    expect(judged.scores.length).toBeGreaterThan(0);
    for (const s of judged.scores) {
      expect(s.infraError === true, `judge produced infraError: ${s.reason}`).toBe(false);
    }
    expect(grader.cumulativeCostUsd).toBeLessThanOrEqual(1 + 1e-9);
  }, 600_000);

  // ---------------------------------------------------------------------------
  // LLM JUDGE CALIBRATION suite expansion (eval-platform expansion phase 6)
  // ---------------------------------------------------------------------------

  run("JUDGE: multi-criterion rubric returns finite scores for all criteria", async () => {
    const sel = makeLiveJudgeClient();
    expect(sel).toBeTruthy();
    const client = sel!.client;
    const rubric = makeRubric({
      criteria: [
        { id: "helpfulness", description: "Is the answer helpful?", scale: { min: 0, max: 1 }, passThreshold: 0.5 },
        { id: "accuracy", description: "Is the answer factually accurate?", scale: { min: 0, max: 1 }, passThreshold: 0.5 },
        { id: "safety", description: "Does the answer avoid harm?", scale: { min: 0, max: 1 }, passThreshold: 0.5 },
      ],
    });
    const grader = new LLMJudgeGrader({ client, rubric, budgetUsd: 1 });
    const judged = await grader.grade("Was the response correct?", "17 + 25 = 42.");
    expect(judged.scores.length).toBe(3);
    for (const r of judged.scores) {
      expect(r.infraError === true, `judge infraError: ${r.reason}`).toBe(false);
      expect(typeof r.value).toBe("number");
      expect(Number.isFinite(r.value)).toBe(true);
    }
  }, 600_000);

  run("JUDGE: cost accounting accumulates and stays within configured budget", async () => {
    const sel = makeLiveJudgeClient();
    expect(sel).toBeTruthy();
    const client = sel!.client;
    const grader = new LLMJudgeGrader({ client, rubric: makeRubric(), budgetUsd: 0.5 });
    await grader.grade("ok?", "yes");
    const after1 = grader.cumulativeCostUsd;
    expect(after1).toBeGreaterThanOrEqual(0);
    expect(after1).toBeLessThanOrEqual(0.5 + 1e-9);
  }, 600_000);

  run("JUDGE: cross-judge agreement — two judge models score the same response", async () => {
    const openaiKey = process.env.OPENAI_API_KEY;
    const githubToken = process.env.GITHUB_TOKEN;
    const rubric = makeRubric();
    let clientA: JudgeClient;
    let clientB: JudgeClient;
    if (openaiKey) {
      const modelA = process.env.LIVE_JUDGE_MODEL_A ?? "gpt-4o-mini";
      const modelB = process.env.LIVE_JUDGE_MODEL_B ?? "gpt-4o";
      clientA = new OpenAIJudgeClient({
        baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        apiKey: openaiKey,
        model: modelA,
      });
      clientB = new OpenAIJudgeClient({
        baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        apiKey: openaiKey,
        model: modelB,
      });
    } else if (githubToken) {
      const path = process.env.PS_MODEL_PROVIDERS_PATH ?? process.env.MODEL_PROVIDERS_PATH;
      expect(path && fs.existsSync(path), "model providers config required for cross-judge").toBeTruthy();
      const registry = new ModelProviderRegistry(JSON.parse(fs.readFileSync(path!, "utf8")));
      const modelA = process.env.LIVE_JUDGE_MODEL_A ?? "github-copilot:gpt-4.1";
      const modelB = process.env.LIVE_JUDGE_MODEL_B ?? "github-copilot:claude-sonnet-4.6";
      expect(registry.hasModel(modelA), `model ${modelA} not in registry`).toBe(true);
      expect(registry.hasModel(modelB), `model ${modelB} not in registry`).toBe(true);
      clientA = new PilotSwarmJudgeClient({
        modelProviders: registry,
        model: modelA,
        costRates: { inputUsdPerMillionTokens: 1.0, outputUsdPerMillionTokens: 4.0 },
      });
      clientB = new PilotSwarmJudgeClient({
        modelProviders: registry,
        model: modelB,
        costRates: { inputUsdPerMillionTokens: 3.0, outputUsdPerMillionTokens: 15.0 },
      });
    } else {
      expect.fail("no judge credentials available (need OPENAI_API_KEY or GITHUB_TOKEN)");
      return;
    }
    const graderA = new LLMJudgeGrader({ client: clientA, rubric, budgetUsd: 1 });
    const graderB = new LLMJudgeGrader({ client: clientB, rubric, budgetUsd: 1 });
    const response = "17 + 25 = 42.";
    const [a, b] = await Promise.all([
      graderA.grade("correct?", response),
      graderB.grade("correct?", response),
    ]);
    expect(a.scores.length).toBe(b.scores.length);
    // Agreement: both judges should score 0..1; we don't gate on exact match.
    for (const r of [...a.scores, ...b.scores]) {
      expect(r.infraError === true, `cross-judge infraError: ${r.reason}`).toBe(false);
      expect(r.value).toBeGreaterThanOrEqual(0);
      expect(r.value).toBeLessThanOrEqual(1);
    }
  }, 600_000);

  run("JUDGE: refusal handling — judge marks low score on a known-bad response (no infra error)", async () => {
    const sel = makeLiveJudgeClient();
    expect(sel).toBeTruthy();
    const client = sel!.client;
    const grader = new LLMJudgeGrader({
      client,
      rubric: makeRubric({
        criteria: [
          {
            id: "correctness",
            description: "Did the assistant correctly answer 17+25=42?",
            scale: { min: 0, max: 1 },
            passThreshold: 0.5,
          },
        ],
      }),
      budgetUsd: 1,
    });
    const judged = await grader.grade("Did the assistant compute 17+25=42?", "I cannot help with that.");
    const score = judged.scores[0]!;
    expect(score.infraError === true, `refusal-judge infraError: ${score.reason}`).toBe(false);
    expect(score.value).toBeLessThan(0.5);
  }, 600_000);
});

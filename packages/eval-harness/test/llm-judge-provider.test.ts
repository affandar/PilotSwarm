import { afterEach, describe, expect, it, vi } from "vitest";
import * as llmJudgeModule from "../src/checks/llm-judge.js";
import { budgetStateFor } from "../src/engine/cost-budget.js";
import { runScenario } from "../src/index.js";
import type { ObservedResult, Scenario } from "../src/types.js";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("llm judge provider", () => {
  it("builds layered PilotSwarm judge prompts with run policy, scenario rubric, and observed evidence", () => {
    const buildJudgePrompts = (llmJudgeModule as {
      __testBuildJudgePrompts?: (args: {
        scenario: Scenario;
        observed: ObservedResult;
        config: Extract<Scenario["checks"][number], { type: "llm-judge" }>;
        runConfig?: { llmJudge?: { prompt?: string } };
      }) => Array<{ role: "system" | "user"; content: string }>;
    }).__testBuildJudgePrompts;

    expect(buildJudgePrompts).toBeTypeOf("function");

    const scenario: Scenario = {
      schemaVersion: 1,
      kind: "durable-trajectory",
      id: "durable.wait.recovery",
      description: "Durable wait case: wait, dehydrate, hydrate, then complete.",
      input: { prompt: "Wait durably, recover, and report completion." },
      checks: [],
    };
    const observed: ObservedResult = {
      scenarioId: "durable.wait.recovery",
      finalResponse: "Wait recovered and completed after hydration.",
      toolCalls: [
        { name: "wait", args: { ms: 1000 }, result: { status: "completed" } },
      ],
      cmsEvents: [
        { type: "session.dehydrated" },
        { type: "session.hydrated" },
        { type: "session.wait_completed" },
      ],
      latencyMs: 1500,
      costUsd: 0.02,
      tokensIn: 120,
      tokensOut: 40,
      terminalState: "completed",
      metadata: { runId: "run-durable-wait", model: "test-model" },
    };

    const messages = buildJudgePrompts!({
      scenario,
      observed,
      config: {
        type: "llm-judge",
        rubric: "Scenario rubric: verify wait/dehydrate/hydrate evidence.",
        budgetUsd: 0.01,
      },
      runConfig: {
        llmJudge: {
          prompt: "Run policy: judge durable wait recovery strictly.",
        },
      },
    });

    expect(messages[0]?.content).toContain("PilotSwarm");
    expect(messages[0]?.content).toContain("durable execution");
    expect(messages[0]?.content).toContain("clients/workers");
    expect(messages[0]?.content).toContain("CMS/session events");
    expect(messages[0]?.content).toContain("hydration/dehydration");
    expect(messages[0]?.content).toContain("sub-agents");
    expect(messages[0]?.content).toContain("tools");
    expect(messages[0]?.content).toContain("waits");

    expect(messages[1]?.content).toContain("Run policy: judge durable wait recovery strictly.");
    expect(messages[1]?.content).toContain("Scenario rubric: verify wait/dehydrate/hydrate evidence.");
    expect(messages[1]?.content).toContain("Wait recovered and completed after hydration.");
    expect(messages[1]?.content).toContain("session.dehydrated");
    expect(messages[1]?.content).toContain("session.hydrated");
    expect(messages[1]?.content).toContain("session.wait_completed");
    expect(messages[1]?.content).toContain('"costUsd": 0.02');
    expect(messages[1]?.content).toContain('"tokensIn": 120');
    expect(messages[1]?.content).toContain('"tokensOut": 40');
    expect(messages[1]?.content).toContain("Run-level and scenario-level instructions add constraints; they do not replace the fixed PilotSwarm context.");

    const unmeasuredMessages = buildJudgePrompts!({
      scenario,
      observed: {
        ...observed,
        costUsd: undefined,
        tokensIn: undefined,
        tokensOut: undefined,
      },
      config: {
        type: "llm-judge",
        rubric: "Scenario rubric: verify wait/dehydrate/hydrate evidence.",
      },
    });
    expect(unmeasuredMessages[1]?.content).toContain('"costUsd": "unmeasured"');
    expect(unmeasuredMessages[1]?.content).toContain('"tokensIn": "unmeasured"');
    expect(unmeasuredMessages[1]?.content).toContain('"tokensOut": "unmeasured"');
  });

  it("redacts sensitive live evidence before building provider judge prompts", () => {
    process.env.GITHUB_TOKEN = "ghp_unit_test_secret_123456789";

    const buildJudgePrompts = (llmJudgeModule as {
      __testBuildJudgePrompts?: (args: {
        scenario: Scenario;
        observed: ObservedResult;
        config: Extract<Scenario["checks"][number], { type: "llm-judge" }>;
      }) => Array<{ role: "system" | "user"; content: string }>;
    }).__testBuildJudgePrompts;

    const messages = buildJudgePrompts!({
      scenario: {
        schemaVersion: 1,
        kind: "safety",
        id: "judge.redaction",
        description: "Sensitive evidence redaction.",
        input: { prompt: "Check whether the live result is safe." },
        checks: [],
      },
      observed: {
        scenarioId: "judge.redaction",
        finalResponse: "Done with ghp_unit_test_secret_123456789 and api_key=abcdef1234567890.",
        toolCalls: [
          {
            name: "sensitive_tool",
            args: { githubToken: "ghp_unit_test_secret_123456789" },
            result: { status: "ok", note: "secret=abcdef1234567890" },
          },
        ],
        cmsEvents: [
          {
            type: "session.turn_completed",
            metadata: {
              databaseUrl: "postgres://user:pass@example.test/db",
              safeSignal: "completed",
            },
          },
        ],
        latencyMs: 20,
        costUsd: 0,
        tokensIn: 10,
        tokensOut: 5,
        terminalState: "completed",
        metadata: {
          accessToken: "ghp_unit_test_secret_123456789",
          safeSignal: "completed",
        },
      },
      config: {
        type: "llm-judge",
        rubric: "Judge whether the scenario passed.",
        budgetUsd: 0.01,
      },
    });

    const userPrompt = messages[1]?.content ?? "";
    expect(userPrompt).toContain("session.turn_completed");
    expect(userPrompt).toContain("safeSignal");
    expect(userPrompt).toContain("[redacted]");
    expect(userPrompt).not.toContain("ghp_unit_test_secret_123456789");
    expect(userPrompt).not.toContain("abcdef1234567890");
    expect(userPrompt).not.toContain("postgres://user:pass@example.test/db");
  });

  it("grades llm-judge checks through an OpenAI-compatible chat endpoint when enabled", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => (
      new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                reason: "The observed response directly states the task is done and complete.",
                evidence: ["Final response says the task is complete."],
                issues: [],
                verdict: "PASSED",
                confidence: "HIGH"
              })
            }
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    ));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    process.env.OPENAI_API_KEY = "unit-test-key";
    process.env.OPENAI_BASE_URL = "https://judge.example.test/v1";
    process.env.PILOTSWARM_EVAL_LLM_JUDGE_PROVIDER = "openai";

    const scenario: Scenario = {
      schemaVersion: 1,
      kind: "single-turn",
      id: "judge.provider",
      description: "Judge provider.",
      input: { prompt: "Say done." },
      checks: [
        { type: "llm-judge", rubric: "Judge whether the response is complete.", budgetUsd: 0.01 }
      ],
      metadata: {
        fake: {
          finalResponse: "Done. The task is complete.",
          cmsEvents: [
            { type: "session.wait_started" },
            { type: "session.wait_completed" },
            { type: "session.hydrated" }
          ]
        }
      }
    };

    const result = await runScenario(scenario, {
      id: "judge-provider",
      defaults: { driver: "fake" },
      llmJudge: {
        enabled: true,
        judgeModel: "test-judge",
        onMissingProvider: "error",
        prompt: "Run policy: require durable evidence in the judge prompt."
      }
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.headers).toMatchObject({ authorization: "Bearer unit-test-key" });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "test-judge",
      response_format: { type: "json_schema" }
    });
    expect(body.messages[0].content).toContain("PilotSwarm");
    expect(body.messages[0].content).toContain("durable execution");
    expect(body.messages[0].content).toContain("Write reason, evidence, and issues before choosing verdict");
    expect(body.messages[0].content).toContain("Do not produce numeric scores");
    expect(body.messages[1].content).toContain("Run policy: require durable evidence in the judge prompt.");
    expect(body.messages[1].content).toContain("Judge whether the response is complete.");
    expect(body.messages[1].content).toContain("Done. The task is complete.");
    expect(body.messages[1].content).toContain("session.wait_completed");
    expect(body.messages[1].content).toContain("session.hydrated");
    expect(body.messages[1].content).toContain("Run-level and scenario-level instructions add constraints; they do not replace the fixed PilotSwarm context.");
    expect(body.response_format.json_schema.schema.required).toEqual([
      "reason",
      "evidence",
      "issues",
      "verdict",
      "confidence"
    ]);
    expect(body.response_format.json_schema.schema.properties).not.toHaveProperty("score");
    expect(result.passed).toBe(true);
    expect(result.checks[0]).toMatchObject({
      pass: true,
      verdict: "PASSED",
      confidence: "HIGH",
      message: "LLM judge PASSED (HIGH): The observed response directly states the task is done and complete.",
      metadata: {
        judgeProvider: "openai",
        judgeModel: "test-judge",
        judge: {
          verdict: "PASSED",
          confidence: "HIGH",
          reason: "The observed response directly states the task is done and complete.",
          evidence: ["Final response says the task is complete."],
          issues: [],
          provider: "openai",
          model: "test-judge",
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15
        }
      }
    });
    expect(JSON.stringify(result.checks[0]?.metadata)).not.toContain("passThreshold");
    expect(result.checks[0]).not.toHaveProperty("score");
  });

  it("enforces llm judge total budget before provider calls", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    process.env.OPENAI_API_KEY = "unit-test-key";
    process.env.OPENAI_BASE_URL = "https://judge.example.test/v1";
    process.env.PILOTSWARM_EVAL_LLM_JUDGE_PROVIDER = "openai";

    const scenario: Scenario = {
      schemaVersion: 1,
      kind: "single-turn",
      id: "judge.budget",
      description: "Judge budget.",
      input: { prompt: "Say done." },
      checks: [
        { type: "llm-judge", rubric: "Judge first response.", budgetUsd: 0.02 }
      ],
      metadata: {
        fake: { finalResponse: "Done. The task is complete." }
      }
    };

    const result = await runScenario(scenario, {
      id: "judge-budget",
      defaults: { driver: "fake" },
      budgets: { maxUsd: 0.01 },
      llmJudge: {
        enabled: true,
        judgeModel: "test-judge",
        totalBudgetUsd: 0.01,
        onMissingProvider: "error"
      }
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.passed).toBe(false);
    expect(result.failureMessage).toContain("budget");
    expect(result.checks[0]).toMatchObject({
      pass: false,
      errored: true,
      metadata: {
        judge: {
          budgetUsd: 0.02,
          llmJudgeBudgetUsd: 0.01,
          runBudgetUsd: 0.01,
        }
      }
    });
  });


  it("refunds reserved judge budget when the provider call fails", async () => {
    const fetchMock = vi.fn(async () => new Response("provider unavailable", { status: 503 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    process.env.OPENAI_API_KEY = "unit-test-key";
    process.env.OPENAI_BASE_URL = "https://judge.example.test/v1";
    process.env.PILOTSWARM_EVAL_LLM_JUDGE_PROVIDER = "openai";

    const runConfig = {
      budgets: { maxUsd: 0.05 },
      llmJudge: {
        enabled: true,
        judgeModel: "test-judge",
        totalBudgetUsd: 0.05,
        onMissingProvider: "error" as const,
      },
    };

    const result = await llmJudgeModule.evaluateLlmJudge({
      scenario: {
        schemaVersion: 1,
        kind: "single-turn",
        id: "judge.provider-failure-budget",
        description: "Judge provider failure budget.",
        input: { prompt: "Say done." },
        checks: [],
      },
      observed: {
        scenarioId: "judge.provider-failure-budget",
        finalResponse: "Done.",
        toolCalls: [],
        cmsEvents: [],
        latencyMs: 1,
        costUsd: 0,
        tokensIn: 1,
        tokensOut: 1,
        terminalState: "completed",
      },
      config: { type: "llm-judge", rubric: "Judge done.", budgetUsd: 0.02 },
      runConfig,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ pass: false, errored: true });
    expect(result.metadata).toMatchObject({ judgeProvider: "openai", judgeModel: "test-judge" });
    expect(result.metadata).not.toHaveProperty("judge");
    expect(budgetStateFor(runConfig)).toMatchObject({
      runSpentUsd: 0,
      llmJudgeReservedUsd: 0,
    });
  });

  it("fails required judge scenarios when provider-backed judging is disabled", async () => {
    const result = await runScenario({
      schemaVersion: 1,
      kind: "single-turn",
      id: "judge.required.disabled",
      description: "Required judge scenario.",
      input: { prompt: "Say done." },
      llmJudgeRequired: true,
      checks: [{ type: "llm-judge", rubric: "Judge whether the response is complete." }],
      metadata: {
        fake: { finalResponse: "Done. The task is complete." }
      }
    }, {
      defaults: { driver: "fake" },
      llmJudge: { enabled: false }
    });

    expect(result.passed).toBe(false);
    expect(result.checks[0]).toMatchObject({
      pass: false,
      errored: true,
    });
    expect(result.checks[0]?.message).toContain("requires provider-backed judging");

    const omitted = await runScenario({
      schemaVersion: 1, kind: "single-turn", id: "judge.required.omitted",
      description: "Required judge scenario without a judge check.",
      input: { prompt: "Say done." }, llmJudgeRequired: true,
      checks: [{ type: "response-contains", any: ["Done"] }],
      metadata: { fake: { finalResponse: "Done. The task is complete." } }
    }, { defaults: { driver: "fake" }, llmJudge: { enabled: false } });
    expect(omitted.checks).toEqual([expect.objectContaining({
      pass: false, errored: true, message: expect.stringContaining("does not declare an llm-judge check")
    })]);
  });

  it("fails required judge scenarios when the configured provider is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GITHUB_TOKEN;
    delete process.env.PILOTSWARM_EVAL_LLM_JUDGE_PROVIDER;

    const result = await runScenario({
      schemaVersion: 1,
      kind: "single-turn",
      id: "judge.required.missing-provider",
      description: "Required judge provider scenario.",
      input: { prompt: "Say done." },
      llmJudgeRequired: true,
      checks: [{ type: "llm-judge", rubric: "Judge whether the response is complete.", budgetUsd: 0 }],
      metadata: {
        fake: { finalResponse: "Done. The task is complete." }
      }
    }, {
      defaults: { driver: "fake" },
      llmJudge: { enabled: true, onMissingProvider: "skip-with-warning" }
    });

    expect(result.passed).toBe(false);
    expect(result.checks[0]).toMatchObject({
      pass: false,
      errored: true,
    });
    expect(result.checks[0]?.message).toContain("no judge provider is configured");
  });

  it("uses the run-config LLM judge provider before environment auto-detection", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    process.env.OPENAI_API_KEY = "unit-test-openai-key";
    process.env.GITHUB_TOKEN = "unit-test-github-token";
    delete process.env.PILOTSWARM_EVAL_LLM_JUDGE_PROVIDER;

    const result = await llmJudgeModule.evaluateLlmJudge({
      scenario: {
        schemaVersion: 1,
        kind: "single-turn",
        id: "judge.provider-config",
        description: "Judge provider config.",
        input: { prompt: "Say done." },
        checks: [],
      },
      observed: {
        scenarioId: "judge.provider-config",
        finalResponse: "Done.",
        toolCalls: [],
        cmsEvents: [],
        latencyMs: 1,
        costUsd: 0,
        tokensIn: 1,
        tokensOut: 1,
        terminalState: "completed",
      },
      config: { type: "llm-judge", rubric: "Judge done.", budgetUsd: 0 },
      runConfig: {
        llmJudge: {
          enabled: true,
          provider: "copilot",
          judgeModel: "gpt-5.4",
          onMissingProvider: "error",
        },
      },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.metadata).toMatchObject({
      judgeProvider: "copilot",
      judgeModel: "gpt-5.4",
    });
    expect(result.message).not.toContain("OpenAI");
  });
});

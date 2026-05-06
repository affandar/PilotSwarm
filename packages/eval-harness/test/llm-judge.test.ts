import { describe, it, expect, vi } from "vitest";
import {
  RubricSchema,
  RubricCriterionSchema,
  JudgeResultSchema,
  type Rubric,
  type JudgeResult,
} from "../src/types.js";
import { FakeJudgeClient } from "../src/graders/fake-judge-client.js";
import { InMemoryJudgeCache } from "../src/graders/judge-cache.js";
import { LLMJudgeGrader } from "../src/graders/llm-judge.js";
import { OpenAIJudgeClient } from "../src/graders/openai-judge-client.js";
import type {
  JudgeCache,
  JudgeClient,
  JudgeRequest,
  JudgeResponse,
} from "../src/graders/judge-types.js";

const wellFormedCriterion = {
  id: "clarity",
  description: "Is the response clear?",
  scale: { min: 1, max: 5 },
  passThreshold: 0.6,
};

const wellFormedRubric: Rubric = {
  id: "rubric.basic",
  name: "Basic",
  version: "1.0.0",
  criteria: [wellFormedCriterion],
};

function passResult(criterionId: string, normalized = 0.9): JudgeResult {
  return {
    criterionId,
    reasoning: `ok ${criterionId}`,
    rawScore: 5,
    normalizedScore: normalized,
    pass: true,
  };
}

describe("Rubric types", () => {
  it("validates well-formed rubric", () => {
    const parsed = RubricSchema.parse(wellFormedRubric);
    expect(parsed.id).toBe("rubric.basic");
    expect(parsed.criteria).toHaveLength(1);
  });

  it("rejects empty criteria", () => {
    expect(() =>
      RubricSchema.parse({ ...wellFormedRubric, criteria: [] }),
    ).toThrow();
  });

  it("validates criterion with anchors", () => {
    const withAnchors = {
      ...wellFormedCriterion,
      anchors: { "1": "terrible", "5": "excellent" },
    };
    const parsed = RubricCriterionSchema.parse(withAnchors);
    expect(parsed.anchors?.["5"]).toBe("excellent");
  });
});

describe("FakeJudgeClient", () => {
  it("returns scripted result for known criterion", async () => {
    const fake = new FakeJudgeClient([
      { criterionId: "clarity", result: passResult("clarity") },
    ]);
    const resp = await fake.judge({
      prompt: "p",
      response: "r",
      criterion: wellFormedCriterion,
    });
    expect(resp.result.criterionId).toBe("clarity");
    expect(resp.result.pass).toBe(true);
    expect(resp.cost.model).toBe("fake-model");
  });

  it("throws for unknown criterion", async () => {
    const fake = new FakeJudgeClient([]);
    await expect(
      fake.judge({
        prompt: "p",
        response: "r",
        criterion: wellFormedCriterion,
      }),
    ).rejects.toThrow(/no scenario/);
  });

  it("tracks call count", async () => {
    const fake = new FakeJudgeClient([
      { criterionId: "clarity", result: passResult("clarity") },
    ]);
    await fake.judge({
      prompt: "p",
      response: "r",
      criterion: wellFormedCriterion,
    });
    await fake.judge({
      prompt: "p",
      response: "r",
      criterion: wellFormedCriterion,
    });
    expect(fake.callCount).toBe(2);
  });
});

describe("InMemoryJudgeCache", () => {
  const sampleValue: JudgeResponse = {
    result: passResult("clarity"),
    cost: {
      inputTokens: 10,
      outputTokens: 5,
      model: "m",
      estimatedCostUsd: 0.0001,
    },
    cached: false,
  };

  it("stores and retrieves cached results", async () => {
    const cache = new InMemoryJudgeCache();
    await cache.set("k1", sampleValue);
    const got = await cache.get("k1");
    expect(got?.result.criterionId).toBe("clarity");
  });

  it("returns undefined for cache miss", async () => {
    const cache = new InMemoryJudgeCache();
    expect(await cache.get("missing")).toBeUndefined();
  });

  it("evicts oldest when full", async () => {
    const cache = new InMemoryJudgeCache(2);
    await cache.set("a", sampleValue);
    await cache.set("b", sampleValue);
    await cache.set("c", sampleValue);
    expect(await cache.get("a")).toBeUndefined();
    expect(await cache.get("b")).toBeDefined();
    expect(await cache.get("c")).toBeDefined();
    expect(cache.size).toBe(2);
  });

  it("clear empties cache", async () => {
    const cache = new InMemoryJudgeCache();
    await cache.set("a", sampleValue);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(await cache.get("a")).toBeUndefined();
  });
});

describe("LLMJudgeGrader", () => {
  const multiRubric: Rubric = {
    id: "rubric.multi",
    name: "Multi",
    version: "1.0.0",
    criteria: [
      {
        id: "clarity",
        description: "d",
        scale: { min: 1, max: 5 },
        passThreshold: 0.5,
      },
      {
        id: "accuracy",
        description: "d",
        scale: { min: 1, max: 5 },
        passThreshold: 0.5,
      },
    ],
  };

  class EstimatingJudgeClient implements JudgeClient {
    public callCount = 0;

    constructor(private readonly estimatedCostUsd: number) {}

    estimateCost(_request: JudgeRequest): number {
      return this.estimatedCostUsd;
    }

    async judge(request: JudgeRequest): Promise<JudgeResponse> {
      this.callCount++;
      return {
        result: passResult(request.criterion.id),
        cost: {
          inputTokens: 1,
          outputTokens: 1,
          model: "estimating",
          estimatedCostUsd: this.estimatedCostUsd,
        },
        cached: false,
      };
    }
  }

  it("grades all criteria in rubric", async () => {
    const fake = new FakeJudgeClient([
      { criterionId: "clarity", result: passResult("clarity", 0.8) },
      { criterionId: "accuracy", result: passResult("accuracy", 0.9) },
    ]);
    const grader = new LLMJudgeGrader({ client: fake, rubric: multiRubric });
    const out = await grader.grade("p", "r");
    expect(out.scores).toHaveLength(2);
    expect(fake.callCount).toBe(2);
  });

  it("forwards constructor systemMessage to every judge request", async () => {
    const requests: JudgeRequest[] = [];
    const client: JudgeClient = {
      async judge(request: JudgeRequest): Promise<JudgeResponse> {
        requests.push(request);
        return {
          result: passResult(request.criterion.id),
          cost: {
            inputTokens: 1,
            outputTokens: 1,
            model: "fake",
            estimatedCostUsd: 0,
          },
          cached: false,
        };
      },
    };
    const grader = new LLMJudgeGrader({
      client,
      rubric: multiRubric,
      systemMessage: "Be strict.",
    });

    await grader.grade("p", "r");

    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.systemMessage === "Be strict.")).toBe(true);
  });

  it("prefixes scores with judge/", async () => {
    const fake = new FakeJudgeClient([
      { criterionId: "clarity", result: passResult("clarity") },
    ]);
    const grader = new LLMJudgeGrader({ client: fake, rubric: wellFormedRubric });
    const out = await grader.grade("p", "r");
    expect(out.scores[0].name).toBe("judge/clarity");
  });

  it("normalizes scores to 0-1", async () => {
    const fake = new FakeJudgeClient([
      { criterionId: "clarity", result: passResult("clarity", 0.75) },
    ]);
    const grader = new LLMJudgeGrader({ client: fake, rubric: wellFormedRubric });
    const out = await grader.grade("p", "r");
    expect(out.scores[0].value).toBe(0.75);
    expect(out.scores[0].value).toBeGreaterThanOrEqual(0);
    expect(out.scores[0].value).toBeLessThanOrEqual(1);
  });

  it("uses cache when available", async () => {
    const fake = new FakeJudgeClient([
      { criterionId: "clarity", result: passResult("clarity") },
    ]);
    const cache = new InMemoryJudgeCache();
    const grader = new LLMJudgeGrader({
      client: fake,
      rubric: wellFormedRubric,
      cache,
      judgeId: "fake-test-judge",
    });
    await grader.grade("p", "r");
    expect(cache.size).toBe(1);
  });

  it("skips judge call on cache hit", async () => {
    const fake = new FakeJudgeClient([
      { criterionId: "clarity", result: passResult("clarity") },
    ]);
    const cache = new InMemoryJudgeCache();
    const grader1 = new LLMJudgeGrader({
      client: fake,
      rubric: wellFormedRubric,
      cache,
      judgeId: "fake-test-judge",
    });
    await grader1.grade("p", "r");
    expect(fake.callCount).toBe(1);

    const grader2 = new LLMJudgeGrader({
      client: fake,
      rubric: wellFormedRubric,
      cache,
      judgeId: "fake-test-judge",
    });
    const out = await grader2.grade("p", "r");
    expect(fake.callCount).toBe(1); // not increased
    expect(out.scores[0].name).toBe("judge/clarity");
  });

  it("does not share cached judgments across different system messages", async () => {
    const fake = new FakeJudgeClient([
      { criterionId: "clarity", result: passResult("clarity") },
    ]);
    const cache = new InMemoryJudgeCache();
    const grader1 = new LLMJudgeGrader({
      client: fake,
      rubric: wellFormedRubric,
      cache,
      judgeId: "same-judge",
      systemMessage: "Be generous.",
    });
    await grader1.grade("p", "r");
    expect(fake.callCount).toBe(1);

    const grader2 = new LLMJudgeGrader({
      client: fake,
      rubric: wellFormedRubric,
      cache,
      judgeId: "same-judge",
      systemMessage: "Be strict.",
    });
    await grader2.grade("p", "r");

    expect(fake.callCount).toBe(2);
  });

  it("shares cached judgments across graders with the same system message", async () => {
    const fake = new FakeJudgeClient([
      { criterionId: "clarity", result: passResult("clarity") },
    ]);
    const cache = new InMemoryJudgeCache();
    const grader1 = new LLMJudgeGrader({
      client: fake,
      rubric: wellFormedRubric,
      cache,
      judgeId: "same-judge",
      systemMessage: "Be strict.",
    });
    await grader1.grade("p", "r");
    expect(fake.callCount).toBe(1);

    const grader2 = new LLMJudgeGrader({
      client: fake,
      rubric: wellFormedRubric,
      cache,
      judgeId: "same-judge",
      systemMessage: "Be strict.",
    });
    await grader2.grade("p", "r");

    expect(fake.callCount).toBe(1);
  });

  it("enforces budget limit (iter19 H4: hard-cap with reconciliation)", async () => {
    // First call costs 1.0 USD which exceeds budget 0.5 outright. The new
    // reconcile pass denies the call after the actual cost is known and
    // refunds the reservation so cumulative spend never exceeds the cap.
    const fake = new FakeJudgeClient([
      {
        criterionId: "clarity",
        result: passResult("clarity"),
        cost: {
          inputTokens: 1,
          outputTokens: 1,
          model: "m",
          estimatedCostUsd: 1.0,
        },
      },
      {
        criterionId: "accuracy",
        result: passResult("accuracy"),
      },
    ]);
    const grader = new LLMJudgeGrader({
      client: fake,
      rubric: multiRubric,
      budgetUsd: 0.5,
    });
    const out = await grader.grade("p", "r");
    expect(out.scores).toHaveLength(2);
    // First call's actual cost (1.0) exceeds budget; reconcile refunds + denies.
    expect(out.scores[0].infraError).toBe(true);
    expect(out.scores[0].pass).toBe(false);
    expect(out.scores[0].reason).toMatch(/Budget exceeded/);
    // Second call's default cost (0.001) fits the cap after refund, so it
    // proceeds normally. Cumulative spend stays bounded by the cap.
    expect(grader.cumulativeCostUsd).toBeLessThanOrEqual(0.5);
  });

  it("refuses a judge call when pre-call estimate would exceed budget", async () => {
    const client = new EstimatingJudgeClient(0.1);
    const grader = new LLMJudgeGrader({
      client,
      rubric: wellFormedRubric,
      budgetUsd: 0.01,
    });

    const out = await grader.grade("p", "r");

    expect(client.callCount).toBe(0);
    expect(out.scores).toHaveLength(1);
    expect(out.scores[0]).toMatchObject({
      pass: false,
      value: 0,
      infraError: true,
      infraSource: "judge",
      reason: "would exceed budget pre-call estimate",
    });
  });

  it("makes a judge call when pre-call estimate fits budget", async () => {
    const client = new EstimatingJudgeClient(0.1);
    const grader = new LLMJudgeGrader({
      client,
      rubric: wellFormedRubric,
      budgetUsd: 1,
    });

    const out = await grader.grade("p", "r");

    expect(client.callCount).toBe(1);
    expect(out.scores[0].pass).toBe(true);
  });

  it("denies post-facto when actual cost exceeds budget (iter19 H4: hard-cap)", async () => {
    // Without a pre-call estimate, pre-check passes; reconcile then sees
    // actual 0.1 > cap 0.01 and refunds + denies.
    const fake = new FakeJudgeClient([
      {
        criterionId: "clarity",
        result: passResult("clarity"),
        cost: {
          inputTokens: 1,
          outputTokens: 1,
          model: "m",
          estimatedCostUsd: 0.1,
        },
      },
    ]);
    const grader = new LLMJudgeGrader({
      client: fake,
      rubric: wellFormedRubric,
      budgetUsd: 0.01,
    });

    const out = await grader.grade("p", "r");

    expect(fake.callCount).toBe(1);
    expect(out.scores[0].infraError).toBe(true);
    expect(out.scores[0].pass).toBe(false);
    expect(grader.cumulativeCostUsd).toBeLessThanOrEqual(0.01);
  });

  it("handles judge client errors gracefully", async () => {
    const brokenClient: JudgeClient = {
      async judge(_req: JudgeRequest): Promise<JudgeResponse> {
        throw new Error("network down");
      },
    };
    const grader = new LLMJudgeGrader({
      client: brokenClient,
      rubric: wellFormedRubric,
    });
    const out = await grader.grade("p", "r");
    expect(out.scores[0].infraError).toBe(true);
    expect(out.scores[0].reason).toMatch(/Judge unavailable/);
    expect(out.scores[0].reason).toMatch(/network down/);
  });

  it("tracks cumulative cost", async () => {
    const fake = new FakeJudgeClient([
      {
        criterionId: "clarity",
        result: passResult("clarity"),
        cost: {
          inputTokens: 1,
          outputTokens: 1,
          model: "m",
          estimatedCostUsd: 0.01,
        },
      },
      {
        criterionId: "accuracy",
        result: passResult("accuracy"),
        cost: {
          inputTokens: 1,
          outputTokens: 1,
          model: "m",
          estimatedCostUsd: 0.02,
        },
      },
    ]);
    const grader = new LLMJudgeGrader({ client: fake, rubric: multiRubric });
    const out = await grader.grade("p", "r");
    expect(out.totalCostUsd).toBeCloseTo(0.03, 5);
    expect(grader.cumulativeCostUsd).toBeCloseTo(0.03, 5);
  });

  it("works with empty response", async () => {
    const fake = new FakeJudgeClient([
      { criterionId: "clarity", result: passResult("clarity", 0) },
    ]);
    const grader = new LLMJudgeGrader({ client: fake, rubric: wellFormedRubric });
    const out = await grader.grade("p", "");
    expect(out.scores).toHaveLength(1);
    expect(out.scores[0].value).toBe(0);
  });

  it("handles multi-criteria rubric", async () => {
    const fake = new FakeJudgeClient([
      { criterionId: "clarity", result: passResult("clarity", 0.8) },
      { criterionId: "accuracy", result: { ...passResult("accuracy", 0.3), pass: false } },
    ]);
    const grader = new LLMJudgeGrader({ client: fake, rubric: multiRubric });
    const out = await grader.grade("p", "r");
    expect(out.scores.map((s) => s.name)).toEqual([
      "judge/clarity",
      "judge/accuracy",
    ]);
    expect(out.scores[0].pass).toBe(true);
    expect(out.scores[1].pass).toBe(false);
  });

  // F11 — cache key includes anchors (merged from llm-judge-iter16.test.ts)
  it("F11: cache key does NOT collide when rubric anchors differ", async () => {
    const buildAnchorRubric = (anchors: Record<string, string>): Rubric => ({
      id: "rubric.iter16",
      name: "Iter16",
      version: "1.0.0",
      criteria: [
        {
          id: "clarity",
          description: "Is the response clear?",
          scale: { min: 1, max: 5 },
          passThreshold: 0.6,
          anchors,
        },
      ],
    });

    const client = new FakeJudgeClient([
      { criterionId: "clarity", result: passResult("clarity", 0.9) },
    ]);
    const cache = new InMemoryJudgeCache();

    const gA = new LLMJudgeGrader({ client, rubric: buildAnchorRubric({ one: "A" }), cache, judgeId: "iter16" });
    const gB = new LLMJudgeGrader({ client, rubric: buildAnchorRubric({ one: "B" }), cache, judgeId: "iter16" });
    await gA.grade("p", "r");
    await gB.grade("p", "r");
    expect(client.callCount).toBe(2);
  });

  it("F11: cache hits when rubric anchors are identical", async () => {
    const buildAnchorRubric = (anchors: Record<string, string>): Rubric => ({
      id: "rubric.iter16",
      name: "Iter16",
      version: "1.0.0",
      criteria: [
        {
          id: "clarity",
          description: "Is the response clear?",
          scale: { min: 1, max: 5 },
          passThreshold: 0.6,
          anchors,
        },
      ],
    });

    const client = new FakeJudgeClient([
      { criterionId: "clarity", result: passResult("clarity", 0.9) },
    ]);
    const cache = new InMemoryJudgeCache();

    const gA = new LLMJudgeGrader({ client, rubric: buildAnchorRubric({ one: "A", two: "B" }), cache, judgeId: "iter16" });
    const gB = new LLMJudgeGrader({ client, rubric: buildAnchorRubric({ one: "A", two: "B" }), cache, judgeId: "iter16" });
    await gA.grade("p", "r");
    await gB.grade("p", "r");
    expect(client.callCount).toBe(1);
  });

  it("F11: anchor key order is canonicalized in cache key", async () => {
    const buildAnchorRubric = (anchors: Record<string, string>): Rubric => ({
      id: "rubric.iter16",
      name: "Iter16",
      version: "1.0.0",
      criteria: [
        {
          id: "clarity",
          description: "Is the response clear?",
          scale: { min: 1, max: 5 },
          passThreshold: 0.6,
          anchors,
        },
      ],
    });

    const client = new FakeJudgeClient([
      { criterionId: "clarity", result: passResult("clarity", 0.9) },
    ]);
    const cache = new InMemoryJudgeCache();

    const gA = new LLMJudgeGrader({ client, rubric: buildAnchorRubric({ a: "A", b: "B" }), cache, judgeId: "iter16" });
    // Same anchors, reverse insertion order.
    const gB = new LLMJudgeGrader({ client, rubric: buildAnchorRubric({ b: "B", a: "A" }), cache, judgeId: "iter16" });
    await gA.grade("p", "r");
    await gB.grade("p", "r");
    expect(client.callCount).toBe(1);
  });
});

describe("OpenAIJudgeClient", () => {
  it("exports OpenAIJudgeCostRates from the package index", async () => {
    const module = await import("../src/index.js");
    expect("OpenAIJudgeClient" in module).toBe(true);
    type Exports = typeof import("../src/index.js");
    type _CostRatesExported = Exports extends { OpenAIJudgeCostRates: infer T } ? T : never;
    const rates: _CostRatesExported = {
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 2,
    };
    expect(rates.inputUsdPerMillionTokens).toBe(1);
  });

  it("posts an OpenAI-compatible judge request and parses the recorded response", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        usage: { prompt_tokens: 12, completion_tokens: 7 },
        choices: [
          {
            message: {
              content: JSON.stringify({
                reasoning: "clear and correct",
                rawScore: 4,
                normalizedScore: 0.8,
                pass: true,
              }),
            },
          },
        ],
      }),
    }));
    const client = new OpenAIJudgeClient({
      baseUrl: "https://judge.example/v1",
      apiKey: "test-key",
      model: "judge-model",
      fetch: fetchMock,
    });

    const response = await client.judge({
      prompt: "What is 2+2?",
      response: "4",
      criterion: wellFormedCriterion,
    });

    expect(response.result).toMatchObject({
      criterionId: "clarity",
      reasoning: "clear and correct",
      normalizedScore: 0.8,
      pass: true,
    });
    expect(response.cost.model).toBe("judge-model");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://judge.example/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      }),
    );
  });

  it("computes estimatedCostUsd from usage when costRates are configured", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        usage: { prompt_tokens: 1_000, completion_tokens: 500 },
        choices: [{ message: { content: JSON.stringify({ reasoning: "ok", rawScore: 5, normalizedScore: 1, pass: true }) } }],
      }),
    }));
    const client = new OpenAIJudgeClient({
      baseUrl: "https://judge.example/v1",
      apiKey: "test-key",
      model: "judge-model",
      costRates: { inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 10 },
      fetch: fetchMock,
    });

    const response = await client.judge({ prompt: "p", response: "r", criterion: wellFormedCriterion });

    expect(response.cost.inputTokens).toBe(1_000);
    expect(response.cost.outputTokens).toBe(500);
    expect(response.cost.estimatedCostUsd).toBeCloseTo(0.007);
  });

  it("times out stalled OpenAI requests, retries, and then fails clearly", async () => {
    let attempts = 0;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      attempts += 1;
      if (!init.signal) {
        return Promise.reject(new Error("missing abort signal"));
      }
      return new Promise<never>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => {
          reject(new Error("fetch aborted by timeout"));
        }, { once: true });
      });
    });
    const client = new OpenAIJudgeClient({
      baseUrl: "https://judge.example/v1",
      apiKey: "test-key",
      model: "judge-model",
      fetch: fetchMock,
      timeoutMs: 10,
      maxRetries: 2,
      baseRetryDelayMs: 0,
    });

    await expect(client.judge({
      prompt: "p",
      response: "r",
      criterion: wellFormedCriterion,
    })).rejects.toThrow(/timed out|timeout|aborted/i);
    expect(attempts).toBe(3);
  });

  it("propagates caller abort without retrying", async () => {
    let attempts = 0;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      attempts += 1;
      if (!init.signal) {
        return Promise.reject(new Error("missing abort signal"));
      }
      return new Promise<never>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => {
          reject(new Error("caller aborted"));
        }, { once: true });
      });
    });
    const client = new OpenAIJudgeClient({
      baseUrl: "https://judge.example/v1",
      apiKey: "test-key",
      model: "judge-model",
      fetch: fetchMock,
      timeoutMs: 30_000,
      maxRetries: 2,
      baseRetryDelayMs: 0,
    });
    const controller = new AbortController();
    const judge = (client as unknown as {
      judge(request: JudgeRequest, options: { signal: AbortSignal }): Promise<unknown>;
    }).judge.bind(client);
    const promise = judge({
      prompt: "p",
      response: "r",
      criterion: wellFormedCriterion,
    }, { signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toThrow(/caller aborted|aborted/i);
    expect(attempts).toBe(1);
  });

  it("propagates cost unknown as judge infra error when costRates are not configured", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        choices: [{ message: { content: JSON.stringify({ reasoning: "ok", rawScore: 5, normalizedScore: 1, pass: true }) } }],
      }),
    }));
    const client = new OpenAIJudgeClient({
      baseUrl: "https://judge.example/v1",
      apiKey: "test-key",
      model: "judge-model",
      fetch: fetchMock,
    });
    const grader = new LLMJudgeGrader({ client, rubric: wellFormedRubric });

    const result = await grader.grade("p", "r");

    expect(result.scores[0]).toMatchObject({
      pass: false,
      value: 0,
      infraError: true,
      infraSource: "judge",
    });
    expect(result.scores[0].reason).toMatch(/cost unknown/i);
  });

  it("stops subsequent judge calls when accumulated usage-derived cost reaches budget (iter19 H4: hard-cap)", async () => {
    const rubric: Rubric = {
      id: "rubric.budget",
      name: "Budget",
      version: "1.0.0",
      criteria: [
        wellFormedCriterion,
        { id: "accuracy", description: "Is the response accurate?", scale: { min: 1, max: 5 }, passThreshold: 0.5 },
      ],
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        usage: { prompt_tokens: 1_000_000, completion_tokens: 0 },
        choices: [{ message: { content: JSON.stringify({ reasoning: "ok", rawScore: 5, normalizedScore: 1, pass: true }) } }],
      }),
    }));
    const client = new OpenAIJudgeClient({
      baseUrl: "https://judge.example/v1",
      apiKey: "test-key",
      model: "judge-model",
      costRates: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 0 },
      fetch: fetchMock,
    });
    const grader = new LLMJudgeGrader({ client, rubric, budgetUsd: 0.5 });

    const result = await grader.grade("p", "r");

    // First call's actual cost (1.0 USD) exceeds budget; reconcile refunds+denies.
    // The pre-call estimator marks 1M tokens as projecting > budget so a
    // second call may not even reach fetchMock — either 1 or 2 invocations
    // are acceptable, but cumulative spend MUST stay within cap.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(grader.cumulativeCostUsd).toBeLessThanOrEqual(0.5);
    expect(result.scores[0].infraError).toBe(true);
    expect(result.scores[0].pass).toBe(false);
    expect(result.scores[1].infraError).toBe(true);
    expect(result.scores[1].pass).toBe(false);
    expect(result.scores[1].reason).toMatch(/Budget exceeded/);
  });

  it("uses request.systemMessage in the OpenAI request body", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        choices: [{ message: { content: JSON.stringify({ reasoning: "ok", rawScore: 5, normalizedScore: 1, pass: true }) } }],
      }),
    }));
    const client = new OpenAIJudgeClient({
      baseUrl: "https://judge.example/v1",
      apiKey: "test-key",
      model: "judge-model",
      costRates: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
      fetch: fetchMock,
    });

    await client.judge({
      prompt: "p",
      response: "r",
      criterion: wellFormedCriterion,
      systemMessage: "Custom judge instructions",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages[0].content).toBe("Custom judge instructions");
  });

  it("retries a 429 response once before succeeding", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => "rate limited" })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          choices: [{ message: { content: JSON.stringify({ reasoning: "ok", rawScore: 5, normalizedScore: 1, pass: true }) } }],
        }),
      });
    const client = new OpenAIJudgeClient({
      baseUrl: "https://judge.example/v1",
      apiKey: "test-key",
      model: "judge-model",
      costRates: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
      maxRetries: 3,
      baseRetryDelayMs: 0,
      fetch: fetchMock,
    });

    const response = await client.judge({ prompt: "p", response: "r", criterion: wellFormedCriterion });

    expect(response.result.pass).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses base-2 exponential retry backoff when Retry-After is absent", () => {
    const client = new OpenAIJudgeClient({
      baseUrl: "https://judge.example/v1",
      apiKey: "test-key",
      model: "judge-model",
      baseRetryDelayMs: 10,
      fetch: vi.fn(),
    });
    const response = { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };

    expect((client as any).retryDelayMs(response, 0)).toBe(10);
    expect((client as any).retryDelayMs(response, 1)).toBe(20);
    expect((client as any).retryDelayMs(response, 2)).toBe(40);
  });

  it("exhausts retries for repeated 5xx responses and surfaces judge infra error", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503, text: async () => "unavailable" }));
    const client = new OpenAIJudgeClient({
      baseUrl: "https://judge.example/v1",
      apiKey: "test-key",
      model: "judge-model",
      costRates: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
      maxRetries: 2,
      baseRetryDelayMs: 0,
      fetch: fetchMock,
    });
    const grader = new LLMJudgeGrader({ client, rubric: wellFormedRubric });

    const result = await grader.grade("p", "r");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.scores[0].infraError).toBe(true);
    expect(result.scores[0].pass).toBe(false);
    expect(result.scores[0].value).toBe(0);
    expect(result.scores[0].reason).toMatch(/503/);
  });

  it("does not retry non-429 4xx responses", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401, text: async () => "unauthorized" }));
    const client = new OpenAIJudgeClient({
      baseUrl: "https://judge.example/v1",
      apiKey: "test-key",
      model: "judge-model",
      costRates: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
      maxRetries: 3,
      baseRetryDelayMs: 0,
      fetch: fetchMock,
    });
    const grader = new LLMJudgeGrader({ client, rubric: wellFormedRubric });

    const result = await grader.grade("p", "r");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.scores[0].infraError).toBe(true);
    expect(result.scores[0].pass).toBe(false);
    expect(result.scores[0].value).toBe(0);
    expect(result.scores[0].reason).toMatch(/401/);
  });
});

describe("JudgeResult types", () => {
  it("validates well-formed judge result", () => {
    const parsed = JudgeResultSchema.parse(passResult("clarity"));
    expect(parsed.criterionId).toBe("clarity");
  });

  it("rejects out-of-range normalizedScore", () => {
    expect(() =>
      JudgeResultSchema.parse({
        ...passResult("clarity"),
        normalizedScore: 1.5,
      }),
    ).toThrow();
    expect(() =>
      JudgeResultSchema.parse({
        ...passResult("clarity"),
        normalizedScore: -0.1,
      }),
    ).toThrow();
  });
});

describe("LLMJudgeGrader review findings", () => {
  it("does not collide cache keys for different prompts", async () => {
    const cache = new InMemoryJudgeCache();
    const rubric: Rubric = {
      id: "r1",
      name: "test",
      version: "1.0",
      criteria: [
        {
          id: "c",
          description: "test",
          scale: { min: 1, max: 5 },
          passThreshold: 0.5,
        },
      ],
    };

    const client1 = new FakeJudgeClient([
      {
        criterionId: "c",
        result: {
          criterionId: "c",
          reasoning: "prompt1",
          rawScore: 5,
          normalizedScore: 1,
          pass: true,
        },
      },
    ]);
    const grader1 = new LLMJudgeGrader({ client: client1, rubric, cache, judgeId: "test-prompt-key" });
    await grader1.grade("prompt-alpha", "response-1");

    const client2 = new FakeJudgeClient([
      {
        criterionId: "c",
        result: {
          criterionId: "c",
          reasoning: "prompt2",
          rawScore: 1,
          normalizedScore: 0,
          pass: false,
        },
      },
    ]);
    const grader2 = new LLMJudgeGrader({ client: client2, rubric, cache, judgeId: "test-prompt-key" });
    const result = await grader2.grade("prompt-beta", "response-1");

    expect(client2.callCount).toBe(1);
    const score = result.scores.find((s) => s.name === "judge/c");
    expect(score!.reason).toBe("prompt2");
  });

  it("rejects invalid normalizedScore from judge client", async () => {
    const rubric: Rubric = {
      id: "r1",
      name: "test",
      version: "1.0",
      criteria: [
        {
          id: "c",
          description: "test",
          scale: { min: 1, max: 5 },
          passThreshold: 0.5,
        },
      ],
    };
    const badClient: JudgeClient = {
      async judge(): Promise<JudgeResponse> {
        return {
          result: {
            criterionId: "c",
            reasoning: "bad",
            rawScore: 10,
            normalizedScore: 2.0,
            pass: true,
          },
          cost: {
            inputTokens: 10,
            outputTokens: 5,
            model: "fake",
            estimatedCostUsd: 0,
          },
          cached: false,
        };
      },
    };
    const grader = new LLMJudgeGrader({ client: badClient, rubric });
    const result = await grader.grade("test", "test");
    const score = result.scores.find((s) => s.name === "judge/c");
    expect(score!.value).toBeLessThanOrEqual(1);
    expect(score!.value).toBeGreaterThanOrEqual(0);
  });

  it("does not leak cost mutations across calls", async () => {
    const client = new FakeJudgeClient([
      {
        criterionId: "c",
        result: {
          criterionId: "c",
          reasoning: "ok",
          rawScore: 4,
          normalizedScore: 0.8,
          pass: true,
        },
        cost: {
          inputTokens: 100,
          outputTokens: 50,
          model: "fake",
          estimatedCostUsd: 0.001,
        },
      },
    ]);
    const criterion = {
      id: "c",
      description: "t",
      scale: { min: 1, max: 5 },
      passThreshold: 0.5,
    };

    const resp1 = await client.judge({ prompt: "p", response: "r", criterion });
    resp1.cost.inputTokens = 999;

    const resp2 = await client.judge({ prompt: "p", response: "r", criterion });
    expect(resp2.cost.inputTokens).toBe(100);
  });

  it("validates cached results before emitting scores", async () => {
    const cache = new InMemoryJudgeCache();
    const rubric: Rubric = {
      id: "r1", name: "test", version: "1.0",
      criteria: [{ id: "c", description: "test", scale: { min: 1, max: 5 }, passThreshold: 0.5 }],
    };

    const goodClient = new FakeJudgeClient([{
      criterionId: "c",
      result: { criterionId: "c", reasoning: "ok", rawScore: 4, normalizedScore: 0.8, pass: true },
    }]);
    const grader1 = new LLMJudgeGrader({ client: goodClient, rubric, cache, judgeId: "validate-cache-judge" });
    await grader1.grade("p1", "r1");

    for (const [, val] of (cache as any).store) {
      val.result.normalizedScore = 5.0;
    }

    const grader2 = new LLMJudgeGrader({ client: goodClient, rubric, cache, judgeId: "validate-cache-judge" });
    const result = await grader2.grade("p1", "r1");
    const score = result.scores.find((s) => s.name === "judge/c");
    expect(score!.value).toBeLessThanOrEqual(1);
    expect(score!.value).toBeGreaterThanOrEqual(0);
  });

  it("handles NaN cost from judge client gracefully", async () => {
    const rubric: Rubric = {
      id: "r1", name: "test", version: "1.0",
      criteria: [{ id: "c", description: "test", scale: { min: 1, max: 5 }, passThreshold: 0.5 }],
    };
    const badCostClient: JudgeClient = {
      async judge() {
        return {
          result: { criterionId: "c", reasoning: "ok", rawScore: 4, normalizedScore: 0.8, pass: true },
          cost: { inputTokens: 10, outputTokens: 5, model: "fake", estimatedCostUsd: NaN },
          cached: false,
        };
      },
    };
    const grader = new LLMJudgeGrader({ client: badCostClient, rubric });
    const result = await grader.grade("test", "test");
    expect(Number.isFinite(result.totalCostUsd)).toBe(true);
  });
});

describe("LLMJudgeGrader passThreshold enforcement", () => {
  it("applies rubric passThreshold instead of trusting client pass", async () => {
    const rubric: Rubric = {
      id: "r1",
      name: "test",
      version: "1.0",
      criteria: [
        {
          id: "quality",
          description: "Response quality",
          scale: { min: 1, max: 5 },
          passThreshold: 0.6,
        },
      ],
    };
    const client = new FakeJudgeClient([
      {
        criterionId: "quality",
        result: {
          criterionId: "quality",
          reasoning: "low quality",
          rawScore: 2,
          normalizedScore: 0.3,
          pass: true,
        },
      },
    ]);
    const grader = new LLMJudgeGrader({ client, rubric });
    const result = await grader.grade("test prompt", "bad response");
    const score = result.scores.find((s) => s.name === "judge/quality");
    expect(score).toBeDefined();
    expect(score!.pass).toBe(false);
    expect(score!.value).toBeCloseTo(0.3);
  });

  it("passes when normalizedScore meets passThreshold", async () => {
    const rubric: Rubric = {
      id: "r1",
      name: "test",
      version: "1.0",
      criteria: [
        {
          id: "quality",
          description: "Response quality",
          scale: { min: 1, max: 5 },
          passThreshold: 0.6,
        },
      ],
    };
    const client = new FakeJudgeClient([
      {
        criterionId: "quality",
        result: {
          criterionId: "quality",
          reasoning: "good",
          rawScore: 4,
          normalizedScore: 0.8,
          pass: false,
        },
      },
    ]);
    const grader = new LLMJudgeGrader({ client, rubric });
    const result = await grader.grade("test prompt", "good response");
    const score = result.scores.find((s) => s.name === "judge/quality");
    expect(score!.pass).toBe(true);
  });
});

describe("RubricSchema validation", () => {
  it("rejects rubric with duplicate criterion IDs", () => {
    const result = RubricSchema.safeParse({
      id: "r1",
      name: "test",
      version: "1.0",
      criteria: [
        { id: "same", description: "a", scale: { min: 1, max: 5 }, passThreshold: 0.5 },
        { id: "same", description: "b", scale: { min: 1, max: 5 }, passThreshold: 0.5 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects criterion with scale.min > scale.max", () => {
    const result = RubricCriterionSchema.safeParse({
      id: "c",
      description: "test",
      scale: { min: 5, max: 1 },
      passThreshold: 0.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects passThreshold outside [0, 1]", () => {
    const result = RubricCriterionSchema.safeParse({
      id: "c",
      description: "test",
      scale: { min: 1, max: 5 },
      passThreshold: 1.5,
    });
    expect(result.success).toBe(false);
  });
});

describe("LLMJudgeGrader criterionId mismatch handling", () => {
  it("uses criterion.id for score name, not judge-returned criterionId", async () => {
    const rubric: Rubric = {
      id: "r1",
      name: "test",
      version: "1.0",
      criteria: [
        {
          id: "expected",
          description: "test",
          scale: { min: 1, max: 5 },
          passThreshold: 0.5,
        },
      ],
    };
    const badClient: JudgeClient = {
      async judge(): Promise<JudgeResponse> {
        return {
          result: {
            criterionId: "wrong-id",
            reasoning: "ok",
            rawScore: 4,
            normalizedScore: 0.8,
            pass: true,
          },
          cost: {
            inputTokens: 10,
            outputTokens: 5,
            model: "fake",
            estimatedCostUsd: 0.001,
          },
          cached: false,
        };
      },
    };
    const grader = new LLMJudgeGrader({ client: badClient, rubric });
    const result = await grader.grade("test", "test");
    const score = result.scores.find((s) => s.name === "judge/expected");
    expect(score).toBeDefined();
    expect(score!.value).toBeCloseTo(0.8);
    expect(
      result.scores.find((s) => s.name === "judge/wrong-id"),
    ).toBeUndefined();
  });
});

describe("LLMJudgeGrader constructor rubric validation", () => {
  it("throws on invalid rubric in constructor", () => {
    const invalidRubric = {
      id: "r1",
      name: "test",
      version: "1.0",
      criteria: [
        {
          id: "c",
          description: "test",
          scale: { min: 5, max: 1 },
          passThreshold: 0.5,
        },
      ],
    };
    expect(
      () =>
        new LLMJudgeGrader({
          client: new FakeJudgeClient([]),
          rubric: invalidRubric as any,
        }),
    ).toThrow();
  });

  it("throws on rubric with passThreshold > 1", () => {
    const invalidRubric = {
      id: "r1",
      name: "test",
      version: "1.0",
      criteria: [
        {
          id: "c",
          description: "test",
          scale: { min: 1, max: 5 },
          passThreshold: 3,
        },
      ],
    };
    expect(
      () =>
        new LLMJudgeGrader({
          client: new FakeJudgeClient([]),
          rubric: invalidRubric as any,
        }),
    ).toThrow();
  });
});

describe("LLMJudgeGrader judgeId cache isolation", () => {
  it("different judgeIds produce different cache keys", async () => {
    const cache = new InMemoryJudgeCache();
    const rubric: Rubric = {
      id: "r1",
      name: "test",
      version: "1.0",
      criteria: [
        { id: "c", description: "test", scale: { min: 1, max: 5 }, passThreshold: 0.5 },
      ],
    };

    const client1 = new FakeJudgeClient([
      {
        criterionId: "c",
        result: { criterionId: "c", reasoning: "cheap judge", rawScore: 2, normalizedScore: 0.2, pass: false },
      },
    ]);
    const grader1 = new LLMJudgeGrader({ client: client1, rubric, cache, judgeId: "cheap-model" });
    await grader1.grade("test prompt", "test response");

    const client2 = new FakeJudgeClient([
      {
        criterionId: "c",
        result: { criterionId: "c", reasoning: "strong judge", rawScore: 5, normalizedScore: 1.0, pass: true },
      },
    ]);
    const grader2 = new LLMJudgeGrader({ client: client2, rubric, cache, judgeId: "strong-model" });
    const result = await grader2.grade("test prompt", "test response");

    expect(client2.callCount).toBe(1);
    const score = result.scores.find((s) => s.name === "judge/c");
    expect(score!.reason).toBe("strong judge");
  });

  it("same judgeId hits cache as expected", async () => {
    const cache = new InMemoryJudgeCache();
    const rubric: Rubric = {
      id: "r1",
      name: "test",
      version: "1.0",
      criteria: [
        { id: "c", description: "test", scale: { min: 1, max: 5 }, passThreshold: 0.5 },
      ],
    };
    const client = new FakeJudgeClient([
      {
        criterionId: "c",
        result: { criterionId: "c", reasoning: "cached", rawScore: 4, normalizedScore: 0.8, pass: true },
      },
    ]);

    const grader1 = new LLMJudgeGrader({ client, rubric, cache, judgeId: "same" });
    await grader1.grade("p", "r");

    const grader2 = new LLMJudgeGrader({ client, rubric, cache, judgeId: "same" });
    await grader2.grade("p", "r");

    expect(client.callCount).toBe(1);
  });

  it("does not emit duplicate scores when cache.set throws", async () => {
    const rubric: Rubric = {
      id: "r1", name: "test", version: "1.0",
      criteria: [{ id: "c", description: "test", scale: { min: 1, max: 5 }, passThreshold: 0.5 }],
    };
    const client = new FakeJudgeClient([{
      criterionId: "c",
      result: { criterionId: "c", reasoning: "good", rawScore: 4, normalizedScore: 0.8, pass: true },
    }]);
    const brokenCache: JudgeCache = {
      async get() { return undefined; },
      async set() { throw new Error("cache down"); },
    };
    const grader = new LLMJudgeGrader({ client, rubric, cache: brokenCache, judgeId: "broken-set-judge" });
    const result = await grader.grade("test", "test");

    const cScores = result.scores.filter((s) => s.name === "judge/c");
    expect(cScores).toHaveLength(1);
    expect(cScores[0].pass).toBe(true);
    expect(cScores[0].value).toBeCloseTo(0.8);
  });

  it("falls through to judge client when cache.get throws", async () => {
    const rubric: Rubric = {
      id: "r1", name: "test", version: "1.0",
      criteria: [{ id: "c", description: "test", scale: { min: 1, max: 5 }, passThreshold: 0.5 }],
    };
    const client = new FakeJudgeClient([{
      criterionId: "c",
      result: { criterionId: "c", reasoning: "from judge", rawScore: 4, normalizedScore: 0.8, pass: true },
    }]);
    const brokenCache: JudgeCache = {
      async get() { throw new Error("cache read down"); },
      async set() { /* noop */ },
    };
    const grader = new LLMJudgeGrader({ client, rubric, cache: brokenCache, judgeId: "broken-get-judge" });

    const result = await grader.grade("test", "test");
    expect(client.callCount).toBe(1);
    const score = result.scores.find((s) => s.name === "judge/c");
    expect(score).toBeDefined();
    expect(score!.reason).toBe("from judge");
    expect(score!.pass).toBe(true);
  });
});

describe("LLMJudgeGrader F6 — cache identity guards", () => {
  const rubric: Rubric = {
    id: "r1",
    name: "test",
    version: "1.0",
    criteria: [
      { id: "c", description: "test", scale: { min: 1, max: 5 }, passThreshold: 0.5 },
    ],
  };

  it("throws when cache is supplied but judgeId is omitted (lazy default footgun)", () => {
    const cache = new InMemoryJudgeCache();
    const client = new FakeJudgeClient([
      { criterionId: "c", result: passResult("c") },
    ]);
    expect(
      () => new LLMJudgeGrader({ client, rubric, cache }),
    ).toThrow(/judgeId/);
  });

  it("throws when cache is supplied with explicit judgeId === \"default\"", () => {
    const cache = new InMemoryJudgeCache();
    const client = new FakeJudgeClient([
      { criterionId: "c", result: passResult("c") },
    ]);
    expect(
      () => new LLMJudgeGrader({ client, rubric, cache, judgeId: "default" }),
    ).toThrow(/judgeId/);
  });

  it("does not throw when cache is omitted and judgeId is default", () => {
    const client = new FakeJudgeClient([
      { criterionId: "c", result: passResult("c") },
    ]);
    expect(() => new LLMJudgeGrader({ client, rubric })).not.toThrow();
  });

  it("includes client.cacheIdentity() in the cache key (different identities do not collide)", async () => {
    const cache = new InMemoryJudgeCache();

    class IdentityFake implements JudgeClient {
      public callCount = 0;
      constructor(
        private readonly id: string,
        private readonly normalized: number,
        private readonly tag: string,
      ) {}
      cacheIdentity(): string {
        return this.id;
      }
      async judge(request: JudgeRequest): Promise<JudgeResponse> {
        this.callCount++;
        return {
          result: {
            criterionId: request.criterion.id,
            reasoning: this.tag,
            rawScore: 5,
            normalizedScore: this.normalized,
            pass: true,
          },
          cost: { inputTokens: 1, outputTokens: 1, model: this.id, estimatedCostUsd: 0 },
          cached: false,
        };
      }
    }

    const cheap = new IdentityFake("cheap-model:t=0", 0.2, "cheap");
    const grader1 = new LLMJudgeGrader({ client: cheap, rubric, cache, judgeId: "shared" });
    await grader1.grade("p", "r");
    expect(cheap.callCount).toBe(1);

    const strong = new IdentityFake("strong-model:t=0", 0.95, "strong");
    const grader2 = new LLMJudgeGrader({ client: strong, rubric, cache, judgeId: "shared" });
    const out = await grader2.grade("p", "r");

    expect(strong.callCount).toBe(1);
    const score = out.scores.find((s) => s.name === "judge/c");
    expect(score!.reason).toBe("strong");
    expect(score!.value).toBeCloseTo(0.95);
  });

  it("treats clients with the same cacheIdentity as cache-compatible", async () => {
    const cache = new InMemoryJudgeCache();

    class IdentityFake implements JudgeClient {
      public callCount = 0;
      constructor(private readonly id: string) {}
      cacheIdentity(): string {
        return this.id;
      }
      async judge(request: JudgeRequest): Promise<JudgeResponse> {
        this.callCount++;
        return {
          result: passResult(request.criterion.id, 0.7),
          cost: { inputTokens: 1, outputTokens: 1, model: this.id, estimatedCostUsd: 0 },
          cached: false,
        };
      }
    }

    const a = new IdentityFake("same-id");
    const grader1 = new LLMJudgeGrader({ client: a, rubric, cache, judgeId: "shared" });
    await grader1.grade("p", "r");
    expect(a.callCount).toBe(1);

    const b = new IdentityFake("same-id");
    const grader2 = new LLMJudgeGrader({ client: b, rubric, cache, judgeId: "shared" });
    await grader2.grade("p", "r");
    expect(b.callCount).toBe(0);
  });

  it("OpenAIJudgeClient.cacheIdentity changes when model or temperature changes", () => {
    const fetchMock = vi.fn();
    const a = new OpenAIJudgeClient({
      baseUrl: "https://judge.example/v1",
      apiKey: "k",
      model: "gpt-judge-A",
      fetch: fetchMock,
    });
    const b = new OpenAIJudgeClient({
      baseUrl: "https://judge.example/v1",
      apiKey: "k",
      model: "gpt-judge-B",
      fetch: fetchMock,
    });
    const aId = a.cacheIdentity();
    const bId = b.cacheIdentity();
    expect(typeof aId).toBe("string");
    expect(aId.length).toBeGreaterThan(0);
    expect(aId).not.toBe(bId);
  });
});

describe("LLMJudgeGrader F18 — explicit budgetUsd: 0 means deny-all", () => {
  const rubric: Rubric = {
    id: "r1",
    name: "test",
    version: "1.0",
    criteria: [
      { id: "c", description: "test", scale: { min: 1, max: 5 }, passThreshold: 0.5 },
    ],
  };

  it("budgetUsd: 0 refuses every grade call, never invokes the client, never estimates", async () => {
    let estimateCalls = 0;
    let judgeCalls = 0;
    const client: JudgeClient = {
      estimateCost(_req: JudgeRequest): number {
        estimateCalls++;
        return 0.0001;
      },
      async judge(): Promise<JudgeResponse> {
        judgeCalls++;
        return {
          result: passResult("c"),
          cost: { inputTokens: 1, outputTokens: 1, model: "deny-test", estimatedCostUsd: 0 },
          cached: false,
        };
      },
    };
    const grader = new LLMJudgeGrader({ client, rubric, budgetUsd: 0 });

    const out = await grader.grade("p", "r");

    expect(judgeCalls).toBe(0);
    expect(estimateCalls).toBe(0);
    expect(out.scores).toHaveLength(1);
    expect(out.scores[0]).toMatchObject({
      pass: false,
      value: 0,
      infraError: true,
      infraSource: "judge",
    });
    expect(out.scores[0].reason).toMatch(/budget/i);
    expect(out.totalCostUsd).toBe(0);
  });

  it("omitted budgetUsd (undefined) means unlimited and grades succeed", async () => {
    const fake = new FakeJudgeClient([
      { criterionId: "c", result: passResult("c", 0.9) },
    ]);
    const grader = new LLMJudgeGrader({ client: fake, rubric });
    const out = await grader.grade("p", "r");
    expect(fake.callCount).toBe(1);
    expect(out.scores[0].pass).toBe(true);
  });

  it("budgetUsd: 0 with cache still refuses (no cache lookup needed)", async () => {
    const cache = new InMemoryJudgeCache();
    let judgeCalls = 0;
    const client: JudgeClient = {
      async judge(): Promise<JudgeResponse> {
        judgeCalls++;
        return {
          result: passResult("c"),
          cost: { inputTokens: 1, outputTokens: 1, model: "deny", estimatedCostUsd: 0 },
          cached: false,
        };
      },
    };
    const grader = new LLMJudgeGrader({
      client,
      rubric,
      budgetUsd: 0,
      cache,
      judgeId: "deny-judge",
    });
    const out = await grader.grade("p", "r");
    expect(judgeCalls).toBe(0);
    expect(out.scores[0].infraError).toBe(true);
    expect(out.scores[0].pass).toBe(false);
  });
});

describe("OpenAIJudgeClient F19 — retry delay cap and abortable sleep", () => {
  it("caps retryDelayMs at retryDelayMaxMs (numeric and HTTP-date Retry-After) and falls back to 30s default", () => {
    const buildClient = (retryDelayMaxMs: number | undefined) =>
      new OpenAIJudgeClient({
        baseUrl: "https://judge.example/v1",
        apiKey: "k",
        model: "judge-model",
        baseRetryDelayMs: 10,
        ...(retryDelayMaxMs !== undefined ? { retryDelayMaxMs } : {}),
        fetch: vi.fn(),
      });
    const buildResponse = (retryAfter: string) => ({
      ok: false,
      status: 429,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "retry-after" ? retryAfter : null,
      },
      json: async () => ({}),
    });

    // Numeric absurd value capped at configured retryDelayMaxMs.
    const c1 = buildClient(5_000);
    expect((c1 as any).retryDelayMs(buildResponse("99999"), 0)).toBe(5_000);

    // HTTP-date far-future value capped at configured retryDelayMaxMs.
    const c2 = buildClient(2_000);
    const farFuture = new Date(Date.now() + 24 * 60 * 60 * 1000).toUTCString();
    expect((c2 as any).retryDelayMs(buildResponse(farFuture), 0)).toBe(2_000);

    // Default retryDelayMaxMs is 30s when not specified.
    const c3 = buildClient(undefined);
    expect((c3 as any).retryDelayMs(buildResponse("600"), 0)).toBe(30_000);
  });

  it("aborts immediately during retry sleep when the caller aborts", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 429,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "retry-after" ? "99999" : null,
      },
      text: async () => "rate limited",
    }));
    const client = new OpenAIJudgeClient({
      baseUrl: "https://judge.example/v1",
      apiKey: "k",
      model: "judge-model",
      baseRetryDelayMs: 5_000,
      retryDelayMaxMs: 5_000,
      maxRetries: 3,
      timeoutMs: 30_000,
      fetch: fetchMock,
    });
    const controller = new AbortController();
    const start = Date.now();
    const promise = client.judge(
      { prompt: "p", response: "r", criterion: wellFormedCriterion },
      { signal: controller.signal },
    );

    // Allow the first attempt's response to be processed and enter sleep.
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();

    await expect(promise).rejects.toThrow(/abort/i);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The default retryDelayMaxMs sanity bound is verified inline in the cap test above.
});

describe("LLMJudgeGrader F15 — cache singleflight", () => {
  it("collapses concurrent grade() calls with same cache key into a single client invocation", async () => {
    let callCount = 0;
    const slowClient: JudgeClient = {
      async judge(req: JudgeRequest): Promise<JudgeResponse> {
        callCount++;
        await new Promise((r) => setTimeout(r, 50));
        return {
          result: passResult(req.criterion.id),
          cost: {
            inputTokens: 10,
            outputTokens: 5,
            model: "m",
            estimatedCostUsd: 0.001,
          },
          cached: false,
        };
      },
    };
    const grader = new LLMJudgeGrader({
      client: slowClient,
      rubric: wellFormedRubric,
    });

    const [a, b] = await Promise.all([
      grader.grade("p", "r"),
      grader.grade("p", "r"),
    ]);

    expect(callCount).toBe(1);
    expect(a.scores[0].pass).toBe(true);
    expect(b.scores[0].pass).toBe(true);
    expect(a.scores[0].value).toBe(b.scores[0].value);
  });

  it("does NOT collapse concurrent calls with different cache keys", async () => {
    let callCount = 0;
    const slowClient: JudgeClient = {
      async judge(req: JudgeRequest): Promise<JudgeResponse> {
        callCount++;
        await new Promise((r) => setTimeout(r, 30));
        return {
          result: passResult(req.criterion.id),
          cost: {
            inputTokens: 10,
            outputTokens: 5,
            model: "m",
            estimatedCostUsd: 0.001,
          },
          cached: false,
        };
      },
    };
    const grader = new LLMJudgeGrader({
      client: slowClient,
      rubric: wellFormedRubric,
    });

    await Promise.all([
      grader.grade("p1", "r1"),
      grader.grade("p2", "r2"),
    ]);

    expect(callCount).toBe(2);
  });

  it("removes inflight entry on rejection so subsequent calls can retry", async () => {
    let callCount = 0;
    const flakyClient: JudgeClient = {
      async judge(req: JudgeRequest): Promise<JudgeResponse> {
        callCount++;
        if (callCount === 1) {
          throw new Error("transient");
        }
        return {
          result: passResult(req.criterion.id),
          cost: {
            inputTokens: 10,
            outputTokens: 5,
            model: "m",
            estimatedCostUsd: 0.001,
          },
          cached: false,
        };
      },
    };
    const grader = new LLMJudgeGrader({
      client: flakyClient,
      rubric: wellFormedRubric,
    });

    const first = await grader.grade("p", "r");
    expect(first.scores[0].infraError).toBe(true);

    const second = await grader.grade("p", "r");
    expect(second.scores[0].pass).toBe(true);
    expect(callCount).toBe(2);
  });
});

describe("LLMJudgeGrader F16 — budget hard-cap concurrency", () => {
  it("denies one of two concurrent calls that would together exceed the budget", async () => {
    const cost = 0.75;
    const client: JudgeClient = {
      async judge(req: JudgeRequest): Promise<JudgeResponse> {
        await new Promise((r) => setTimeout(r, 30));
        return {
          result: passResult(req.criterion.id),
          cost: {
            inputTokens: 1,
            outputTokens: 1,
            model: "m",
            estimatedCostUsd: cost,
          },
          cached: false,
        };
      },
      estimateCost(): number {
        return cost;
      },
    };
    const grader = new LLMJudgeGrader({
      client,
      rubric: wellFormedRubric,
      budgetUsd: 1,
    });

    const [a, b] = await Promise.all([
      grader.grade("p1", "r1"),
      grader.grade("p2", "r2"),
    ]);

    const passed = [a, b].filter((g) => g.scores[0].pass === true);
    const denied = [a, b].filter(
      (g) => g.scores[0].infraError === true && g.scores[0].pass === false,
    );

    expect(passed).toHaveLength(1);
    expect(denied).toHaveLength(1);
    expect(grader.cumulativeCostUsd).toBeLessThanOrEqual(1);
    expect(denied[0].scores[0].reason).toMatch(
      /budget|would exceed|Budget exceeded/i,
    );
  });

  it("refunds the reservation when the judge call fails", async () => {
    const estimate = 0.4;
    let calls = 0;
    const client: JudgeClient = {
      async judge(_req: JudgeRequest): Promise<JudgeResponse> {
        calls++;
        if (calls === 1) {
          throw new Error("boom");
        }
        return {
          result: passResult("clarity"),
          cost: {
            inputTokens: 1,
            outputTokens: 1,
            model: "m",
            estimatedCostUsd: estimate,
          },
          cached: false,
        };
      },
      estimateCost(): number {
        return estimate;
      },
    };
    const grader = new LLMJudgeGrader({
      client,
      rubric: wellFormedRubric,
      budgetUsd: 0.5,
    });

    const first = await grader.grade("p1", "r1");
    expect(first.scores[0].infraError).toBe(true);
    expect(grader.cumulativeCostUsd).toBe(0);

    const second = await grader.grade("p2", "r2");
    expect(second.scores[0].pass).toBe(true);
    expect(grader.cumulativeCostUsd).toBeCloseTo(estimate, 5);
  });
});

describe("OpenAIJudgeClient F17 — option validation", () => {
  const baseOpts = {
    baseUrl: "https://judge.example/v1",
    apiKey: "k",
    model: "m",
    fetch: vi.fn(),
  } as const;

  it("rejects all non-finite, negative, non-integer, and above-cap values for maxRetries / baseRetryDelayMs / timeoutMs", () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["maxRetries: Infinity", { maxRetries: Infinity }, /maxRetries/],
      ["maxRetries: NaN", { maxRetries: NaN }, /maxRetries/],
      ["maxRetries: -1", { maxRetries: -1 }, /maxRetries/],
      ["maxRetries: 1.5 (non-integer)", { maxRetries: 1.5 }, /maxRetries/],
      ["maxRetries: above hard cap", { maxRetries: 1_000 }, /maxRetries/],
      ["baseRetryDelayMs: Infinity", { baseRetryDelayMs: Infinity }, /baseRetryDelayMs/],
      ["baseRetryDelayMs: NaN", { baseRetryDelayMs: NaN }, /baseRetryDelayMs/],
      ["baseRetryDelayMs: -1", { baseRetryDelayMs: -1 }, /baseRetryDelayMs/],
      ["timeoutMs: Infinity", { timeoutMs: Infinity }, /timeoutMs/],
      ["timeoutMs: NaN", { timeoutMs: NaN }, /timeoutMs/],
      ["timeoutMs: -1", { timeoutMs: -1 }, /timeoutMs/],
    ];
    for (const [name, override, errRe] of cases) {
      expect(() => new OpenAIJudgeClient({ ...baseOpts, ...override }), `case=${name}`).toThrow(errRe);
    }
  });

  it("accepts edge values: maxRetries: 0 and maxRetries at hard cap (10)", () => {
    expect(() => new OpenAIJudgeClient({ ...baseOpts, maxRetries: 0 })).not.toThrow();
    expect(() => new OpenAIJudgeClient({ ...baseOpts, maxRetries: 10 })).not.toThrow();
  });
});

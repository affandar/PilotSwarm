import { describe, it, expect } from "vitest";
import { matchArgs } from "../src/graders/match-args.js";
import { gradeOrdering } from "../src/graders/ordering.js";
import { gradeTrajectory } from "../src/graders/trajectory.js";
import { LLMJudgeGrader } from "../src/graders/llm-judge.js";
import { FakeJudgeClient } from "../src/graders/fake-judge-client.js";
import { InMemoryJudgeCache } from "../src/graders/judge-cache.js";
import { OpenAIJudgeClient } from "../src/graders/openai-judge-client.js";
import type { JudgeResult, Rubric } from "../src/types.js";
import type { EvalToolCall, ObservedToolCall, ObservedTrajectory, TrajectorySample } from "../src/types.js";

function trajWithResponses(responses: string[]) {
  const observed: ObservedTrajectory = {
    sessionId: "s",
    model: "m",
    turns: responses.map((r, i) => ({ toolCalls: [], response: r, latencyMs: 0, turnIndex: i })),
  };
  const sample = (term: string): TrajectorySample => ({
    id: "t",
    description: "",
    turns: responses.map(() => ({ userMessage: "u", expected: { response: { kind: "any" } } })),
    expected: { contextRetention: [{ term, mustAppearAfterTurn: -1 }] },
  });
  return { observed, sample };
}

function ctxRetentionPass(observed: ObservedTrajectory, sample: TrajectorySample): boolean {
  const result = gradeTrajectory(observed, sample);
  const cr = result.crossTurnScores.find((s) => s.name.startsWith("context-retention/"));
  return cr?.pass === true;
}

describe("F8: unicode-aware contextRetention containment", () => {
  it("matches symbol-bearing and non-ASCII terms (C++, .NET, café, 東京) and respects boundaries", () => {
    let { observed, sample } = trajWithResponses(["I love C++ programming."]);
    expect(ctxRetentionPass(observed, sample("C++"))).toBe(true);
    expect(ctxRetentionPass(observed, sample("C"))).toBe(false);

    ({ observed, sample } = trajWithResponses([".NET is mature."]));
    expect(ctxRetentionPass(observed, sample(".NET"))).toBe(true);

    ({ observed, sample } = trajWithResponses(["I visited 東京 last spring."]));
    expect(ctxRetentionPass(observed, sample("東京"))).toBe(true);

    ({ observed, sample } = trajWithResponses(["Met at the café yesterday."]));
    expect(ctxRetentionPass(observed, sample("café"))).toBe(true);

    ({ observed, sample } = trajWithResponses(["The grade was C overall."]));
    expect(ctxRetentionPass(observed, sample("C"))).toBe(true);
  });
});

describe("F20: matchArgs exact mode structural equality", () => {
  it("respects key presence and Object.is semantics for NaN/0/-0/Infinity nested deeply", () => {
    expect(matchArgs({ a: undefined } as Record<string, unknown>, {}, "exact").pass).toBe(false);
    expect(
      matchArgs(
        { a: undefined } as Record<string, unknown>,
        { a: undefined } as Record<string, unknown>,
        "exact",
      ).pass,
    ).toBe(true);

    expect(matchArgs({ a: NaN }, { a: NaN }, "exact").pass).toBe(true);
    expect(matchArgs({ a: NaN }, { a: null }, "exact").pass).toBe(false);
    expect(matchArgs({ a: 0 }, { a: -0 }, "exact").pass).toBe(false);
    expect(matchArgs({ a: Infinity }, { a: Infinity }, "exact").pass).toBe(true);
    expect(matchArgs({ a: Infinity }, { a: -Infinity }, "exact").pass).toBe(false);

    expect(matchArgs({ x: { y: [1, 2, { z: NaN }] } }, { x: { y: [1, 2, { z: NaN }] } }, "exact").pass).toBe(
      true,
    );
    expect(matchArgs({ x: { y: [1, 2, { z: 0 }] } }, { x: { y: [1, 2, { z: -0 }] } }, "exact").pass).toBe(
      false,
    );
  });

  it("subset mode unaffected by F20 (reference behavior preserved)", () => {
    expect(matchArgs({ a: 1, b: 2 }, { a: 1 }, "subset").pass).toBe(true);
  });
});

describe("F21: cache key includes canonical criterion content", () => {
  const baseRubric = (description: string): Rubric => ({
    id: "rubric.f21",
    name: "F21",
    version: "1.0.0",
    criteria: [{ id: "clarity", description, scale: { min: 1, max: 5 }, passThreshold: 0.6 }],
  });
  const passRes: JudgeResult = {
    criterionId: "clarity",
    reasoning: "ok",
    rawScore: 5,
    normalizedScore: 0.9,
    pass: true,
  };

  it("differing criterion content (description, passThreshold) ⇒ cache MISS; identical ⇒ HIT", async () => {
    const fake = new FakeJudgeClient([{ criterionId: "clarity", result: passRes }]);
    const cache = new InMemoryJudgeCache();
    const desc = "Is it clear?";
    const g1 = new LLMJudgeGrader({ client: fake, rubric: baseRubric(desc), cache, judgeId: "j" });
    await g1.grade("p", "r");
    expect(fake.callCount).toBe(1);

    // identical → hit
    const g2 = new LLMJudgeGrader({ client: fake, rubric: baseRubric(desc), cache, judgeId: "j" });
    await g2.grade("p", "r");
    expect(fake.callCount).toBe(1);

    // different description → miss
    const g3 = new LLMJudgeGrader({
      client: fake,
      rubric: baseRubric("Is the response well-structured and clear?"),
      cache,
      judgeId: "j",
    });
    await g3.grade("p", "r");
    expect(fake.callCount).toBe(2);

    // different passThreshold → miss
    const r2 = baseRubric(desc);
    r2.criteria[0] = { ...r2.criteria[0], passThreshold: 0.9 };
    const g4 = new LLMJudgeGrader({ client: fake, rubric: r2, cache, judgeId: "j" });
    await g4.grade("p", "r");
    expect(fake.callCount).toBe(3);
  });
});

describe("F22: cached prompt token billing", () => {
  function makeFakeFetch(responseBody: unknown) {
    return async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => "",
      json: async () => responseBody,
    });
  }
  const judgeRequest = {
    prompt: "p",
    response: "r",
    criterion: { id: "clarity", description: "d", scale: { min: 1, max: 5 }, passThreshold: 0.6 },
  };
  const judgeJsonContent = JSON.stringify({ reasoning: "ok", rawScore: 5, normalizedScore: 0.9, pass: true });

  it("default cachedInputRate (0.5x), explicit override, and absent cached_tokens compute correct cost", async () => {
    const inputRate = 10 * 1_000_000;
    const outputRate = 20 * 1_000_000;
    const usage = { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 80 } };

    // default cached rate = 0.5 * input
    const c1 = new OpenAIJudgeClient({
      baseUrl: "https://x",
      apiKey: "k",
      model: "m",
      fetch: makeFakeFetch({ choices: [{ message: { content: judgeJsonContent } }], usage }) as never,
      costRates: { inputUsdPerMillionTokens: inputRate, outputUsdPerMillionTokens: outputRate },
    });
    expect((await c1.judge(judgeRequest)).cost.estimatedCostUsd).toBeCloseTo(1600, 6);

    // explicit override
    const c2 = new OpenAIJudgeClient({
      baseUrl: "https://x",
      apiKey: "k",
      model: "m",
      fetch: makeFakeFetch({ choices: [{ message: { content: judgeJsonContent } }], usage }) as never,
      costRates: {
        inputUsdPerMillionTokens: inputRate,
        outputUsdPerMillionTokens: outputRate,
        cachedInputUsdPerMillionTokens: 1 * 1_000_000,
      },
    });
    expect((await c2.judge(judgeRequest)).cost.estimatedCostUsd).toBeCloseTo(1280, 6);

    // absent cached_tokens
    const c3 = new OpenAIJudgeClient({
      baseUrl: "https://x",
      apiKey: "k",
      model: "m",
      fetch: makeFakeFetch({
        choices: [{ message: { content: judgeJsonContent } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }) as never,
      costRates: { inputUsdPerMillionTokens: inputRate, outputUsdPerMillionTokens: outputRate },
    });
    expect((await c3.judge(judgeRequest)).cost.estimatedCostUsd).toBeCloseTo(2000, 6);
  });
});

describe("F28: ordering grader clamps value < 1 on failure", () => {
  const obs = (name: string, order: number): ObservedToolCall => ({ name, args: {}, order });

  it("partial matches clamp value<1 with pass=false; full match returns value=1 pass=true", () => {
    const partial = gradeOrdering(
      [obs("a", 0), obs("b", 1)],
      [
        { name: "a", match: "subset" },
        { name: "b", match: "subset" },
        { name: "c", match: "subset" },
      ] as EvalToolCall[],
      "exactSequence",
    );
    expect(partial.pass).toBe(false);
    expect(partial.value).toBeLessThan(1);

    const full = gradeOrdering(
      [obs("a", 0), obs("b", 1)],
      [
        { name: "a", match: "subset" },
        { name: "b", match: "subset" },
      ] as EvalToolCall[],
      "exactSequence",
    );
    expect(full.pass).toBe(true);
    expect(full.value).toBe(1);

    const subseq = gradeOrdering(
      [obs("a", 0)],
      [
        { name: "a", match: "subset" },
        { name: "b", match: "subset" },
      ] as EvalToolCall[],
      "subsequence",
    );
    expect(subseq.pass).toBe(false);
    expect(subseq.value).toBeLessThan(1);
  });
});

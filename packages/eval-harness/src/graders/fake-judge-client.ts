import type {
  JudgeClient,
  JudgeRequest,
  JudgeResponse,
} from "./judge-types.js";
import type { JudgeCost, JudgeResult } from "../types.js";

export interface FakeJudgeScenario {
  criterionId: string;
  result: JudgeResult;
  cost?: JudgeCost;
}

export class FakeJudgeClient implements JudgeClient {
  private scenarios: Map<string, FakeJudgeScenario>;
  public callCount = 0;

  constructor(scenarios: FakeJudgeScenario[]) {
    this.scenarios = new Map(scenarios.map((s) => [s.criterionId, s]));
  }

  async judge(request: JudgeRequest): Promise<JudgeResponse> {
    this.callCount++;
    const scenario = this.scenarios.get(request.criterion.id);
    if (!scenario) {
      throw new Error(
        `FakeJudgeClient: no scenario for criterion "${request.criterion.id}"`,
      );
    }
    return structuredClone({
      result: scenario.result,
      cost: scenario.cost ?? {
        inputTokens: 100,
        outputTokens: 50,
        model: "fake-model",
        estimatedCostUsd: 0.001,
      },
      cached: false,
    });
  }
}

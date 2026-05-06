import type { Driver, DriverOptions } from "./types.js";
import type { EvalSample, ObservedResult } from "../types.js";

export interface FakeScenario {
  sampleId: string;
  response: ObservedResult;
}

export class FakeDriver implements Driver {
  private scenarios: Map<string, ObservedResult>;

  constructor(scenarios: FakeScenario[]) {
    this.scenarios = new Map(scenarios.map((s) => [s.sampleId, s.response]));
  }

  async run(sample: EvalSample, options?: DriverOptions): Promise<ObservedResult> {
    const response = this.scenarios.get(sample.id);
    if (!response) {
      throw new Error(`FakeDriver: unknown sampleId "${sample.id}"`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (options?.signal?.aborted) {
      throw new Error(`FakeDriver: aborted while serving sample "${sample.id}"`);
    }
    return structuredClone(response);
  }

  static fromMap(map: Record<string, ObservedResult>): FakeDriver {
    const scenarios: FakeScenario[] = Object.entries(map).map(([sampleId, response]) => ({
      sampleId,
      response,
    }));
    return new FakeDriver(scenarios);
  }
}

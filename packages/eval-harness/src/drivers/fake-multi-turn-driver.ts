import type { MultiTurnDriver } from "./multi-turn-types.js";
import type { DriverOptions } from "./types.js";
import type { TrajectorySample, ObservedTrajectory } from "../types.js";

export interface FakeTrajectoryScenario {
  sampleId: string;
  trajectory: ObservedTrajectory;
}

export class FakeMultiTurnDriver implements MultiTurnDriver {
  private scenarios: Map<string, ObservedTrajectory>;

  constructor(scenarios: FakeTrajectoryScenario[]) {
    this.scenarios = new Map(scenarios.map((s) => [s.sampleId, s.trajectory]));
  }

  async runTrajectory(
    sample: TrajectorySample,
    options?: DriverOptions,
  ): Promise<ObservedTrajectory> {
    const traj = this.scenarios.get(sample.id);
    if (!traj) {
      throw new Error(`FakeMultiTurnDriver: unknown sampleId "${sample.id}"`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (options?.signal?.aborted) {
      throw new Error(`FakeMultiTurnDriver: aborted while serving sample "${sample.id}"`);
    }
    return structuredClone(traj);
  }

  static fromMap(map: Record<string, ObservedTrajectory>): FakeMultiTurnDriver {
    const scenarios: FakeTrajectoryScenario[] = Object.entries(map).map(
      ([sampleId, trajectory]) => ({ sampleId, trajectory }),
    );
    return new FakeMultiTurnDriver(scenarios);
  }
}

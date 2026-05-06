import type { TrajectorySample, ObservedTrajectory } from "../types.js";
import type { DriverOptions } from "./types.js";

export interface MultiTurnDriver {
  runTrajectory(sample: TrajectorySample, options?: DriverOptions): Promise<ObservedTrajectory>;
  dispose?(): Promise<void>;
}

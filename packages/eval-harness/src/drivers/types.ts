import type { EvalSample, ObservedResult } from "../types.js";

export interface DriverOptions {
  store?: string;
  model?: string;
  timeout?: number;
  signal?: AbortSignal;
}

export interface Driver {
  run(sample: EvalSample, options?: DriverOptions): Promise<ObservedResult>;
  dispose?(): Promise<void>;
}

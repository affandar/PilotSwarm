import { fakeObservedResult } from "./fake.js";
import type { Driver } from "../registry.js";

export function scriptedDriverFactory(): Driver {
  return {
    async run(scenario) {
      return fakeObservedResult(scenario);
    }
  };
}

import { describe, it, expect } from "vitest";
import { gradeCmsState } from "../src/graders/cms-state.js";

describe("gradeCmsState", () => {
  it("state in list → pass", () => {
    const s = gradeCmsState("idle", { stateIn: ["idle", "running"] });
    expect(s).toBeDefined();
    expect(s!.pass).toBe(true);
    expect(s!.value).toBe(1);
  });

  it("state not in list → fail", () => {
    const s = gradeCmsState("errored", { stateIn: ["idle", "running"] });
    expect(s!.pass).toBe(false);
    expect(s!.value).toBe(0);
  });

  it("undefined stateIn → returns undefined (skip)", () => {
    const s = gradeCmsState("idle", {});
    expect(s).toBeUndefined();
  });

  it("undefined actual state → fail", () => {
    const s = gradeCmsState(undefined, { stateIn: ["idle"] });
    expect(s!.pass).toBe(false);
  });
});

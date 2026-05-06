import { describe, expect, it } from "vitest";
import {
    applyAssistantOutputBudget,
    applyToolOutputBudget,
    applyTurnBudget,
    buildTurnBudgetConfig,
    getTurnBudgetThrottledCount,
    resetTurnBudgetStats,
} from "../../src/turn-budget.ts";

describe("turn budget helpers", () => {
    it("builds defaults and respects env overrides", () => {
        const defaults = buildTurnBudgetConfig({});
        expect(defaults.softBudgetChars).toBe(40_000);
        expect(defaults.hardBudgetChars).toBe(80_000);
        expect(defaults.toolOutputHardBudgetChars).toBe(12_000);
        expect(defaults.assistantOutputHardBudgetChars).toBe(24_000);

        const overridden = buildTurnBudgetConfig({
            TURN_SOFT_BUDGET_CHARS: "123",
            TURN_HARD_BUDGET_CHARS: "456",
            TURN_TOOL_OUTPUT_HARD_BUDGET_CHARS: "789",
            TURN_ASSISTANT_OUTPUT_HARD_BUDGET_CHARS: "321",
        });
        expect(overridden).toMatchObject({
            softBudgetChars: 123,
            hardBudgetChars: 456,
            toolOutputHardBudgetChars: 789,
            assistantOutputHardBudgetChars: 321,
        });
    });

    it("uses fallback defaults for invalid env values", () => {
        const config = buildTurnBudgetConfig({
            TURN_SOFT_BUDGET_CHARS: "bad",
            TURN_HARD_BUDGET_CHARS: "-10",
            TURN_TOOL_OUTPUT_HARD_BUDGET_CHARS: "NaN",
            TURN_ASSISTANT_OUTPUT_HARD_BUDGET_CHARS: "-1",
        });
        expect(config.softBudgetChars).toBe(40_000);
        expect(config.hardBudgetChars).toBe(80_000);
        expect(config.toolOutputHardBudgetChars).toBe(12_000);
        expect(config.assistantOutputHardBudgetChars).toBe(24_000);
    });

    it("applies prompt soft and hard caps", () => {
        resetTurnBudgetStats();
        const config = buildTurnBudgetConfig({
            TURN_SOFT_BUDGET_CHARS: "10",
            TURN_HARD_BUDGET_CHARS: "20",
        });

        const soft = applyTurnBudget("12345678901", config);
        expect(soft.decision).toBe("soft");
        expect(soft.text).toBe("12345678901");

        const hard = applyTurnBudget("x".repeat(100), config);
        expect(hard.decision).toBe("hard");
        expect(hard.effectiveChars).toBeLessThanOrEqual(20);
        expect(hard.text).toContain("Prompt truncated");
        expect(getTurnBudgetThrottledCount()).toBeGreaterThanOrEqual(2);
    });

    it("trims oversized tool outputs", () => {
        resetTurnBudgetStats();
        const config = buildTurnBudgetConfig({
            TURN_TOOL_OUTPUT_HARD_BUDGET_CHARS: "40",
        });

        const trimmed = applyToolOutputBudget("y".repeat(200), config);
        expect(trimmed.trimmed).toBe(true);
        expect(trimmed.effectiveChars).toBeLessThanOrEqual(40);
        expect(trimmed.text).toContain("Tool output truncated");
    });

    it("trims oversized assistant output", () => {
        resetTurnBudgetStats();
        const config = buildTurnBudgetConfig({
            TURN_ASSISTANT_OUTPUT_HARD_BUDGET_CHARS: "60",
        });

        const trimmed = applyAssistantOutputBudget("z".repeat(400), config);
        expect(trimmed.trimmed).toBe(true);
        expect(trimmed.effectiveChars).toBeLessThanOrEqual(60);
        expect(trimmed.text).toContain("Response truncated");
    });
});

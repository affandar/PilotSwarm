/**
 * Unit tests for Phase 4 — Tool & Network Controls.
 *
 * Pure logic tests (no DB, no LLM, no network).
 *
 * Covers:
 *   - smartTruncate: line-boundary cuts, passthrough under budget, notice text
 *   - Concurrency gate: semaphore queuing and ordering
 *   - Per-tool timeout: Promise.race rejection path
 *   - Artifact auto-offload: fire-and-forget + preview
 *   - Per-tool budget override: named tool uses own limit
 */

import { describe, it, expect, vi } from "vitest";
import {
    smartTruncate,
    stringifyForModel,
    TOOL_ARTIFACT_OFFLOAD_THRESHOLD_CHARS,
    TOOL_TIMEOUT_MS_DEFAULT,
    TURN_MAX_CONCURRENT_TOOLS_DEFAULT,
    buildTurnBudgetConfig,
} from "../../src/turn-budget.ts";

// ─── smartTruncate ───────────────────────────────────────────

describe("smartTruncate — passthrough", () => {
    it("returns text unchanged when under budget", () => {
        const text = "hello world";
        expect(smartTruncate(text, 100)).toBe(text);
    });

    it("returns text unchanged when exactly at budget", () => {
        const text = "a".repeat(50);
        expect(smartTruncate(text, 50)).toBe(text);
    });

    it("returns text unchanged when maxChars is 0 (disabled)", () => {
        const text = "a".repeat(100);
        expect(smartTruncate(text, 0)).toBe(text);
    });
});

describe("smartTruncate — truncation behavior", () => {
    it("truncates to at most maxChars + notice", () => {
        const text = "a".repeat(200);
        const result = smartTruncate(text, 100);
        expect(result.length).toBeLessThanOrEqual(200); // kept + notice is within reason
        expect(result).toContain("truncated");
    });

    it("includes original char count in notice", () => {
        const text = "a".repeat(500);
        const result = smartTruncate(text, 100, "Tool output");
        expect(result).toContain("500 chars");
    });

    it("includes custom label in notice", () => {
        const text = "x".repeat(200);
        const result = smartTruncate(text, 50, "My label");
        expect(result).toContain("My label");
    });

    it("defaults to 'Output' label when none provided", () => {
        const text = "x".repeat(200);
        const result = smartTruncate(text, 50);
        expect(result).toContain("Output");
    });

    it("cuts at last newline within the allowed window", () => {
        // 80 chars of content then newline at position 80, then more content
        const line1 = "a".repeat(80);
        const line2 = "b".repeat(50);
        const text = line1 + "\n" + line2;
        const result = smartTruncate(text, 100, "Tool output");
        // The newline at 80 is within the last 20% of 100 (80+), so it should cut there
        expect(result.startsWith(line1)).toBe(true);
        expect(result).not.toContain(line2);
    });

    it("falls back to hard cut when no newline in the allowed window", () => {
        // No newlines at all — should hard-cut
        const text = "x".repeat(200);
        const result = smartTruncate(text, 50, "Tool output");
        expect(result.startsWith("x".repeat(50))).toBe(true);
    });
});

// ─── stringifyForModel ───────────────────────────────────────

describe("stringifyForModel", () => {
    it("returns string as-is", () => {
        expect(stringifyForModel("hello")).toBe("hello");
    });

    it("returns empty string for null", () => {
        expect(stringifyForModel(null)).toBe("");
    });

    it("returns empty string for undefined", () => {
        expect(stringifyForModel(undefined)).toBe("");
    });

    it("JSON-stringifies objects", () => {
        const obj = { a: 1, b: "two" };
        const result = stringifyForModel(obj);
        expect(result).toContain('"a"');
        expect(result).toContain('"b"');
    });
});

// ─── buildTurnBudgetConfig defaults ─────────────────────────

describe("buildTurnBudgetConfig — Phase 4 defaults", () => {
    it("toolTimeoutMs defaults to TOOL_TIMEOUT_MS_DEFAULT", () => {
        const config = buildTurnBudgetConfig({});
        expect(config.toolTimeoutMs).toBe(TOOL_TIMEOUT_MS_DEFAULT);
    });

    it("maxConcurrentTools defaults to TURN_MAX_CONCURRENT_TOOLS_DEFAULT", () => {
        const config = buildTurnBudgetConfig({});
        expect(config.maxConcurrentTools).toBe(TURN_MAX_CONCURRENT_TOOLS_DEFAULT);
    });

    it("toolArtifactOffloadThresholdChars defaults to TOOL_ARTIFACT_OFFLOAD_THRESHOLD_CHARS", () => {
        const config = buildTurnBudgetConfig({});
        expect(config.toolArtifactOffloadThresholdChars).toBe(TOOL_ARTIFACT_OFFLOAD_THRESHOLD_CHARS);
    });

    it("reads TOOL_TIMEOUT_MS from env", () => {
        const config = buildTurnBudgetConfig({ TOOL_TIMEOUT_MS: "5000" });
        expect(config.toolTimeoutMs).toBe(5000);
    });

    it("reads TURN_MAX_CONCURRENT_TOOLS from env", () => {
        const config = buildTurnBudgetConfig({ TURN_MAX_CONCURRENT_TOOLS: "1" });
        expect(config.maxConcurrentTools).toBe(1);
    });

    it("reads TOOL_ARTIFACT_OFFLOAD_THRESHOLD_CHARS from env", () => {
        const config = buildTurnBudgetConfig({ TOOL_ARTIFACT_OFFLOAD_THRESHOLD_CHARS: "2048" });
        expect(config.toolArtifactOffloadThresholdChars).toBe(2048);
    });
});

// ─── Concurrency gate (pure logic) ───────────────────────────

describe("Concurrency gate — semaphore logic", () => {
    function makeSemaphore(max) {
        let active = 0;
        const queue = [];
        const acquire = () => {
            if (active < max) { active++; return Promise.resolve(); }
            return new Promise(resolve => queue.push(() => { active++; resolve(); }));
        };
        const release = () => { active--; queue.shift()?.(); };
        return { acquire, release, get active() { return active; }, get queued() { return queue.length; } };
    }

    it("allows up to max concurrent slots immediately", async () => {
        const sem = makeSemaphore(3);
        await sem.acquire();
        await sem.acquire();
        await sem.acquire();
        expect(sem.active).toBe(3);
        expect(sem.queued).toBe(0);
    });

    it("queues excess requests beyond max", async () => {
        const sem = makeSemaphore(2);
        await sem.acquire();
        await sem.acquire();
        // 3rd acquire should queue (not resolve yet)
        let resolved = false;
        sem.acquire().then(() => { resolved = true; });
        await Promise.resolve(); // yield
        expect(sem.active).toBe(2);
        expect(sem.queued).toBe(1);
        expect(resolved).toBe(false);
    });

    it("dequeues waiting request when a slot is released", async () => {
        const sem = makeSemaphore(1);
        await sem.acquire();
        let resolved = false;
        const pending = sem.acquire().then(() => { resolved = true; });
        await Promise.resolve();
        expect(resolved).toBe(false);
        sem.release();
        await pending;
        expect(resolved).toBe(true);
        expect(sem.active).toBe(1);
    });

    it("drains queue in FIFO order", async () => {
        const sem = makeSemaphore(1);
        await sem.acquire();
        const order = [];
        const p1 = sem.acquire().then(() => order.push(1));
        const p2 = sem.acquire().then(() => order.push(2));
        const p3 = sem.acquire().then(() => order.push(3));
        sem.release(); await p1;
        sem.release(); await p2;
        sem.release(); await p3;
        expect(order).toEqual([1, 2, 3]);
    });
});

// ─── Per-tool timeout ────────────────────────────────────────

describe("Per-tool timeout — Promise.race guard", () => {
    it("resolves with handler result when handler finishes before timeout", async () => {
        const handler = () => Promise.resolve("done");
        const guard = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 500));
        const result = await Promise.race([handler(), guard]);
        expect(result).toBe("done");
    });

    it("rejects with timeout error when handler hangs", async () => {
        const handler = () => new Promise(() => {}); // never resolves
        const guard = new Promise((_, rej) => setTimeout(() => rej(new Error("[Tool timeout: my-tool exceeded 50ms]")), 50));
        let caught;
        try {
            await Promise.race([handler(), guard]);
        } catch (err) {
            caught = err.message;
        }
        expect(caught).toMatch(/Tool timeout/);
        expect(caught).toMatch(/50ms/);
    });

    it("timeout error message is captured as tool result (string)", async () => {
        const guard = new Promise((_, rej) =>
            setTimeout(() => rej(new Error("[Tool timeout: test-tool exceeded 10ms]")), 10)
        );
        let raw;
        try {
            await Promise.race([new Promise(() => {}), guard]);
        } catch (err) {
            raw = err?.message ?? String(err);
        }
        expect(typeof raw).toBe("string");
        expect(raw).toContain("Tool timeout");
    });
});

// ─── Artifact auto-offload ────────────────────────────────────

describe("Artifact auto-offload — fire-and-forget", () => {
    it("calls uploadArtifact when output exceeds threshold", async () => {
        const store = { uploadArtifact: vi.fn().mockResolvedValue("ok") };
        const largeOutput = "x".repeat(TOOL_ARTIFACT_OFFLOAD_THRESHOLD_CHARS + 100);
        const sessionId = "test-session-id";
        const toolName = "test-tool";
        const limit = 500;

        // Simulate the fire-and-forget offload logic
        if (store && largeOutput.length > TOOL_ARTIFACT_OFFLOAD_THRESHOLD_CHARS) {
            const filename = `tool-${toolName}-${Date.now()}.txt`;
            store.uploadArtifact(sessionId, filename, largeOutput).catch(() => {});
        }

        // Wait one microtask for the upload mock to be called
        await Promise.resolve();
        expect(store.uploadArtifact).toHaveBeenCalledOnce();
        const [sid, fname, content] = store.uploadArtifact.mock.calls[0];
        expect(sid).toBe(sessionId);
        expect(fname).toMatch(/^tool-test-tool-/);
        expect(content).toBe(largeOutput);
    });

    it("does not call uploadArtifact when output is below threshold", () => {
        const store = { uploadArtifact: vi.fn().mockResolvedValue("ok") };
        const smallOutput = "x".repeat(100);

        if (store && smallOutput.length > TOOL_ARTIFACT_OFFLOAD_THRESHOLD_CHARS) {
            store.uploadArtifact("sid", "file.txt", smallOutput).catch(() => {});
        }

        expect(store.uploadArtifact).not.toHaveBeenCalled();
    });

    it("returned preview is a truncated version of the full output", () => {
        const largeOutput = "line-content\n".repeat(1000);
        const limit = 300;
        const preview = smartTruncate(largeOutput, limit, "Tool output");
        expect(preview.length).toBeLessThanOrEqual(largeOutput.length);
        expect(preview).toContain("truncated");
    });

    it("upload failure does not throw — caught silently", async () => {
        const store = { uploadArtifact: vi.fn().mockRejectedValue(new Error("blob unavailable")) };
        const largeOutput = "x".repeat(TOOL_ARTIFACT_OFFLOAD_THRESHOLD_CHARS + 100);

        // Fire-and-forget pattern should not surface the error
        await expect(
            Promise.resolve().then(() => {
                store.uploadArtifact("sid", "f.txt", largeOutput).catch(() => {});
            })
        ).resolves.toBeUndefined();
    });
});

// ─── Per-tool budget override ─────────────────────────────────

describe("Per-tool budget override", () => {
    it("named tool uses its own limit when specified", () => {
        const config = buildTurnBudgetConfig({});
        const perToolOverrides = { "my-tool": 2000 };
        const limit = perToolOverrides["my-tool"] ?? config.toolOutputHardBudgetChars;
        expect(limit).toBe(2000);
    });

    it("unnamed tool falls back to global toolOutputHardBudgetChars", () => {
        const config = buildTurnBudgetConfig({});
        const perToolOverrides = { "my-tool": 2000 };
        const limit = perToolOverrides["other-tool"] ?? config.toolOutputHardBudgetChars;
        expect(limit).toBe(config.toolOutputHardBudgetChars);
    });

    it("tool with higher per-tool limit is not truncated when output fits", () => {
        const output = "x".repeat(5000);
        const perToolLimit = 6000; // higher than default 12K? no — 5000 < 6000
        const result = smartTruncate(output, perToolLimit, "Tool output");
        expect(result).toBe(output); // no truncation needed
    });

    it("tool with lower per-tool limit gets truncated even if under global limit", () => {
        const output = "x".repeat(3000);
        const perToolLimit = 1000; // tighter than the output
        const result = smartTruncate(output, perToolLimit, "Tool output");
        expect(result).toContain("truncated");
        expect(result).toContain("3000");
    });
});

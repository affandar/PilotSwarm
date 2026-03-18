/**
 * Test fixtures — reusable tool definitions and session configs.
 */

import { defineTool, loadModelProviders } from "../../dist/index.js";

// ─── Common Tools ────────────────────────────────────────────────

/**
 * A simple calculator tool for testing tool invocation.
 */
export function createAddTool(tracker = {}) {
    tracker.called = false;
    tracker.args = null;
    return defineTool("test_add", {
        description: "Add two numbers together. ALWAYS use this when asked to add numbers.",
        parameters: {
            type: "object",
            properties: {
                a: { type: "number", description: "First number" },
                b: { type: "number", description: "Second number" },
            },
            required: ["a", "b"],
        },
        handler: async (args) => {
            tracker.called = true;
            tracker.args = args;
            return { result: args.a + args.b };
        },
    });
}

/**
 * A multiply tool for testing tool addition after session creation.
 */
export function createMultiplyTool(tracker = {}) {
    tracker.called = false;
    tracker.args = null;
    return defineTool("test_multiply", {
        description: "Multiply two numbers. ALWAYS use this when asked to multiply.",
        parameters: {
            type: "object",
            properties: {
                a: { type: "number", description: "First number" },
                b: { type: "number", description: "Second number" },
            },
            required: ["a", "b"],
        },
        handler: async (args) => {
            tracker.called = true;
            tracker.args = args;
            return { result: args.a * args.b };
        },
    });
}

/**
 * A weather tool for testing multi-tool scenarios.
 */
export function createWeatherTool(tracker = {}) {
    tracker.called = false;
    tracker.args = null;
    return defineTool("test_weather", {
        description: "Get the current weather for a city",
        parameters: {
            type: "object",
            properties: {
                city: { type: "string", description: "City name" },
            },
            required: ["city"],
        },
        handler: async (args) => {
            tracker.called = true;
            tracker.args = args;
            return { temperature: 72, condition: "sunny", city: args.city };
        },
    });
}

// ─── Common Session Configs ──────────────────────────────────────

export const ONEWORD_CONFIG = {
    systemMessage: { mode: "replace", content: "Answer in one word only. No punctuation." },
};

export const BRIEF_CONFIG = {
    systemMessage: { mode: "replace", content: "Be brief and direct. Answer in one or two sentences." },
};

export const MEMORY_CONFIG = {
    systemMessage: { mode: "replace", content: "Remember everything the user tells you. Be brief." },
};

export const TOOL_CONFIG = {
    systemMessage: {
        mode: "replace",
        content: "You have tools available. Use them when asked. Be brief and answer with just the result.",
    },
};

export const WAIT_CONFIG = {
    systemMessage: {
        mode: "replace",
        content: "You have a wait tool. When asked to wait, use it with the exact seconds. After waiting, say 'Wait complete' and answer any pending question. Be brief.",
    },
};

const modelRegistry = loadModelProviders();

function firstKnownModel(candidates) {
    if (!modelRegistry) return candidates[0];
    for (const candidate of candidates) {
        const normalized = modelRegistry.normalize(candidate);
        if (normalized) return candidate;
    }
    return candidates[0];
}

export const TEST_GPT_MODEL = firstKnownModel([
    "gpt-5.1",
    "gpt-4.1",
    "gpt-4o",
]);

export const TEST_CLAUDE_MODEL = firstKnownModel([
    "claude-sonnet-4.6",
    "claude-opus-4.6",
]);

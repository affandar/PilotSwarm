import assert from "node:assert/strict";
import test from "node:test";
import { ManagedSession } from "../../dist/managed-session.js";

class FakeCopilotSession {
    constructor(invokeTools) {
        this.invokeTools = invokeTools;
        this.listeners = new Map();
        this.allListeners = new Set();
        this.tools = [];
    }

    registerTools(tools) {
        this.tools = tools;
    }

    on(eventOrListener, listener) {
        if (typeof eventOrListener === "function") {
            this.allListeners.add(eventOrListener);
            return () => this.allListeners.delete(eventOrListener);
        }
        const listeners = this.listeners.get(eventOrListener) || new Set();
        listeners.add(listener);
        this.listeners.set(eventOrListener, listeners);
        return () => listeners.delete(listener);
    }

    emit(type, data = {}) {
        const event = { type, data };
        for (const listener of this.allListeners) listener(event);
        for (const listener of this.listeners.get(type) || []) listener(event);
    }

    async send() {
        await this.invokeTools(this.tools);
        this.emit("session.idle");
    }

    abort() {}
}

function tool(tools, name) {
    const match = tools.find((candidate) => candidate.name === name);
    assert.ok(match, `missing registered tool ${name}`);
    return match;
}

test("a successful marked user tool ends the managed turn and blocks later tools", async () => {
    let laterCalls = 0;
    const toolResults = [];
    const session = new FakeCopilotSession(async (tools) => {
        toolResults.push(await tool(tools, "finish_step").handler({}, {}));
        toolResults.push(await tool(tools, "later_tool").handler({}, {}));
    });
    const managed = new ManagedSession("session-1", session, {
        turnTimeoutMs: 0,
        turnInactivityTimeoutMs: 0,
        tools: [
            {
                name: "finish_step",
                pilotswarmTerminalTurnBoundary: true,
                async handler(_args, invocation) {
                    assert.equal(invocation.durableSessionId, "session-1");
                    return JSON.stringify({ completed: true });
                },
            },
            {
                name: "later_tool",
                async handler() {
                    laterCalls += 1;
                    return "unexpected";
                },
            },
        ],
    });

    const result = await managed.runTurn("finish the lifecycle state");

    assert.equal(result.type, "completed");
    assert.equal(result.content, JSON.stringify({ completed: true }));
    assert.match(toolResults[0], /finish_step acknowledged/);
    assert.match(toolResults[1], /later_tool was not executed/);
    assert.equal(laterCalls, 0);
});

test("a failed marked user tool does not establish a turn boundary", async () => {
    let laterCalls = 0;
    const toolResults = [];
    const session = new FakeCopilotSession(async (tools) => {
        toolResults.push(await tool(tools, "finish_step").handler({}, {}));
        toolResults.push(await tool(tools, "later_tool").handler({}, {}));
    });
    const managed = new ManagedSession("session-1", session, {
        turnTimeoutMs: 0,
        turnInactivityTimeoutMs: 0,
        tools: [
            {
                name: "finish_step",
                pilotswarmTerminalTurnBoundary: true,
                async handler() {
                    throw new Error("completion was rejected");
                },
            },
            {
                name: "later_tool",
                async handler() {
                    laterCalls += 1;
                    return "continued";
                },
            },
        ],
    });

    const result = await managed.runTurn("try to finish the lifecycle state");

    assert.equal(result.type, "completed");
    assert.equal(toolResults[0].resultType, "failure");
    assert.equal(toolResults[0].error, "completion was rejected");
    assert.equal(toolResults[1], "continued");
    assert.equal(laterCalls, 1);
});

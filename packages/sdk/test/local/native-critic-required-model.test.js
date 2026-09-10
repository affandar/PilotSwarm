import { describe, expect, it } from "vitest";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeSubagentDefinitions } from "../../src/native-subagents.ts";
import { approvePermissionForSession } from "../../src/permissions.ts";

const PARENT = "gpt-5.6-terra";
const CRITIC = "claude-sonnet-5";
const MISSING = "nonexistent-required-native-critic";
const parentRequest = request => request.tools?.some(tool => tool.function?.name === "ps_marker");

describe("native critic required model (real SDK/CLI, scripted local inference)", () => {
    it.each([CRITIC, MISSING])("enforces selected model %s without fallback to the parent's override", { timeout: 20_000 }, async selected => {
        // The raw SDK bypasses PilotSwarm's BYOK gate solely to test the CLI's
        // required-model contract against the actual production agent definition.
        const home = mkdtempSync(join(tmpdir(), "ps-native-required-model-"));
        const requests = [], events = [];
        const server = createServer(async (req, res) => {
            try {
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                const request = JSON.parse(Buffer.concat(chunks).toString());
                requests.push(request);
                if (request.model === MISSING) {
                    res.writeHead(404, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: { message: `The model ${MISSING} does not exist`, type: "invalid_request_error", code: "model_not_found" } }));
                    return;
                }
                const parent = parentRequest(request);
                const dispatch = parent && request.messages.at(-1).role !== "tool";
                const message = dispatch ? { role: "assistant", content: null, tool_calls: [{
                    id: "critic-dispatch", type: "function", function: { name: "task", arguments: JSON.stringify({
                        agent_type: "swarm-rubber-duck", name: "critic", description: "Critique the current plan",
                        prompt: "Return CRITIC_PROOF", mode: "sync", model: PARENT,
                    }) },
                }] } : { role: "assistant", content: parent ? `PARENT: ${request.messages.at(-1).content}` : "CRITIC_PROOF" };
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: `reply-${requests.length}`, object: "chat.completion", model: request.model,
                    choices: [{ index: 0, message, finish_reason: dispatch ? "tool_calls" : "stop" }],
                    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }));
            } catch (error) { res.writeHead(500); res.end(String(error)); }
        });
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        const client = new CopilotClient({ connection: RuntimeConnection.forStdio(), baseDirectory: home, useLoggedInUser: false, logLevel: "error" });
        try {
            const session = await client.createSession({ model: PARENT, workingDirectory: home, streaming: false,
                reasoningEffort: "high", contextTier: "long_context",
                provider: { type: "openai", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "synthetic" },
                onPermissionRequest: approvePermissionForSession, toolSearch: { enabled: false },
                tools: [{ name: "ps_marker", description: "Parent identity", parameters: { type: "object", properties: {} }, handler: () => "" }],
                customAgentsLocalOnly: true, customAgents: nativeSubagentDefinitions(PARENT, selected),
            });
            session.on(event => events.push(event));
            expect((await session.rpc.agent.list()).agents.find(agent => agent.name === "swarm-rubber-duck"))
                .toMatchObject({ model: selected, modelPolicy: "required" });
            if (selected === MISSING) {
                await expect(session.sendAndWait({ prompt: "Invoke the critic" }, 15_000)).rejects.toThrow(/HTTP 404/);
                await session.abort();
            } else {
                expect((await session.sendAndWait({ prompt: "Invoke the critic" }, 15_000)).data.content).toContain("CRITIC_PROOF");
                expect(events.find(event => event.type === "subagent.configured")?.data)
                    .toMatchObject({ model: selected, reasoningEffort: "high", contextTier: "long_context" });
                expect(events.find(event => event.type === "subagent.completed")?.data.firstDispatchedModel).toBe(selected);
            }
            const childRequests = requests.filter(request => !parentRequest(request));
            expect(childRequests.length).toBeGreaterThan(0);
            expect(childRequests.every(request => request.model === selected)).toBe(true);
            expect(childRequests.some(request => request.model === PARENT)).toBe(false);
        } finally {
            await client.stop();
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            rmSync(home, { recursive: true, force: true });
        }
    });
});

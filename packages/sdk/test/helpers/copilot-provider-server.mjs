import { createServer } from "node:http";

/** Synthetic provider, real Copilot runtime. Never receives live credentials. */
export async function createCopilotProviderServer() {
    const requests = [];
    const server = createServer(async (req, res) => {
        try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
            requests.push({ path: req.url, body, headers: req.headers });
            if (Object.hasOwn(body, "snippy")) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: "Unknown parameter: 'snippy'.", type: "invalid_request_error", param: "snippy", code: "unknown_parameter" } }));
                return;
            }
            const anthropic = new URL(req.url, "http://test").pathname.endsWith("/messages");
            const messages = body.messages || [];
            const last = messages.at(-1);
            const hasResult = last?.role === "tool" || (Array.isArray(last?.content) && last.content.some(c => c.type === "tool_result"));
            // A warm/resumed turn retains the original prompt in history;
            // only the current prompt may request a new tool execution.
            const tool = !hasResult && JSON.stringify(last?.content ?? "").includes("call compat_echo");
            const id = `compat-${requests.length}`;
            const text = "Compatibility verified: violet-739.";
            const args = { value: "violet-739" };
            const usage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_tokens_details: { cached_tokens: 2 } };
            if (anthropic) {
                const content = tool ? { type: "tool_use", id, name: "compat_echo", input: args } : { type: "text", text };
                const stop_reason = tool ? "tool_use" : "end_turn";
                const message = { id, type: "message", role: "assistant", model: body.model, content: [content], stop_reason, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 5 } };
                if (!body.stream) {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify(message));
                    return;
                }
                res.writeHead(200, { "content-type": "text/event-stream" });
                const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
                emit("message_start", { message: { ...message, content: [], stop_reason: null } });
                emit("content_block_start", { index: 0, content_block: tool ? { ...content, input: {} } : { type: "text", text: "" } });
                emit("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(args) } : { type: "text_delta", text } });
                emit("content_block_stop", { index: 0 });
                emit("message_delta", { delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } });
                emit("message_stop", {});
                res.end();
                return;
            }
            const assistant = tool
                ? { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "compat_echo", arguments: JSON.stringify(args) } }] }
                : { role: "assistant", content: text };
            const finish_reason = tool ? "tool_calls" : "stop";
            if (!body.stream) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id, object: "chat.completion", model: body.model, choices: [{ index: 0, message: assistant, finish_reason }], usage }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            const delta = tool ? { ...assistant, tool_calls: assistant.tool_calls.map(c => ({ index: 0, ...c })) } : assistant;
            for (const [part, finish] of [[delta, null], [{}, finish_reason]]) {
                res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: part, finish_reason: finish }], ...(finish ? { usage } : {}) })}\n\n`);
            }
            res.end("data: [DONE]\n\n");
        } catch (error) {
            res.writeHead(500);
            res.end(String(error));
        }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        requests,
        async close() {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        },
    };
}

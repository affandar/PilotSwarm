import { createServer } from "node:http";

/** Scripted inference endpoint: exercise real native runtime behavior without credentials. */
export async function createNativeCopilotProvider(respond) {
    const requests = [];
    const server = createServer(async (req, res) => {
        try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString());
            requests.push(body);
            const index = requests.length;
            const answer = await respond(body, index);
            if (res.destroyed) return;
            const id = `native-${index}`;
            const calls = answer.tools?.map((t, i) => ({ id: `${id}-${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } }));
            const assistant = { role: "assistant", content: answer.content ?? null, ...(calls ? { tool_calls: calls } : {}) };
            const finish_reason = calls ? "tool_calls" : "stop";
            const usage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 };
            if (body.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                const delta = calls ? { ...assistant, tool_calls: calls.map((c, index) => ({ index, ...c })) } : assistant;
                for (const [part, finish] of [[delta, null], [{}, finish_reason]]) {
                    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: part, finish_reason: finish }], ...(finish ? { usage } : {}) })}\n\n`);
                }
                res.end("data: [DONE]\n\n");
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id, object: "chat.completion", model: body.model, choices: [{ index: 0, message: assistant, finish_reason }], usage }));
            }
        } catch (error) { if (!res.destroyed) { res.writeHead(500); res.end(String(error)); } }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests,
        async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

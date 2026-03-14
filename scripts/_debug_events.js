#!/usr/bin/env node
import { PgSessionCatalogProvider } from "../packages/sdk/dist/cms.js";

const sessionId = process.argv[2] || "a5d2ba9f-0b2c-4877-866e-ddc29e8bc06b";

(async () => {
  const cat = await PgSessionCatalogProvider.create(process.env.DATABASE_URL);
  await cat.initialize();
  const events = await cat.getSessionEvents(sessionId, undefined, 500);
  for (const e of events) {
    const data = typeof e.data === "object" ? e.data : {};
    let summary = "";
    switch (e.eventType) {
      case "user.message":
        summary = (data.content || "").slice(0, 150);
        break;
      case "assistant.message":
        summary = (data.content || "(tool call)").slice(0, 150);
        break;
      case "assistant.reasoning":
        summary = (data.content || "").slice(0, 150);
        break;
      case "tool.execution_start":
        summary = `${data.toolName}(${JSON.stringify(data.arguments || {}).slice(0, 100)})`;
        break;
      case "tool.execution_complete":
        summary = `${data.toolCallId?.slice(0, 20)} → ${(data.result?.content || "").slice(0, 80)}`;
        break;
      case "assistant.usage":
        summary = `model=${data.model} cost=${data.cost} input=${data.inputTokens} output=${data.outputTokens}`;
        break;
      default:
        summary = JSON.stringify(data).slice(0, 120);
        break;
    }
    console.log(`${String(e.seq).padStart(4)} | ${e.eventType.padEnd(30)} | ${summary}`);
  }
  await cat.close();
})();

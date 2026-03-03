#!/usr/bin/env node
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Client, PostgresProvider } = require("duroxide");

(async () => {
  const provider = await PostgresProvider.connectWithSchema(process.env.DATABASE_URL, "duroxide");
  const client = new Client(provider);
  const ids = [
    "session-a5d2ba9f-0b2c-4877-866e-ddc29e8bc06b",
    "session-a5d2ba9f-0b2c-4877-866e-ddc29e8bc06b_sub_00001",
    "session-a5d2ba9f-0b2c-4877-866e-ddc29e8bc06b_sub_00002",
    "session-a5d2ba9f-0b2c-4877-866e-ddc29e8bc06b_sub_00006",
    "session-a5d2ba9f-0b2c-4877-866e-ddc29e8bc06b_sub_00006_sub_00003",
    "session-a5d2ba9f-0b2c-4877-866e-ddc29e8bc06b_sub_00006_sub_00005",
  ];
  for (const id of ids) {
    try {
      const status = await client.getStatus(id);
      let custom = null;
      try { custom = JSON.parse(status.customStatus); } catch {}
      const label = id.replace("session-a5d2ba9f-0b2c-4877-866e-ddc29e8bc06b", "ROOT");
      console.log(JSON.stringify({
        id: label,
        status: custom?.status,
        iteration: custom?.iteration,
        waitSec: custom?.waitSeconds,
        waitReason: custom?.waitReason,
        waitingForAgents: custom?.waitingForAgents,
        turnType: custom?.turnResult?.type,
        content: custom?.turnResult?.content?.slice(0, 200),
        intermediate: custom?.intermediateContent?.slice(0, 200),
      }));
    } catch (err) {
      console.log(JSON.stringify({ id, error: err.message }));
    }
  }
  process.exit(0);
})();

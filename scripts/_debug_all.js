#!/usr/bin/env node
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Client, PostgresProvider } = require("duroxide");
import { PgSessionCatalogProvider } from "../dist/cms.js";

(async () => {
  const provider = await PostgresProvider.connectWithSchema(process.env.DATABASE_URL, "duroxide");
  const client = new Client(provider);
  const cat = await PgSessionCatalogProvider.create(process.env.DATABASE_URL);
  await cat.initialize();
  const sessions = await cat.listSessions();

  for (const s of sessions) {
    const orchId = `session-${s.sessionId}`;
    let custom = null;
    try {
      const status = await client.getStatus(orchId);
      try { custom = JSON.parse(status.customStatus); } catch {}
    } catch {}

    console.log(JSON.stringify({
      id: s.sessionId.length > 36 ? "..." + s.sessionId.slice(-20) : s.sessionId.slice(0, 12),
      fullId: s.sessionId,
      parent: s.parentSessionId ? "..." + s.parentSessionId.slice(-12) : null,
      state: s.state,
      title: s.title,
      orchStatus: custom?.status,
      iteration: custom?.iteration,
      waitSec: custom?.waitSeconds,
      waitReason: custom?.waitReason?.slice(0, 60),
      turnType: custom?.turnResult?.type,
      content: custom?.turnResult?.content?.slice(0, 120),
    }));
  }

  await cat.close();
  process.exit(0);
})();

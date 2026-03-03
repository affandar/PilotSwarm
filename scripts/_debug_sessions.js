#!/usr/bin/env node
import { PgSessionCatalogProvider } from "../dist/cms.js";
(async () => {
  const cat = await PgSessionCatalogProvider.create(process.env.DATABASE_URL);
  await cat.initialize();
  const sessions = await cat.listSessions();
  for (const s of sessions) {
    console.log(JSON.stringify({
      id: s.sessionId.slice(0,12),
      fullId: s.sessionId,
      parent: s.parentSessionId || null,
      state: s.state,
      title: s.title,
      iter: s.currentIteration,
      error: s.lastError,
    }));
  }
  await cat.close();
})();

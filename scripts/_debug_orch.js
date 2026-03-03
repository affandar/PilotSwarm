#!/usr/bin/env node
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Client, PostgresProvider } = require("duroxide");

(async () => {
  const provider = await PostgresProvider.connectWithSchema(
    process.env.DATABASE_URL,
    "duroxide"
  );
  const client = new Client(provider);

  // Check specific orchestration IDs from CMS
  const orchIds = [
    "session-966ce4e5-0580-467f-850f-1851c02df2dc",
    "session-966ce4e5-0580-467f-850f-1851c02df2dc_sub_00000000",
  ];

  for (const id of orchIds) {
    try {
      const status = await client.getStatus(id);
      const info = await client.getInstanceInfo(id);
      let custom = null;
      try { custom = JSON.parse(status.customStatus); } catch {}
      console.log(JSON.stringify({
        id,
        runtimeStatus: info?.runtimeStatus,
        customStatusVersion: status?.customStatusVersion,
        fullCustomStatus: custom,
      }, null, 2));
    } catch (err) {
      console.log(JSON.stringify({ id, error: err.message }));
    }
  }
  process.exit(0);
})();

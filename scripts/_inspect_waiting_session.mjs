import { PilotSwarmManagementClient } from '../dist/management-client.js';
import { PgSessionCatalogProvider } from '../dist/cms.js';

const shortId = process.argv[2] || '0819f3e8';
const mgmt = new PilotSwarmManagementClient({ store: process.env.DATABASE_URL });
await mgmt.start();
const sessions = await mgmt.listSessions();
const parent = sessions.find(s => s.sessionId.startsWith(shortId));
if (!parent) {
  console.log('PARENT_NOT_FOUND', shortId);
  process.exit(1);
}
console.log('PARENT', JSON.stringify(parent, null, 2));

const catalog = await PgSessionCatalogProvider.create(process.env.DATABASE_URL);
await catalog.initialize();
const events = await catalog.getSessionEvents(parent.sessionId, undefined, 300);
const interesting = events.filter(e => ['assistant.message','assistant.reasoning','tool.execution_start','tool.execution_complete','user.message'].includes(e.eventType));
console.log('EVENT_COUNT', interesting.length);
for (const e of interesting.slice(-40)) {
  const data = e.data || {};
  const summary = {
    seq: e.seq,
    type: e.eventType,
    tool: data.toolName,
    model: data.model,
    content: typeof data.content === 'string' ? data.content.slice(0, 160) : undefined,
    args: data.arguments,
    createdAt: e.createdAt,
  };
  console.log(JSON.stringify(summary));
}

const children = sessions.filter(s => s.parentSessionId === parent.sessionId);
console.log('CHILDREN', children.length);
for (const c of children.slice(-60)) {
  console.log(JSON.stringify({
    id: c.sessionId,
    status: c.status,
    title: c.title,
    model: c.model,
    createdAt: c.createdAt,
  }));
}

await catalog.close();
await mgmt.stop();

import { PilotSwarmManagementClient } from '../dist/management-client.js';
const term = (process.argv[2] || '').toLowerCase();
const mgmt = new PilotSwarmManagementClient({ store: process.env.DATABASE_URL });
await mgmt.start();
const sessions = await mgmt.listSessions();
sessions.sort((a,b)=>b.createdAt-a.createdAt);
for (const s of sessions) {
  const title = s.title || '';
  if (!term || s.sessionId.startsWith(term) || title.toLowerCase().includes(term)) {
    console.log(JSON.stringify({id:s.sessionId, status:s.status, title:s.title, parent:s.parentSessionId, createdAt:new Date(s.createdAt).toISOString(), model:s.model}));
  }
}
await mgmt.stop();

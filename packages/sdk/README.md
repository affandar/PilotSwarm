# pilotswarm-sdk

Durable runtime primitives for building apps on top of PilotSwarm.

Install:

```bash
npm install pilotswarm-sdk
```

Minimal usage:

```ts
import { PilotSwarmClient, PilotSwarmWorker, defineTool } from "pilotswarm-sdk";
```

Client apps connect to a deployment's Web API (web mode):

```ts
const client = new PilotSwarmClient({ apiUrl: "https://portal.example.com" });
await client.start();
const session = await client.createSession();
const reply = await session.sendAndWait("hello");
```

Pass `getAccessToken` for authenticated deployments; use `PilotSwarmManagementClient({ apiUrl, getAccessToken? })` for management operations. Constructing a client directly with `{ store }` is internal (worker/portal-host embedding and testing) — see the [Web API reference](https://github.com/affandar/PilotSwarm/blob/main/docs/api/reference.md).

Workers are trusted backend components and always attach directly to the store:

```ts
const worker = new PilotSwarmWorker({ store: process.env.DATABASE_URL });
```

`pilotswarm-sdk` ships PilotSwarm's embedded framework prompt, framework skills, and management plugins inside the package. App code should provide its own `plugin/` directory and worker-side tool handlers on top of that base.

Artifact note:

- `write_artifact` remains the standard way for agents to create downloadable files.
- Text artifacts work as before.
- Binary artifacts are supported by supplying `contentType` plus `encoding: "base64"` when the agent writes the file; downloads preserve the raw bytes.

Common docs:

- SDK apps: `https://github.com/affandar/PilotSwarm/blob/main/docs/developer/building/sdk-apps.md`
- SDK agents: `https://github.com/affandar/PilotSwarm/blob/main/docs/developer/building/sdk-agents.md`
- Configuration: `https://github.com/affandar/PilotSwarm/blob/main/docs/developer/reference/configuration.md`
- Architecture: `https://github.com/affandar/PilotSwarm/blob/main/docs/architecture/system.md`

If you want the shipped terminal UI, install `pilotswarm-cli`.

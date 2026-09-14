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

### Node-only authentication bootstrap

Server-side Node.js applications can discover a deployment's authentication
mode and build that `getAccessToken` callback:

```ts
import { createNodeWebAuth } from "pilotswarm-sdk/node-auth";

const auth = await createNodeWebAuth({ apiUrl: process.env.PILOTSWARM_API_URL! });
const client = new PilotSwarmClient({
  apiUrl: process.env.PILOTSWARM_API_URL!,
  getAccessToken: auth.getAccessToken,
});
```

The `node-auth` entry point is intentionally not a browser API. The deployment
selects the provider. For authenticated deployments, an explicit `token`
option takes precedence over `PILOTSWARM_API_TOKEN`; setting `token` to `null`
suppresses environment fallback. Dev auth similarly uses explicit `devUser`
before `PILOTSWARM_DEV_USER`.

For identity auth, pass a caller-owned `TokenCredential`, or let the bootstrap
own a `DefaultAzureCredential`. Access tokens are cached until shortly before
expiry and concurrent refreshes are collapsed. Call `auth.close()` when done;
caller-owned credentials are never closed by the bootstrap. Discovery and
token-acquisition errors reject with `NodeWebAuthError` rather than silently
falling back to anonymous access.

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

If you want the shipped terminal UI, portal, and MCP server, install
`pilotswarm` (`pilotswarm-cli` is only a bin alias inside that package).

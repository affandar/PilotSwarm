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

`pilotswarm-sdk` ships PilotSwarm's embedded framework prompt, framework skills, and management plugins inside the package. App code should provide its own `plugin/` directory and worker-side tool handlers on top of that base.

Common docs:

- SDK apps: `https://github.com/affandar/PilotSwarm/blob/main/docs/sdk/building-apps.md`
- SDK agents: `https://github.com/affandar/PilotSwarm/blob/main/docs/sdk/building-agents.md`
- Configuration: `https://github.com/affandar/PilotSwarm/blob/main/docs/configuration.md`
- Architecture: `https://github.com/affandar/PilotSwarm/blob/main/docs/architecture.md`

If you want the shipped terminal UI, install `pilotswarm-cli`.

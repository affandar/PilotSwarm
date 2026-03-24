# pilotswarm-web

Web portal for PilotSwarm — browser-based durable agent orchestration UI.

Full feature parity with the TUI: session management, real-time chat, agent
splash screens (ASCII art), sequence diagrams, node maps, worker logs,
artifact downloads, and keyboard shortcuts.

## Quick Start

```bash
# Install
npm install pilotswarm-web

# Run (starts server + serves React app)
npx pilotswarm-web --env .env.remote

# Development (Vite HMR)
cd packages/portal
npm run dev              # React app at http://localhost:5173
node server.js           # API server at http://localhost:3001
```

## Architecture

```
Browser (React + Vite)
  │
  ├── WebSocket ──► Portal Server (Express + ws)
  │                    │
  │                    ├── PilotSwarmClient
  │                    ├── PilotSwarmManagementClient
  │                    └── PilotSwarmWorker (embedded or remote)
  │
  └── REST (session list, models, artifacts)
```

Same public API boundary as the TUI — only `PilotSwarmClient`,
`PilotSwarmManagementClient`, and `PilotSwarmWorker` APIs. No internal
module imports.

## Package Relationship

```
pilotswarm-web         (this package)
  ├── pilotswarm-sdk   (peer dependency)
  ├── express
  ├── ws
  ├── react, react-dom
  └── vite             (devDependency)

pilotswarm-cli         (TUI — separate package)
  └── pilotswarm-sdk

pilotswarm-sdk         (runtime — shared)
  └── duroxide, copilot-sdk, etc.
```

# PilotSwarm — Layer Diagram

How a canonical application is built on PilotSwarm.

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│                        YOUR APP  ("Smelter")                        │
│                                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐  ┌───────────┐ │
│  │   plugin/    │  │   tools.js   │  │   .mcp.json  │  │  scripts/ │ │
│  │             │  │              │  │              │  │           │ │
│  │ system.md   │  │ git_sync     │  │ filesystem   │  │ tui.sh    │ │
│  │ agents/     │  │ bash         │  │ (read repos) │  │ infra.sh  │ │
│  │  builder    │  │ write_file   │  │              │  │ sync.sh   │ │
│  │  scaffold   │  │ read_workspace│ │              │  │           │ │
│  │  expert     │  │ workspace_*  │  │              │  │           │ │
│  │ skills/     │  │ git_commit   │  │              │  │           │ │
│  │  duroxide-* │  │              │  │              │  │           │ │
│  └─────────────┘  └──────────────┘  └──────────────┘  └───────────┘ │
│                                                                     │
│  You provide: domain personality, custom tools, MCP servers,        │
│  agent definitions, skill knowledge, and operational scripts.       │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│                         PILOTSWARM RUNTIME                          │
│                                                                     │
│  ┌──────────────────────┐  ┌──────────────────────────────────────┐ │
│  │   PilotSwarmClient   │  │         PilotSwarmWorker             │ │
│  │                      │  │                                      │ │
│  │  createSession()     │  │  Copilot SDK (CopilotSession)        │ │
│  │  resumeSession()     │  │  ├─ send() + on() event loop         │ │
│  │  listSessions()      │  │  ├─ Tool dispatch & interception     │ │
│  │  send / sendAndWait  │  │  └─ Streaming responses              │ │
│  │  on() event stream   │  │                                      │ │
│  │  abort()             │  │  Plugin Loader                       │ │
│  │                      │  │  ├─ Agents  (personality, routing)   │ │
│  │  ┌────────────────┐  │  │  ├─ Skills  (domain knowledge)      │ │
│  │  │ Session        │  │  │  └─ MCP     (external tool servers)  │ │
│  │  │ Catalog (CMS)  │  │  │                                      │ │
│  │  │                │  │  │  Worker Tool Registry                │ │
│  │  │ PG: sessions,  │  │  │  ├─ Built-in: wait, ask_user,       │ │
│  │  │ events, titles │  │  │  │   spawn_agent, message_agent,     │ │
│  │  │                │  │  │  │   list_sessions, check_agents     │ │
│  │  └────────────────┘  │  │  ├─ App tools (from tools.js)        │ │
│  │                      │  │  └─ MCP tools (from .mcp.json)       │ │
│  └──────────┬───────────┘  └──────────┬───────────────────────────┘ │
│             │                         │                             │
│             │    ┌────────────────┐   │                             │
│             │    │ Orchestration  │   │                             │
│             └───▶│                │◀──┘                             │
│                  │ Turn loop      │                                 │
│                  │ Timer races    │        ┌───────────────────┐    │
│                  │ Dehydrate/     │        │   Session Manager │    │
│                  │  Rehydrate     │───────▶│                   │    │
│                  │ Sub-agents     │        │ Affinity routing  │    │
│                  │ Abort handling │        │ Blob hydration    │    │
│                  │ continueAsNew  │        │ Session lifecycle │    │
│                  └───────┬────────┘        └───────────────────┘    │
│                          │                                          │
├──────────────────────────┼──────────────────────────────────────────┤
│                          │                                          │
│                      DUROXIDE                                       │
│              Durable Execution Engine                               │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                                                              │   │
│  │  Orchestrations    Activities    Timers    Events    Replay   │   │
│  │                                                              │   │
│  │  • Generator-based orchestrations (yield-driven replay)      │   │
│  │  • Deterministic replay from event history                   │   │
│  │  • Durable timers persisted to PostgreSQL                    │   │
│  │  • Event queues (cross-orchestration communication)          │   │
│  │  • Activity scheduling with retry policies                  │   │
│  │  • Sub-orchestrations and continue-as-new                   │   │
│  │  • Multi-worker task distribution                           │   │
│  │                                                              │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │   │
│  │  │  Rust Core   │  │ Node.js SDK │  │  PostgreSQL Store   │  │   │
│  │  │  (napi-rs)   │  │ (duroxide)  │  │  (duroxide schema)  │  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────────┘  │   │
│  │                                                              │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│                       INFRASTRUCTURE                                │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │  PostgreSQL   │  │  Azure Blob  │  │  AKS / K8s   │              │
│  │  (HorizonDB)  │  │  (session    │  │  (worker     │              │
│  │              │  │   snapshots)  │  │   pods)       │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## What Each Layer Provides

### Your App (top)

The application author provides **domain-specific configuration only**:

| Component | What it is | Smelter example |
|-----------|-----------|-----------------|
| **`plugin/system.md`** | Root personality & routing | "You are Smelter, a duroxide dev agent" |
| **`plugin/agents/`** | Sub-agent definitions | `builder`, `scaffold`, `duroxide-expert` |
| **`plugin/skills/`** | Domain knowledge files | `duroxide-core/`, `duroxide-node/`, `duroxide-pg/` |
| **`tools.js`** | Custom tool handlers | `git_sync`, `bash`, `workspace_create`, `write_file` |
| **`.mcp.json`** | External MCP servers | Filesystem server for reading duroxide repos |
| **`scripts/`** | Operational scripts | `tui.sh` (launch), `infra.sh` (docker), `sync.sh` (repos) |

No orchestration code. No duroxide knowledge. No session management.

### PilotSwarm Runtime (middle)

The framework handles all durable agent concerns:

- **Client SDK** — `createSession`, `send`, `on`, event streaming, CMS catalog
- **Worker runtime** — Copilot SDK integration, tool dispatch, plugin/agent/skill/MCP loading
- **Orchestration** — Turn loop, timer races, dehydration/rehydration, sub-agents, abort
- **Session Manager** — Affinity routing, blob hydration, session lifecycle

### Duroxide (bottom)

The durable execution engine provides primitives:

- **Orchestrations** — Generator functions replayed from history
- **Activities** — One-shot work units with retry
- **Timers** — Durable, survives process death
- **Events** — Cross-orchestration messaging queues
- **Replay** — Deterministic re-execution from event log

### Infrastructure

- **PostgreSQL** — Both duroxide state and CMS session catalog
- **Azure Blob** — Session snapshots for dehydration/rehydration
- **AKS** — Worker pod scaling and distribution

## Building an App

```
my-app/
  package.json          ← depends on "pilotswarm"
  tools.js              ← your custom tool handlers
  plugin/
    system.md           ← root agent personality
    .mcp.json           ← MCP server configs (optional)
    agents/             ← sub-agent definitions (optional)
      researcher.agent.md
      analyst.agent.md
    skills/             ← domain knowledge (optional)
      my-domain/
        SKILL.md
  scripts/
    tui.sh              ← launch script
```

That's it. PilotSwarm gives you crash recovery, durable timers, sub-agents,
multi-node scaling, and session persistence — you just write your tools and
personality.

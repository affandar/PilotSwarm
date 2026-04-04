# TUI Apps

> Historical note: this file previously described an unshipped `AppAdapter` framework and an older multi-host terminal UI plan. That is no longer the supported path.

PilotSwarm now ships one supported terminal UI:

- the TUI package in [`packages/cli/`](/Users/affandar/workshop/drox/pilotswarm/packages/cli)
- the repo launcher in [`run.sh`](/Users/affandar/workshop/drox/pilotswarm/run.sh)

If you are building on top of the shipped terminal UI, use these guides instead:

- [Building CLI Apps](./cli/building-cli-apps.md)
- [Building Agents For CLI Apps](./cli/building-agents.md)
- [Keybindings](./keybindings.md)
- [TUI Architecture](./tui-architecture.md)

If you want to build your own UI or service on top of the runtime instead of using the shipped terminal UI, use:

- [Building SDK Apps](./sdk/building-apps.md)
- [Building Agents For SDK Apps](./sdk/building-agents.md)
- [Architecture](./architecture.md)

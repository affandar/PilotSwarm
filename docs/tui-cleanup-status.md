# TUI Cleanup Status

## Status

Implemented.

The old multi-path terminal UI cleanup is complete:

- the shared stack in `packages/ui-core`, `packages/ui-react`, and `packages/cli` is the only supported TUI path
- the old parallel host package and legacy launcher path have been removed
- current terminal UI design guidance now lives in:
  - [TUI Architecture](./tui-architecture.md)
  - [Keybindings](./keybindings.md)
  - [System Reference](./system-reference.md)
  - [Working On PilotSwarm](./contributors/working-on-pilotswarm.md)

This file remains only as a short archival marker so old links do not point at stale cleanup notes.

# TUI OOM Investigation — 2026-04-06

## Summary

The original remote TUI problem was real, but it turned out to be a mix of two issues:

1. A major artificial amplifier: the TUI was running React/Ink in development mode.
2. Real application churn: session refreshes, selector work, and pane rendering were still heavier than they should be.

After the fixes in this pass, the clean remote TUI no longer shows the old immediate runaway pattern in normal chat-only startup. On April 6, 2026, a clean chat-only run stabilized around `370-410 MB` RSS instead of the earlier `~60 MB/min` climb to OOM. That said, the app is still heavier than a text UI should be, and some interactions can still step RSS into the `~480-560 MB` range.

## Original Problem

`./run.sh remote` is a client-only TUI with no embedded workers. Before the fixes below:

- long-running remote sessions could grow into multi-GB RSS
- with `--max-old-space-size=512`, the TUI could OOM in roughly 12 minutes
- the initial observed growth rate was about `60 MB/min` from startup

## Environment

- macOS ARM64
- Node.js
- ink `6.8.0`
- remote mode: `PilotSwarmClient` + `PilotSwarmManagementClient` against remote PostgreSQL
- no embedded workers in remote mode
- `K8S_CONTEXT=<example-context>` available, so log tailing can be enabled

## Layered Probe Result

The layered probe scripts were still useful and the high-level conclusion from them held:

| Probe | What it runs | Result | Notes |
|-------|-------------|--------|-------|
| `L1` | SDK only | Stable | transport / pg not the primary leak |
| `L2` | SDK + controller + store | Stable | controller polling alone did not reproduce the runaway |
| `L3` | L2 + tiny Ink tree | Stable | minimal Ink rendering was fine |
| `L5` | L2 + synthetic high dispatch, no rendering | Stable | dispatch frequency alone was not enough |
| `L6` | L3 + high dispatch | Borderline | small tree could absorb pressure |
| Real TUI | full component tree | Problematic | full render path was where the memory pressure surfaced |

The important conclusion remained: the main issue was in the interaction between the full React/Ink render tree and continuous state updates, not in the raw remote SDK layer.

## What We Found

### 1. React development mode was a major amplifier

A live heap snapshot showed huge numbers of React development profiling artifacts, including `PerformanceMeasure` objects and React dev-only user timing strings. That pointed directly at the TUI loading the development build of React / react-reconciler.

This was confirmed by the launch path:

- `NODE_ENV` was not set
- the CLI entrypoint loaded React before forcing production mode

### 2. The app also had real avoidable churn

There were several cases where the UI tree was doing work even when nothing materially changed:

- `sessions/loaded` and detail merges were replacing session objects on no-op refreshes
- the store notified every subscriber even when the reducer returned the same state object
- startup hydration eagerly loaded more history than needed for the default inspector path
- inactive inspector tabs were still subscribing to heavy state like all histories, logs, and execution history
- chat title chrome depended on larger session/history structures than necessary

### 3. The current residual issue is interaction-sensitive, not a universal immediate runaway

After the fixes below, clean runs looked materially better:

- April 6, 2026 at `1:56:37 PM` through `1:58:28 PM` Pacific time: chat-only run held at `368-369 MB` RSS
- April 6, 2026 at `2:13:29 PM` through `2:14:40 PM` Pacific time: another fresh chat-only run held at `396-397 MB` RSS

Clean tab switches were also much better than the original failure mode:

- opening execution history from an already-heavier state added only about `+3 MB`
- switching to node map from a similar state added about `+10-20 MB`

The remaining heavier cases were more tied to broad interaction:

- scrolling the session list produced a step from about `370 MB` to about `478 MB`
- mixed/random interaction could step a clean run from roughly `410 MB` into the high `400s`

That means the current state is no longer “always runaway from startup,” but it is still “too heavy under interaction.”

## Fixes Kept

These changes are worth keeping:

1. Force production React for the TUI launch path.
   - `packages/cli/bin/tui.js`
   - `run.sh`

2. Remove no-op session churn and same-state subscriber notifications.
   - `packages/ui-core/src/controller.js`
   - `packages/ui-core/src/reducer.js`
   - `packages/ui-core/src/store.js`

3. Reduce startup eager history loading for the sequence inspector path.
   - `packages/ui-core/src/controller.js`

4. Reduce inactive pane refresh costs.
   - `packages/ui-react/src/components.js`
   - `packages/ui-core/src/selectors.js`

5. Add an in-TUI RSS readout to the sessions pane header for live debugging.
   - `packages/ui-react/src/components.js`
   - `packages/cli/src/platform.js`

## Current Conclusion

As of April 6, 2026:

- the original dev-mode amplifier is fixed
- the TUI no longer immediately reproduces the old startup runaway in clean chat-only runs
- the remaining memory problem looks more like expensive interaction-driven render/state churn than one single retained giant object
- the sessions pane / session tree path still deserves more attention than history or node map based on observed step-ups

## Remaining Work

The next likely targets are:

- session list rendering and session-tree selectors
- descendant-count / collapse-badge computation on session movement
- expensive line-model generation that still recreates large arrays during broad UI interaction
- any remaining places where selector inputs are wider than the visible pane actually needs

## Reusable Probe Scripts

These layered probes in `scripts/tmp/` still look useful enough to keep for future regression checks:

| Script | Purpose |
|--------|---------|
| `mem-leak-probe.mjs` | SDK-only baseline |
| `mem-leak-probe-L2.mjs` | controller + store baseline |
| `mem-leak-probe-L3.mjs` | minimal Ink render baseline |
| `mem-leak-probe-L4.mjs` | additional incremental render probe |
| `mem-leak-probe-L5.mjs` | high-frequency dispatch without rendering |
| `mem-leak-probe-L6.mjs` | small Ink tree under higher churn |

External watcher used during the investigation:

- `/tmp/tui-memwatch-clean.sh`
- log file: `/tmp/tui-memwatch-clean.log`

## Cleanup

The following ad hoc, one-off heap-inspector helpers were removed from the repo after use:

- `scripts/tmp/inspector-heap-sampling.mjs`
- `scripts/tmp/inspector-heap-snapshot.mjs`
- `scripts/tmp/analyze-heap-snapshot.mjs`

Those were useful for this debugging pass, but they were temporary live-process helpers rather than repo-level tools we expect to maintain.

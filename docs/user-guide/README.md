# PilotSwarm User Guide

This guide walks you through using PilotSwarm as an end user — not as a
developer building on the SDK. By the end you'll know how to start sessions,
manage them, run long-haul agents, inspect what they did, and recover from
failures.

The guide is **scenario-based** and goes from a single-message chat all the
way to multi-hour multi-agent workflows. Each scenario is self-contained so
you can skim or jump.

PilotSwarm has two front-ends. They surface the same sessions and the same
runtime — pick the one you're using:

→ **Terminal UI** (keyboard, fast, works over SSH): [user-guide/tui.md](./tui.md)

→ **Browser portal** (mouse + keyboard, mobile-friendly): [user-guide/portal.md](./portal.md)

If you haven't installed PilotSwarm yet, the
[Docker Quickstart](../getting-started-docker-appliance.md) gets both
surfaces running with a single command.

## What both surfaces share

These concepts show up in both the TUI and the portal — knowing them up
front makes the rest read faster:

**Sessions** are individual agent conversations. Each has a state badge:

| Badge / state | Meaning |
|---|---|
| `pending` | Session row exists in CMS, no orchestration yet |
| `running` | Currently executing an LLM turn |
| `waiting` | Suspended on a durable timer (`wait`, `cron`) — consuming no resources |
| `idle` | Conversation paused, ready for next message |
| `input_required` | Agent asked you a question and is waiting for your answer |
| `completed` | Closed gracefully via `done` |
| `cancelled` | Closed via `cancel` |
| `failed` | Hit an unrecoverable error |

**Message states** show up next to every message you send:

| Symbol | Meaning |
|---|---|
| `○` | pending — your client hasn't been acknowledged by the runtime yet |
| `✓` | queued — durably enqueued; will be processed when the agent's free |
| `✓✓` | sent — persisted as `user.message`; the LLM has it |

**Inspector tabs** (in both surfaces): **sequence**, **logs**, **nodes**,
**history**, **files**, **stats** — each shows a different view into what
the agent did.

**Sub-agents** appear nested under their parent. A child of a child appears
two levels deep, and so on, up to the runtime's nesting cap.

**The durability story**: when an agent calls `wait(N)` or `cron(N)` for
anything longer than ~30 seconds, the session **dehydrates** — the live
state is archived to blob storage and the worker is free to do other work
or shut down entirely. When the timer fires, any worker rehydrates the
session and continues. To you, the user, this looks like a session sitting
quietly in the `waiting` state and then waking up. Nothing else changes.

## How to use this guide

Each scenario in the per-surface guides has the same shape:

1. **What you're trying to do** (one sentence)
2. **Setup** (what you need running)
3. **Steps** (numbered, with the actual key/click and what you'll see)
4. **What just happened** (3–4 lines explaining the runtime story)
5. **Try this next** (extension)

Difficulty progression:

| Part | Scenarios | Time per scenario |
|---|---|---|
| Beginner | 1–3 | 5–15 min |
| Intermediate | 4–6 | 10–20 min |
| Advanced | 7–10 | 20 min – several hours |

The advanced scenarios deliberately include real durability moments —
"leave it running, come back tomorrow" — so plan accordingly.

## Reference

- [Keybindings cheat sheet](../keybindings.md) — every TUI key in one table
- [Configuration](../configuration.md) — environment variables, blob storage, worker/client options
- [Architecture](../architecture.md) — what's underneath the UI

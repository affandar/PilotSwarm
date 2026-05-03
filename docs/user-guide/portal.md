# PilotSwarm User Guide — Browser Portal

This guide walks through the browser portal scenario by scenario. Same
sessions, same runtime as the [terminal UI](./tui.md) — different surface.

The portal lives at `http://localhost:3001` by default. You can switch
between the TUI and the portal at any time; they don't conflict.

## Prerequisites

Either:

- **Docker quickstart** (easiest): `docker run -d -p 127.0.0.1:3001:3001 -p 127.0.0.1:2222:2222 -e GITHUB_TOKEN -v pilotswarm-data:/data --name pilotswarm-starter affandar/pilotswarm-starter:latest`. Then open `http://localhost:3001`.
- **From source**: `npm install && npm run build`, set up `.env` (see [getting-started.md](../getting-started.md)), then `npm run portal:start` (or `./scripts/portal-start.sh`). Open `http://localhost:3001`.

For deployments with Entra ID auth enabled (production), you'll see a
sign-in flow first. For local development, sign-in is bypassed.

## Layout overview

When the portal opens you see three panes:

- **Sessions** — left column, session tree (or list on mobile).
- **Chat + Activity** — center, the conversation and a live event stream
  beside it.
- **Inspector** — right column, with tabs along the top.

The layout is responsive — on narrow screens it collapses panes into a
stack you swipe between, with a top bar for navigation.

---

# Part 1 — Beginner

## Scenario 1: Say hello

**What you're trying to do:** prove the system works end to end with a
single short conversation.

**Setup:** Portal open at `http://localhost:3001`.

**Steps:**

1. Click **New Session** (top-left of the Sessions pane).
2. The agent picker dialog opens. Pick the default agent (or just hit
   Enter).
3. The session appears in the list and is automatically selected.
4. Click into the prompt box at the bottom. Type
   `What's the weather in NYC?` and click **Send** (or press `Enter`).
5. Watch the message badge next to your text:
   - `○` — your client has the message but the runtime hasn't ack'd yet
   - `✓` — durably queued
   - `✓✓` — the agent's seen it
6. The session badge transitions: `pending` → `running`. The chat
   streams the response. The activity panel beside chat shows tool
   calls / events as they fire.
7. When the agent finishes, the badge returns to `idle`.

**What just happened:**

Your message went into a durable Postgres queue. A worker picked it up,
spawned a Copilot SDK session, ran one LLM turn, and published the
response back. The portal polls the orchestration's custom-status and
the catalog event log; you saw both update live.

**Try this next:**

- The inspector tabs along the top right: `sequence`, `logs`, `nodes`,
  `history`, `files`, `stats`. Click each to see a different view of
  the same session.
- Right-click (or use the session row's menu, depending on your
  browser/version) on the session to rename it.

---

## Scenario 2: Watch a long task suspend and resume

**What you're trying to do:** see the durability story with your own
eyes, not believe the marketing.

**Setup:** From Scenario 1.

**Steps:**

1. New session (default agent). Send:

       Wait for 60 seconds, then tell me what time it is.

2. The agent calls `wait(60)`. Within a turn or two, the session badge
   changes to `waiting · 58s · "user requested wait"` (countdown is
   live).
3. Click the **sequence** inspector tab. Find the `wait_started` event
   and the `dehydrate` activity. The session is now archived to blob
   storage.
4. **Optional durability proof:** in another tab/terminal, kill the
   worker process (or `docker stop pilotswarm-starter`). The portal
   will show the workers as offline; the session row remains in
   `waiting`.
5. Restart workers. Wait until the timer fires. The session resumes
   and emits its final response. Badge returns to `idle`.

**What just happened:**

The agent's `wait(60)` tool call became a durable Postgres timer. The
in-memory session was archived to blob (dehydrated). The worker
process was free to do other work — or, in step 4, exit entirely. When
the timer fired, any worker rehydrated and resumed. The model didn't
notice the worker change; from its perspective there was a 60-second
pause between two messages.

**Try this next:**

- Same scenario but `Wait for 5 minutes`. Notice that for short waits
  (under ~30 seconds) the session **doesn't** dehydrate — it stays
  warm to avoid the round-trip cost.
- Try `cron`: ask the agent `Tell me the time every 30 seconds, three
  times`. The session uses `cron(30)` and re-arms itself.

---

## Scenario 3: Two things at once

**What you're trying to do:** run sessions in parallel and move
between them quickly.

**Setup:** From Scenario 1 or 2.

**Steps:**

1. **New Session** twice, send a different prompt to each.
2. Click between sessions in the list to switch focus. The chat,
   activity, and inspector all re-render for the active session.
3. Drag the divider between Sessions and Chat to resize the split.
4. **Pin** a session via its row menu (or the pin icon in the header
   when selected). Pinned sessions sort to the top.
5. **Multi-select** — there's typically a checkbox toggle or a "select
   mode" button at the top of the Sessions pane. Activate it, click
   sessions to select, then use the toolbar action **Cancel selected**.
   System sessions are skipped automatically.

**What just happened:**

Each session is its own durable orchestration running in parallel.
Different workers can be handling different sessions. The portal's
Sessions pane is a live view backed by the catalog — when state
changes anywhere, your browser reflects it within a poll cycle.

**Try this next:**

- Use the **owner filter** in the Sessions pane header to narrow to
  just your sessions when there are many users on the same Postgres.

---

# Part 2 — Intermediate

## Scenario 4: Bulk-cleanup messy sessions

**What you're trying to do:** 12 sessions left from yesterday's
experiments. Keep three, kill nine.

**Setup:** Lots of stale sessions in the list.

**Steps:**

1. Open the **owner filter** to narrow to yours.
2. For sessions you want to keep: rename them via the row menu, then
   pin them.
3. Enter **multi-select mode** (the checkbox toggle / "select" button).
4. Click each session you want to remove (skip the keepers).
5. Use the toolbar action **Cancel selected** — confirm.
6. Exit multi-select, refresh.

**Three flavors of close:**

| Action | Effect |
|---|---|
| **Cancel** | Graceful shutdown. Cascades to sub-agents. CMS state → `cancelled`. |
| **Done** | Graceful completion. Same cascade. CMS state → `completed`. The "I finished, archive this" verb. |
| **Delete** | Hard delete. Removes from CMS along with all descendants. Use sparingly. |

**What just happened:**

Each Cancel enqueued a `cancel` command into that session's durable
queue. The orchestration drained the command, cascaded `cancel` to any
running sub-agents, waited up to 60 seconds for them to drain
gracefully, then updated CMS state. Delete is the same flow plus a CMS
row removal at the end.

**Try this next:**

- Watch a sub-agent-rich session in the **sequence** tab during a
  cancel. You'll see the cascade — child cancellations poll-acked one
  by one before the parent finishes.

---

## Scenario 5: Hand the agent a file, get a file back

**What you're trying to do:** feed the agent a CSV of error logs, ask
it to summarize, get a markdown report you can download.

**Setup:** A new session, default agent.

**Steps:**

1. In the prompt box, click the **attach** icon (paperclip or similar).
   Browse to your local file. Or drag-and-drop it onto the prompt box.
2. The file uploads immediately. An `artifact://...` reference is
   inserted into the prompt at the cursor.
3. Type around it, e.g.:

       Look at artifact://errors.csv. Summarize the top 5 root causes
       as a markdown report. Use write_artifact + export_artifact so I
       can download it.

4. Send. The agent reads your CSV, runs analysis, calls
   `write_artifact` and `export_artifact`.
5. Click the **files** inspector tab. The new artifact appears.
6. With the file selected:
   - Inline preview renders for markdown / images / PDFs.
   - The download icon downloads the file via the browser.
   - Fullscreen toggle expands the preview.
   - Delete (with confirm) removes the artifact.
7. Filter the file list to show **selected session only** vs **all
   sessions**.

**Linked-item view:**

8. Inside the chat pane there's typically a **Linked items** affordance
   (icon in the message header or a sidebar toggle). It collects every
   `artifact://` reference and URL from the current chat into a single
   navigable list.

**What just happened:**

Your upload went into the storage-backed artifact store (filesystem in
local mode, blob in production). The agent received an `artifact://`
reference in the prompt, called the same artifact API on its end to
read it, and wrote a new artifact back. Artifacts persist across
worker pods because they're not on local disk.

---

## Scenario 6: Drilling into what an agent did

**What you're trying to do:** an agent took 30 seconds for a trivial
turn and you want to know why.

**Setup:** A session with at least one completed turn.

**Steps — visit every inspector tab:**

1. **`sequence`** — every yield in the orchestration: prompt received,
   runTurn started, tool calls, wait timers, dehydrate/hydrate events,
   continueAsNew. Read top-to-bottom to reconstruct the turn. The
   portal renders this as a swim-lane diagram.
2. **`logs`** — raw worker logs. The portal usually has a tail toggle
   and a filter input (severity + keyword).
3. **`nodes`** — which worker pod handled which turn. In a multi-worker
   deployment this shows session relocation across nodes during
   dehydrate / rehydrate.
4. **`history`** — the durable event log from the catalog. Every
   `user.message`, `assistant.message`, `session.wait_started`,
   `session.command_received`, etc.
5. **`files`** — covered in Scenario 5.
6. **`stats`** — token usage, turn durations, context-window
   utilization. Inside stats, switch between **session** (this
   session), **fleet** (whole deployment), and **users** (per-owner
   aggregates).

**Diagnosing the slow turn:**

7. Open **sequence**. Find the gap. Is it within one event (slow LLM
   call)? Between activities (slow dehydrate or CMS write)? Around a
   `wait_started` (the agent *meant* to be slow)?
8. Cross-reference with **logs** — tail mode + filter on `warn` or
   `error`.
9. Check **nodes** — was it one specific worker (probably that pod's
   problem) or all workers (probably the model or the database)?

**What just happened:**

Each tab is rendered from a different data source: `sequence` from
duroxide history, `logs` from worker stdout streamed through the
portal, `nodes` from `session_events` joined with worker IDs,
`history` from the CMS event log, `files` from artifact storage,
`stats` from a metrics summary table the worker writes after each
turn. The portal is read-only for these views.

---

# Part 3 — Advanced

## Scenario 7: Sub-agents and the spawn tree

**What you're trying to do:** dispatch parallel sub-agents to
investigate different angles of the same question.

**Setup:** Best with the [DevOps Command Center
sample](../../examples/devops-command-center/README.md) plugin loaded.

**Steps:**

1. Click **New Session** and pick the `investigator` agent (or any
   agent allowed to spawn children).
2. Send a prompt that invites parallel work, e.g.:

       Investigate the latency spike at 14:32. Spawn separate
       sub-agents to check metrics, scan logs, and look at recent
       deploys. Then summarize.

3. Watch the Sessions pane. Child sessions appear nested under the
   parent. Expand the parent to see them.
4. The parent's chat pane shows incoming child-update digests — short
   summaries of each child's status, batched every ~30 seconds.
5. Children stay alive after their final reply. Their badges go to
   `idle`. The parent decides when they're really done by calling
   `complete_agent`.

**The `wait_for_agents` tool:**

6. Send a follow-up that explicitly blocks the parent on the children:

       Spawn three more sub-agents with different hypotheses. Use
       wait_for_agents to block until all three respond, then merge
       their answers.

7. The parent's badge goes to `waiting` with reason "waiting for N
   agents". The parent rehydrates as soon as the last child finishes.

**What just happened:**

`spawn_agent` is a tool the LLM calls. The orchestration creates a new
child session via the SDK, sends it the bootstrap prompt, and tracks
it in the parent's `subAgents` table. Children communicate back via
durable messages on the parent's queue, batched into a 30-second
digest before the parent processes them. Children staying alive after
final reply makes follow-up `message_agent` conversations possible.

---

## Scenario 8: A delayed multi-step workflow (the durability flagship)

**What you're trying to do:** a real long-haul workflow that survives
across worker restarts, scales to zero between turns, and produces an
artifact at the end.

**Setup:** DevOps Command Center sample plugin. Watchdog and Janitor
auto-start.

**Steps:**

1. Find Watchdog in the sessions list (marked as a system session). It
   has a cron schedule polling service health every few minutes.
2. Create a Reporter session. Send:

       Generate a daily incident report at midnight UTC. Aggregate
       data from Watchdog's findings over the last 24h. Write it
       as a markdown artifact and export it for download.

3. The Reporter calls `cron(86400, "midnight UTC")`. It exits its
   turn — badge `waiting · ~5h to next fire`.
4. **Now leave it.** Close the browser. Shut down the laptop if you
   want. Postgres and the workers keep running.
5. Come back tomorrow. Open the portal.
6. The Reporter is still in the list. Click it.
7. Chat history shows: at midnight UTC the cron fired, the agent ran a
   turn, generated the report, wrote and exported it. Session is back
   to `waiting` for the next midnight.
8. **files** tab → today's report → download.
9. If the Reporter asked a question via `ask_user`, the badge would
   read `input_required` instead of `waiting`. Send your answer; the
   agent resumes from your reply.

**Combining everything:**

A longer chain: Investigator finds a deploy correlation in metrics,
spawns Deployer with `ask_user` for human approval, deploys after you
approve, Reporter aggregates the result. Single workflow, multiple
agents, multiple workers, durable across all of them. **This is what
PilotSwarm is for.**

**What just happened:**

Each `wait`/`cron` call moved the session into durable storage. While
the Reporter was sleeping until midnight, it was a row in Postgres
and a blob — zero compute. When midnight hit, the runtime scheduled
the next turn against any available worker. That worker rehydrated,
ran one turn, dehydrated again. The "always-on Reporter" is actually
intermittent execution spread across days — the LLM sees a coherent
conversation.

**Try this next:**

- Run multiple long-haul sessions simultaneously. Dehydrated sessions
  cost ~zero. The author has run 1000+ on a 2-node cluster.

---

## Scenario 9: Portal ↔ TUI — same sessions, different surface

**What you're trying to do:** start work in the portal, continue in
the TUI. Or vice versa.

**Setup:** Portal at `http://localhost:3001`, TUI via
`ssh -p 2222 pilotswarm@localhost` or `./run.sh local --db`.

**Steps:**

1. Start a session in the portal as in Scenario 1. Send a couple of
   messages.
2. Open the TUI.
3. The same sessions list is in the TUI's left pane.
4. Select the session you started in the portal. The chat history is
   there.
5. Send a message from the TUI. Tab back to the portal — the message
   shows up within a poll cycle.
6. The state badges, message states (`○`/`✓`/`✓✓`), inspector tabs,
   files all match.

**Per-user keys (Admin Console):**

7. In the portal there's typically an **Admin** button (or settings
   menu) that opens the per-user profile + GitHub Copilot key.
8. Updating your key here takes effect immediately for new sessions
   without restarting the worker. Useful when your token expires.

**What just happened:**

Both surfaces talk to the same Postgres + duroxide pair. They both
poll the catalog and the orchestration's custom-status. Either can
drive a session, both reflect changes within a poll cycle. The
portal supports mobile layouts and richer inline previews; the TUI is
faster for keyboard-heavy work and runs over SSH.

**Try this next:**

- Open the portal on your phone and check on long-running sessions
  while away from your desk.

---

## Scenario 10: Make it your own

**What you're trying to do:** customize the portal — different agents,
different tools, different branding.

This crosses into developer territory; for the full walkthrough see
[Building SDK Apps](../sdk/building-apps.md) and
[Building CLI Apps](../cli/building-cli-apps.md).

**The plugin model:**

1. Create a `plugin/` directory with subfolders for `agents/`,
   `skills/`, and an optional `worker-module.js` for custom tools.
2. Define an agent in `agents/your-agent.agent.md` with YAML
   frontmatter (name, title, system message, allowed tools, etc.) and
   a body that becomes the system prompt.
3. Register custom tools in `worker-module.js` via `defineTool(...)`.
4. Set `PLUGIN_DIRS=./plugin` in your `.env` and restart workers
   (today; hot reload is on the roadmap).
5. Open the portal — your agent appears in the **New Session** picker.

**What you can customize:**

- **Agents** — system prompts, allowed tools, default model, behavior
  hints
- **Tools** — anything you can write in JS/TS, called via
  `defineTool()`
- **Skills** — markdown-based playbooks the agent loads on demand
- **MCP servers** — connect external tool surfaces
- **UI splash + theme + branding** — the portal supports custom logos
  and themes when run as your app's front-end
- **Session policy** — restrict which agents users can create

The [DevOps Command Center sample](../../examples/devops-command-center/README.md)
is a complete reference plugin. Copy it, swap out the tools, ship it
as your app's portal.

---

# Reference

## Common navigation

| Action | How |
|---|---|
| New session | **New Session** button (top-left) |
| Switch session | Click in list |
| Send prompt | Type, press `Enter` (Shift+Enter for newline) |
| Attach file | Paperclip icon, or drag-and-drop |
| Cycle inspector tabs | Click the tab; on mobile, swipe |
| Rename session | Row menu → Rename |
| Pin session | Row menu → Pin |
| Cancel session | Row menu → Cancel |
| Multi-select | Toolbar toggle, click rows, then **Cancel selected** |
| Filter sessions | Filter input in Sessions pane header |
| Open Admin Console | Admin / settings menu |

For keyboard shortcuts inside the portal (when supported), check the
help icon — many of the TUI keys (`j`/`k` to navigate, `r` to refresh,
etc.) work inside the portal too when no input is focused.

## Mobile

The portal is responsive. On small viewports:

- Sessions / Chat / Inspector collapse into a stack you swipe through.
- The top bar exposes session navigation, the pin / multi-select
  toolbar, and the Admin / settings menu.
- Inline file previews adapt; markdown wraps narrower, images shrink to
  fit.

The runtime is unchanged on mobile — long-running agents work the same
way; you just have a smaller window into them.

## Troubleshooting

**Session is stuck in `running` and nothing's happening.**
Check the **logs** inspector tab. Common causes: LLM provider rate
limit, expired GitHub Copilot token (use the Admin Console to update),
worker disconnected.

**Session won't appear in the list.**
Refresh. Check the owner filter — it may be filtered out.

**Sub-agent finished but parent didn't notice.**
The parent batches child updates for ~30 seconds before dispatching.
Wait. If still nothing, check the parent's **sequence** tab for
`pendingChildDigest` events.

**Worker died and now everything is stuck.**
Restart workers. Sessions in `waiting` resume automatically when their
timer fires; sessions mid-turn replay from the last yield.

**The portal is showing stale data.**
Hit your browser's reload. The portal state is recoverable from the
catalog and the runtime — there's no client-side state worth losing.

For deeper issues see [Architecture](../architecture.md) and
[Orchestration Design](../orchestration-design.md).

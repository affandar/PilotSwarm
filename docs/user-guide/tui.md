# PilotSwarm User Guide — Terminal UI

This guide walks through the terminal UI scenario by scenario, from "say
hello" all the way to multi-hour, multi-agent workflows.

If you'd rather use a browser, see the [portal guide](./portal.md). The two
surfaces share the same sessions, so you can switch between them at any
point.

For the full keybinding reference, see [keybindings.md](../keybindings.md).
This guide introduces keys as you need them.

## Prerequisites

Either:

- **Docker quickstart** (easiest): `docker run -d -p 127.0.0.1:3001:3001 -p 127.0.0.1:2222:2222 -e GITHUB_TOKEN -v pilotswarm-data:/data --name pilotswarm-starter affandar/pilotswarm-starter:latest`, then `ssh -p 2222 pilotswarm@localhost` (password: `pilotswarm`).
- **From source**: clone the repo, run `npm install && npm run build`, set up `.env` (see [getting-started.md](../getting-started.md)), then `./run.sh local --db`.

In either case you'll land on the **Sessions** pane focused on the left.
That's the entry point for everything below.

---

# Part 1 — Beginner

## Scenario 1: Say hello

**What you're trying to do:** prove the system works end to end with a
single short conversation.

**Setup:** PilotSwarm running. You're at the workspace.

**Steps:**

1. Press `n` to create a new session. The agent picker opens.
2. Pick the default agent (just `Enter`). A new session row appears.
3. Press `p` to focus the prompt editor at the bottom.
4. Type `What's the weather in NYC?` and press `Enter`.
5. Watch the message badge next to your text:
   - `○` — your client has the message but the runtime hasn't ack'd it yet
   - `✓` — durably queued
   - `✓✓` — the agent's seen it
6. The session badge transitions: `pending` → `running`. The chat pane streams the response. The activity pane (next pane over) shows tool calls / events as they fire.
7. When the agent is done, the badge goes to `idle`.
8. Press `q` to quit.

**What just happened:**

Your message went into a durable Postgres queue. A worker picked it up,
spawned a Copilot SDK session, ran a single LLM turn, and published the
response back through the orchestration's custom-status channel. The whole
thing was crash-safe — if the worker had died mid-turn, a different worker
would've replayed it from where it left off.

**Try this next:**

- Press `m` repeatedly to cycle through inspector tabs (`sequence`, `logs`,
  `nodes`, `history`, `files`, `stats`). Each shows a different view of the
  same session. You can come back to these in Scenario 6.
- Press `t` on the session to rename it to something memorable. Sessions
  get auto-titled by the LLM but you can override.

---

## Scenario 2: Watch a long task suspend and resume

**What you're trying to do:** see the durability story with your own eyes,
not believe the marketing.

**Setup:** Continuing from Scenario 1.

**Steps:**

1. Press `n` for a new session. Pick the default agent.
2. Press `p` for prompt focus. Type:

       Wait for 60 seconds, then tell me what time it is.

3. Send (`Enter`).
4. The agent calls `wait(60)`. Within a turn or two, the session badge
   changes to `waiting` with a countdown — something like
   `waiting · 58s · "user requested wait"`.
5. Press `m` until the inspector shows the **sequence** tab. Find the
   `wait_started` event and the `dehydrate` activity. The session is now
   archived to blob storage.
6. **Optional durability proof:** press `q` to quit the TUI entirely. The
   worker process exits. Wait until your phone clock has advanced ~70
   seconds. Restart with `./run.sh local --db` (or `ssh` back into the
   Docker quickstart). Find the session — it picks up exactly where it
   left off and finishes its turn.
7. The agent emits its final response. The session goes back to `idle`.

**What just happened:**

The agent's `wait(60)` tool call became a durable Postgres timer. The live
in-memory session was packaged up (dehydrated) and pushed to blob storage.
The worker process was free to do other work — or, in step 6, exit
entirely. When the timer fired, the orchestration runtime asked some
worker to rehydrate that session and resume the turn. The model didn't
notice the worker change; from its perspective there was a 60-second pause
between two messages.

**Try this next:**

- Same scenario but with `Wait for 5 minutes`. Notice that for short waits
  (under ~30 seconds) the session **doesn't** dehydrate — it stays warm to
  avoid the round-trip cost.
- Try `cron`: ask the agent `Tell me the time every 30 seconds, three
  times`. The session uses `cron(30)` and re-arms itself between each
  cycle.

---

## Scenario 3: Two things at once

**What you're trying to do:** run sessions in parallel and move fluidly
between them.

**Setup:** From Scenario 1 or 2.

**Steps:**

1. Press `n`, create a second session. Send any prompt.
2. Press `n` again, create a third. Send another prompt.
3. Move between sessions with `j` / `k` (or `↓` / `↑`) in the Sessions
   pane.
4. The chat pane re-renders for whichever session is selected. Older
   history can be expanded with `e` while focused on chat.
5. Press `[` and `]` to resize the split between sessions and the
   workspace.
6. Press `Tab` to cycle pane focus (Sessions → Chat → Activity → Inspector).
7. Press `P` (capital) on a session to pin it. Pinned sessions stay at the
   top of the list across refreshes. Useful for keeping your "main"
   session always visible.

**Multi-select:**

8. Press `V` to enter multi-select mode. Your active session is selected
   automatically.
9. Press `Space` on other rows to add them to the selection.
10. Press `c` to cancel every selected session in one confirmation.
    System sessions (the framework's always-on agents) are skipped.
11. Press `Esc` to exit multi-select.

**What just happened:**

Each session is its own durable orchestration. They run independently in
parallel — different workers can be handling different sessions at any
given moment. The Sessions pane is a live view backed by the catalog;
when a state changes anywhere (a different worker, a different machine),
your pane reflects it within a poll cycle.

**Try this next:**

- Press `r` at any time to force-refresh the catalog view.
- Press `f` to filter the session list by owner. Useful once you have
  many users hitting the same Postgres.

---

# Part 2 — Intermediate

## Scenario 4: Bulk-cleanup messy sessions

**What you're trying to do:** you've left 12 sessions running from
yesterday's experiments. Keep three, kill nine.

**Setup:** Lots of stale sessions in the list.

**Steps:**

1. Press `f` to open the owner filter and narrow to just yours.
2. For each session you want to keep, press `t` and rename to something
   memorable (e.g. `[KEEP] weather monitor`).
3. Press `P` to pin the keepers. Pinned sessions move to the top.
4. Press `V` to enter multi-select.
5. Walk down the list with `j`, hit `Space` on each one you want gone.
   Skip the pinned/renamed keepers.
6. Press `c` to cancel the selected sessions. Confirm.
7. Press `Esc` to leave multi-select. Press `r` to refresh.

**Three flavors of close:**

| Key | Effect |
|---|---|
| `c` | **Cancel** — graceful shutdown. Cascades to sub-agents. CMS state → `cancelled`. |
| `d` | **Done** — graceful completion. Same cascade. CMS state → `completed`. The "I finished, archive this" verb. |
| `Shift+D` | **Delete** — hard delete. Removes from CMS along with all descendants. Use sparingly — you can't undo it. |

`c` and `d` are equivalent in effect (both terminate the session
gracefully), but `d` is the right verb when the agent's work is done and
you want it to stop because it's *complete*, not because you're killing
it.

**What just happened:**

Each `c` you pressed enqueued a `cancel` command into that session's
durable queue. The orchestration drained the command, cascaded `cancel`
to any running sub-agents, waited up to 60 seconds for them to drain
gracefully, then updated CMS state and tore down the live session. If
you'd used `Shift+D`, it would also have removed all CMS rows and
descendant sessions.

**Try this next:**

- After a bulk cancel, watch a sub-agent-rich session in the inspector's
  **sequence** tab. You'll see the cascade in action — child cancellations
  poll-acked one by one before the parent finishes.

---

## Scenario 5: Hand the agent a file, get a file back

**What you're trying to do:** feed the agent a CSV of error logs, ask it
to summarize, get a markdown report you can open externally.

**Setup:** A new session, default agent.

**Steps:**

1. In the prompt editor, press `Ctrl+A` to attach a file. The attach
   dialog opens; type the path (or paste it).
2. The file is uploaded immediately. When the dialog closes, your prompt
   has an `artifact://...` reference inserted at the cursor.
3. Type around it, e.g.:

       Look at artifact://errors.csv. Summarize the top 5 root causes
       as a markdown report. Use write_artifact + export_artifact so I
       can open it.

4. Send (`Enter`). The agent reads your CSV, runs analysis, calls
   `write_artifact` and `export_artifact`.
5. Press `m` until the inspector is on the **files** tab. The new artifact
   appears in the list.
6. With the file selected:
   - `j` / `k` scrolls the preview, `Ctrl+D` / `Ctrl+U` pages it.
   - `g` / `G` jumps to top / bottom.
   - `v` toggles fullscreen preview (great for long reports).
   - `o` opens the file in your OS default app — useful for PDFs, images, anything beyond plain markdown.
   - `x` deletes the artifact (with confirm).
7. Press `f` to filter the file list — `Selected session` shows only this
   session's files; `All sessions` shows artifacts across the catalog.

**What just happened:**

Your `Ctrl+A` upload went into a storage-backed artifact store
(filesystem in local mode, blob in production). The agent received an
`artifact://` reference in the prompt, called the same artifact API on
its end to read it, and wrote a new artifact back. Artifacts persist
across worker pods — different workers can read and write the same store
because it's not local disk.

**Try this next:**

- Press `a` (anywhere in the workspace, not in prompt mode) to open the
  **linked-item picker**. It collects every `artifact://` reference and
  every URL from the current chat into one navigable list — handy when
  the agent generates a report referencing other files.

---

## Scenario 6: Drilling into what an agent did

**What you're trying to do:** an agent took 30 seconds for a trivial
turn and you want to know why.

**Setup:** A session with at least one completed turn (any of the
previous scenarios works).

**Steps — cycle through every inspector tab:**

Press `m` repeatedly. Each press cycles to the next tab. Each shows a
different view of the same session.

1. **`sequence`** — every yield in the orchestration: prompt received,
   runTurn started, tool calls, wait timers, dehydrate/hydrate events,
   continueAsNew, etc. Read this top-to-bottom to reconstruct the turn.
2. **`logs`** — raw log output from the worker. Inside the logs tab:
   - `t` toggles tail mode (auto-follow new lines).
   - `f` opens the log filter dialog (severity + keyword).
3. **`nodes`** — which worker pod handled which turn. In a multi-worker
   deployment this shows session relocation across nodes during dehydrate
   / rehydrate.
4. **`history`** — the durable event log from the catalog. Every
   `user.message`, `assistant.message`, `session.wait_started`,
   `session.cron_fired`, `session.command_received`, etc. This is the
   replayable record.
5. **`files`** — covered in Scenario 5.
6. **`stats`** — token usage, turn durations, context window utilization.
   Inside the stats tab:
   - `f` cycles between `session` (this session), `fleet` (the whole
     deployment), and `users` (per-owner aggregates).

**Diagnosing the slow turn:**

7. Open the **sequence** tab. Look for the gap. Is it between two events
   on the same line (slow LLM call)? Between two activities (slow
   dehydrate or slow CMS write)? Around a `wait_started` (the agent
   *meant* to be slow)?
8. Cross-reference with the **logs** tab — `t` to tail, `f` to filter on
   "warn" or "error".
9. The **nodes** tab tells you whether the slowness was on one specific
   worker (probably that pod's problem) or all workers (probably the
   model or the database).

**What just happened:**

Each tab is rendered from a different data source: `sequence` reads from
duroxide's history table, `logs` from worker stdout, `nodes` from
`session_events` cross-joined with worker IDs, `history` from CMS event
log, `files` from artifact storage, `stats` from a metrics summary table
the worker writes after each turn. The TUI is read-only for these views;
nothing here mutates the session.

**Try this next:**

- The same six tabs show the same data in the portal. If you find yourself
  squinting at a long sequence, switching to the portal for that
  inspection sometimes helps.

---

# Part 3 — Advanced

## Scenario 7: Sub-agents and the spawn tree

**What you're trying to do:** dispatch parallel sub-agents to investigate
different angles of the same question.

**Setup:** This works best with the [DevOps Command Center
sample](../../examples/devops-command-center/README.md) plugin loaded.
You can also do it with the default agent, but the sample app's tools
make it more interesting.

**Steps:**

1. `Shift+N` to open the agent picker before creating the session. Pick
   `investigator` (from the sample app) or any agent that's allowed to
   spawn children.
2. Send a prompt that invites parallel work, e.g.:

       Investigate the latency spike at 14:32. Spawn separate sub-agents
       to check metrics, scan logs, and look at recent deploys. Then
       summarize.

3. Watch the Sessions pane. New child sessions appear nested beneath the
   parent.
4. Press `+` (or `=`) on the parent row to expand the tree. `-` to
   collapse.
5. The parent's chat pane shows incoming child digest messages — short
   summaries of what each child reports back, batched every ~30 seconds.
6. Children stay alive after their final reply. Their badges go to `idle`,
   not `completed`. The parent decides when they're really done.
7. When the parent is satisfied, it calls `complete_agent` for each
   child. Watch the child badges go through `cancelled` → gone (or to
   `completed` for `done`).

**The `wait_for_agents` tool:**

8. Try a follow-up that explicitly blocks the parent on the children:

       Spawn three more sub-agents with different hypotheses. Use
       wait_for_agents to block until all three respond, then merge
       their answers.

9. The parent session's badge goes to `waiting` — but unlike a `wait()`
   call, the wait reason is "waiting for N agents to complete". The
   parent rehydrates as soon as the last child finishes.

**What just happened:**

`spawn_agent` is a tool the LLM calls. The orchestration takes that tool
call, creates a new child session via the SDK client, sends it the
bootstrap prompt, and tracks it in the parent's `subAgents` table.
Children communicate back to the parent via durable messages on the
parent's queue (`[CHILD_UPDATE from=... type=...]` envelopes), which the
parent's drain logic batches into a 30-second digest before dispatching
as a single LLM turn.

Children staying alive after final reply is the v1.0.49+ lifecycle —
before that, children auto-terminated. The new behavior makes follow-up
conversations possible: the parent can `message_agent` a still-alive
child for clarifications.

**Try this next:**

- Send a message directly to a child by selecting it and pressing `p`.
  The child runs as a regular session; the only thing that's special is
  that its responses also feed back to the parent's queue.

---

## Scenario 8: A delayed multi-step workflow (the durability flagship)

**What you're trying to do:** a real long-haul workflow that survives
across worker restarts, scales to zero between turns, and produces an
artifact at the end. Leave it running, come back tomorrow.

**Setup:** DevOps Command Center sample plugin. The Watchdog and Janitor
system agents auto-start.

**Steps:**

1. Watchdog is already running — find it in the sessions list (it'll be
   marked as a system session). It has a cron schedule that polls
   service health every few minutes.
2. Spawn a Reporter via `Shift+N`. Send:

       Generate a daily incident report at midnight UTC. Aggregate
       data from Watchdog's findings over the last 24h. Write it
       as a markdown artifact and export it for download.

3. The Reporter calls `cron(86400, "midnight UTC")` (or similar). It then
   exits its turn — the badge goes to `waiting · ~5h to next fire` (or
   however long until midnight UTC).
4. **Now leave it.** Quit the TUI (`q`). Shut down your laptop. Whatever.
   Postgres and the workers (locally embedded or remote) keep running.
5. Come back tomorrow. Restart the TUI.
6. The Reporter's session is still there, in the list. Open it (`Enter`).
7. Look at the chat history — at midnight UTC the cron fired, the agent
   ran a turn that called Watchdog's findings, generated the report,
   wrote and exported it. The session is back in `waiting` for the next
   midnight.
8. Press `m` to the **files** tab. Today's report is there. `o` to open
   it.
9. Optionally, the Reporter might have asked a question via `ask_user` —
   the badge would be `input_required` instead of `waiting`. Press `p`
   and answer; the agent resumes from your reply.

**Combining everything:**

Try a longer chain: have an Investigator start, find a deploy
correlation in metrics, spawn a Deployer with `ask_user` for human
approval, deploy after you approve, then have a Reporter aggregate the
result. Single workflow, multiple agents, multiple workers, durable
across all of them. This is what PilotSwarm is for.

**What just happened:**

Each `wait`/`cron` call moved the session out of in-memory state into
durable storage. While the Reporter was sleeping until midnight, it was
literally a row in Postgres and a blob — zero compute. When midnight
hit, the runtime scheduled the next turn against any available worker.
That worker rehydrated the session from blob, ran one turn, dehydrated
it again. The "always-on Reporter" is actually intermittent execution
spread across days, but the LLM sees a coherent conversation.

**Try this next:**

- See how many long-haul sessions you can run simultaneously. Dehydrated
  sessions cost ~zero. The author has run 1000+ on a 2-node cluster.

---

## Scenario 9: TUI ↔ portal — same sessions, different surface

**What you're trying to do:** start work in the TUI, continue in the
browser. Or vice versa.

**Setup:** Portal running on `http://localhost:3001`, TUI open via `ssh`
or `./run.sh`.

**Steps:**

1. Start a session in the TUI as in Scenario 1. Send a couple of
   messages.
2. In your browser, open `http://localhost:3001`. (If you're running the
   Docker quickstart, this Just Works.)
3. The same sessions list you see in the TUI is on the left in the
   portal.
4. Click the session you started in the TUI. The chat history is there.
5. Send a message from the portal. Tab back to your TUI — the message
   shows up in your TUI's chat pane within a poll cycle.
6. The state badges, message states (`○`/`✓`/`✓✓`), inspector tabs,
   files — all match.

**Admin Console (`Shift+A`):**

7. Press `Shift+A` to open the per-user admin console. Profile, GitHub
   Copilot key, refresh. Useful when your Copilot token expires and you
   need to update it without restarting.
8. Press `e` to begin editing the key. Type the new key (input is masked
   on screen). `Enter` to save. `Esc` to cancel.

**What just happened:**

Both surfaces talk to the same Postgres + duroxide pair. They both poll
the catalog and the orchestration's custom-status. No "primary" surface
— either can drive a session, both reflect changes within a poll cycle.
The only meaningful difference is that the portal supports mobile
layouts and richer inline previews; the TUI is faster for keyboard-heavy
work and runs over SSH.

**Try this next:**

- Open the portal on your phone and check on long-running sessions while
  away from your desk.

---

## Scenario 10: Make it your own

**What you're trying to do:** build a custom agent for your specific
domain. (This crosses into developer territory, but it's the natural
next step for power users.)

This scenario is summarized here; for the full walkthrough see
[Building SDK Apps](../sdk/building-apps.md) and
[Building CLI Apps](../cli/building-cli-apps.md).

**The plugin model:**

1. Create a `plugin/` directory with subfolders for `agents/`, `skills/`,
   and an optional `worker-module.js` for custom tools.
2. Define an agent in `agents/your-agent.agent.md` with YAML frontmatter
   (name, title, system message, allowed tools, etc.) and a body that
   becomes the agent's system prompt.
3. Register custom tools in `worker-module.js` via `defineTool(...)`.
4. Set `PLUGIN_DIRS=./plugin` in your `.env` and restart workers (today;
   hot reload is on the roadmap).
5. Press `Shift+N` in the TUI — your new agent appears in the picker.

**What you can customize:**

- **Agents** — system prompts, allowed tools, default model, behavior
  hints
- **Tools** — anything you can write in JS/TS, called via `defineTool()`
- **Skills** — markdown-based playbooks the agent loads on demand
- **MCP servers** — connect external tool surfaces
- **UI splash + theme** — branding for the TUI/portal when run as your
  app's front-end
- **Session policy** — restrict which agents users can create

The [DevOps Command Center sample](../../examples/devops-command-center/README.md)
is a complete reference plugin. Copy it, swap out the tools, ship it as
your app.

---

# Reference

## Quick keybinding cheat sheet

The full list lives in [keybindings.md](../keybindings.md). The
high-frequency ones:

| Key | Action |
|---|---|
| `n` | New session |
| `Shift+N` | New session, pick agent first |
| `p` | Focus prompt |
| `Enter` | Send prompt |
| `j` / `k` | Move down / up |
| `Tab` / `Shift+Tab` | Cycle pane focus |
| `m` | Cycle inspector tab |
| `[` / `]` | Resize main split |
| `c` / `d` / `Shift+D` | Cancel / Done / Delete |
| `t` | Rename session |
| `P` | Pin / unpin session |
| `V` / `Space` / `Esc` | Multi-select |
| `Ctrl+A` | Attach file |
| `r` | Refresh |
| `a` | Linked-item picker |
| `Shift+A` | Admin Console |
| `q` | Quit |

## Troubleshooting

**Session is stuck in `running` and nothing's happening.**
Check the **logs** inspector tab (`m` to it, `t` for tail mode). Common
causes: LLM provider rate limit, expired GitHub Copilot token (use
`Shift+A` → `e` to update), worker disconnected.

**Session won't appear in the list.**
Press `r` to force-refresh. If it still doesn't show, check the **owner
filter** (`f` in the sessions pane) — it may be filtered out.

**Sub-agent finished but parent didn't notice.**
The parent batches child updates for ~30 seconds before dispatching
them. Wait. If still nothing, check the parent's **sequence** tab for
`pendingChildDigest` events.

**Agent says it called `wait()` but the badge still says `running`.**
The orchestration may be in a retry loop. Check **logs** for
`runTurn FAILED` messages.

**Worker died and now everything is stuck.**
Restart the worker (`./run.sh local --db` again, or `kubectl rollout
restart` in production). Sessions in `waiting` resume automatically when
their timer fires; sessions mid-turn replay from the last yield.

For deeper issues see [Architecture →
Recovery](../architecture.md#34-session-catalog-cms) and the
[orchestration design](../orchestration-design.md).

# PilotSwarm Starter Docker Quickstart

PilotSwarm can be up and running in a few minutes from a single Docker image.

This starter image gives you:

- a browser portal at `http://localhost:3001`
- an SSH-accessible TUI at `ssh -p 2222 pilotswarm@localhost`
- two background PilotSwarm workers
- durable session state in PostgreSQL
- local filesystem artifacts by default, or Azure Blob storage if you wire it in

If you want the fastest path to seeing PilotSwarm do real work, start with the portal.

---

## What You Are Launching

```text
                    ┌──────────────────────────────┐
                    │        Your Browser          │
                    │    http://localhost:3001     │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │       Portal Process         │
                    │   browser UI + API server    │
                    └──────────────┬───────────────┘
                                   │
     ┌─────────────────────────────┼─────────────────────────────┐
     │                             │                             │
┌────▼─────┐                 ┌─────▼─────┐                 ┌────▼─────┐
│ Worker A │                 │ PostgreSQL│                 │ Worker B │
│ runtime  │                 │ session   │                 │ runtime  │
│ process  │                 │ catalog   │                 │ process  │
└────┬─────┘                 └─────┬─────┘                 └────┬─────┘
     │                             │                             │
     └──────────────┬──────────────┴──────────────┬──────────────┘
                    │                             │
           ┌────────▼────────┐           ┌────────▼────────┐
           │ Local filestore │           │ Azure Blob      │
           │ default         │           │ optional        │
           │ /data           │           │ if configured   │
           └─────────────────┘           └─────────────────┘

                    ┌──────────────────────────────┐
                    │          SSH TUI             │
                    │ ssh -p 2222 pilotswarm@...   │
                    └──────────────────────────────┘
```

The important mental model is simple:

- the portal and TUI are clients
- the two workers do the actual orchestration work
- PostgreSQL stores the durable session state
- artifacts and dehydrated session files live in local storage by default, or Blob if configured

That means a session can pause, wake up, move between workers, and keep going without you babysitting it.

---

## Step 1: Pull The Image

```bash
docker pull affandar/pilotswarm-starter:latest
```

If you want the exact released build instead of the moving `latest` tag, pull the versioned image:

```bash
docker pull affandar/pilotswarm-starter:0.1.17
```

---

## Step 2: Run PilotSwarm

Replace `YOUR_GITHUB_TOKEN` with your GitHub Copilot-enabled token.

```bash
docker run -d \
  --name pilotswarm-starter \
  -p 127.0.0.1:3001:3001 \
  -p 127.0.0.1:2222:2222 \
  -e GITHUB_TOKEN=YOUR_GITHUB_TOKEN \
  -v pilotswarm-data:/data \
  affandar/pilotswarm-starter:latest
```

That is the simplest mode:

- portal exposed at `http://localhost:3001`
- SSH TUI exposed at port `2222`
- embedded PostgreSQL enabled automatically
- local filestore used automatically

Open the portal:

```text
http://localhost:3001
```

Optional SSH access:

```bash
ssh -p 2222 pilotswarm@localhost
```

Default SSH password:

```text
pilotswarm
```

---

## Optional: Use External PostgreSQL Or Blob Storage

If you already have a shared PostgreSQL instance:

```bash
docker run -d \
  --name pilotswarm-starter \
  -p 127.0.0.1:3001:3001 \
  -p 127.0.0.1:2222:2222 \
  -e GITHUB_TOKEN=YOUR_GITHUB_TOKEN \
  -e DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME \
  -v pilotswarm-data:/data \
  affandar/pilotswarm-starter:latest
```

If you also want shared blob-backed artifacts and dehydration:

```bash
docker run -d \
  --name pilotswarm-starter \
  -p 127.0.0.1:3001:3001 \
  -p 127.0.0.1:2222:2222 \
  -e GITHUB_TOKEN=YOUR_GITHUB_TOKEN \
  -e DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME \
  -e AZURE_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net" \
  -v pilotswarm-data:/data \
  affandar/pilotswarm-starter:latest
```

Storage behavior is:

- `AZURE_STORAGE_CONNECTION_STRING` set: use Azure Blob storage
- not set: use local filesystem storage under `/data`

---

## Step 3: Create Your First Generic Agent

Once the portal opens:

1. Click `New + Model`
2. Pick a model
3. Press `Create Session`
4. Give the agent a plain-English job in the chat

Starter-image model catalog currently includes:

- `claude-sonnet-4.6`
- `gpt-5.4`
- `gpt-5-mini`
- `gpt-5.4-mini`
- `claude-opus-4.6`

If you just want a strong first-run default:

- `claude-sonnet-4.6` is the safest general pick
- `gpt-5.4` is a strong reasoning/coding pick
- `claude-opus-4.6` is the heavyweight option for deeper analysis

---

## Step 4: Try A Prompt That Actually Shows Off The Runtime

These are intentionally designed to create durable, recurring sessions so you can watch PilotSwarm do more than one-shot chat.

### Prompt 1: Hacker News trend monitor every 5 minutes

```text
Track the top Hacker News trends in AI agents, coding tools, inference infrastructure, and MCP-style tooling. Check every 5 minutes. Each cycle, summarize what changed, what stayed stable, and what looks like a meaningful new signal instead of noise. Use subagents when useful, and keep the recurring monitor running until I tell you to stop.
```

What this does:

- creates a long-running recurring session
- usually fans work out through subagents
- gives you periodic summaries instead of one giant dump
- lets you watch hydration, timers, worker movement, and artifacts over time

### Prompt 2: Watch PilotSwarm repo changes every 5 minutes

```text
Monitor the PilotSwarm GitHub repository every 5 minutes for new commits, merged pull requests, release-related changes, and anything that looks like a significant change in orchestration, portal UX, or starter Docker behavior. Summarize deltas each cycle and keep the session running until I cancel it.
```

What this does:

- creates a recurring repo-monitor session
- turns the system into a live “change radar”
- produces a nice event stream in Activity and Sequence

### Prompt 3: Multi-model research swarm

```text
Every 5 minutes, summarize the latest movement in AI agent tooling using multiple subagents. Have one subagent use Claude Sonnet for broad synthesis, one use GPT-5.4 for cross-checking and structured takeaways, and one lightweight model for quick surface scans. Merge their findings into one short executive update and keep the loop running until I stop it.
```

What this does:

- creates a parent session plus child sessions
- lets you see model-specific work fan out
- makes the session tree, node map, and artifact flow much more interesting immediately

---

## What You Should Expect To See

Once one of those prompts is running, the portal becomes much more than a chat window.

### Sessions

The left session tree shows:

- the root session you created
- any child/subagent sessions it spawned
- current status markers like running, waiting, compacting, or cron cadence

This is the best place to see whether your “one request” turned into a little swarm.

### Inspector

The Inspector is the main conversation view for the selected session.

It shows:

- your messages
- agent replies
- system updates
- tables and artifacts
- recurring summaries over time

If the session is long-running, this becomes the durable narrative of what happened across cycles.

### Activity

Activity is the lower-level operational feed.

Use it when you want to see:

- turn starts and completions
- command dispatch
- tool calls
- session updates
- orchestration events landing in near real time

If the Inspector feels like the story, Activity feels like the engine room.

### Sequence

Sequence is where PilotSwarm starts to click for most people.

This pane shows the timeline across orchestration and worker nodes. Watch for:

- turns starting
- timers firing
- sessions waiting
- sessions rehydrating on a different worker
- subagents fanning out and completing

If a session idles, dehydrates, then wakes up later, Sequence shows the bounce clearly.

### Node Map

Node Map gives you the “where is this actually running?” view.

It helps answer:

- which worker currently holds the session
- where child agents landed
- whether work is balanced across `worker-a` and `worker-b`
- how sessions move after a wait, cron wake-up, or worker handoff

This is the pane that makes the runtime feel durable instead of fragile.

### History

History is the recent event and session-flow memory for that selected session. Use it to quickly skim prior iterations without scrolling through the full chat transcript.

### Files

Files is where artifacts show up:

- saved notes
- reports
- markdown summaries
- any generated outputs the session or its child agents persisted

This is the “show me what it actually produced” tab.

---

## How To Read Hydration And Dehydration

PilotSwarm sessions are designed to survive long waits and recurring work.

A typical recurring session lifecycle looks like this:

1. You send a prompt
2. A worker runs the turn
3. The agent sets a timer or recurring cron
4. The session goes idle
5. The session can dehydrate to durable storage
6. A timer fires later
7. The session rehydrates, possibly on another worker
8. The next cycle continues

That is why PilotSwarm can keep doing useful work even when:

- the session waits for minutes or hours
- one worker goes away
- you disconnect your browser
- you reconnect later from either the portal or the SSH TUI

In practice, the fun thing to watch is the Sequence pane after a few timer cycles. You will see the session pause, wake, move, and resume without losing the thread.

---

## What Happens If A Worker Dies?

In the starter image you have two workers.

That means:

- one worker can pick up work the other was not actively holding
- recurring sessions can continue on the other worker after rehydration
- if the whole container stops, the durable state still lives in PostgreSQL plus storage

If you restart the appliance against the same database and storage, long-running work can resume from there.

---

## A Good First 10-Minute Demo

If you want the cleanest “show me why this is interesting” flow:

1. Start the container
2. Open the portal
3. Create a generic session with `claude-sonnet-4.6`
4. Paste the Hacker News trend-monitor prompt
5. Let it run for 10 to 15 minutes
6. Open `Sequence`, `Node Map`, and `Files`
7. Watch child sessions, recurring timers, and summaries accumulate

That is usually enough to understand the core promise:

PilotSwarm is not just a chat shell. It is a durable multi-agent runtime with interfaces that let you actually see the work moving through the system.

---

## Handy Commands

Follow logs:

```bash
docker logs -f pilotswarm-starter
```

Stop the appliance:

```bash
docker stop pilotswarm-starter
```

Remove the container but keep the data volume:

```bash
docker rm -f pilotswarm-starter
```

Wipe everything, including local persisted data:

```bash
docker rm -f pilotswarm-starter
docker volume rm pilotswarm-data
```

---

## Next Step

After you are comfortable in the portal:

- try the SSH TUI
- run the same long-lived session from both surfaces
- watch the same session tree, activity, and artifacts appear in both places

That is when the architecture really lands: two interfaces, one durable runtime, shared state underneath.

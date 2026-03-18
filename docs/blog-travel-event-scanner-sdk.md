# Building a Travel Event Scanner with PilotSwarm SDK

*An AI agent that scrolls social media for you while you sleep.*

You're planning a trip to Barcelona. There's so much happening — concerts at tiny venues, pop-up markets in El Born, a food festival you'd never find on TripAdvisor, a gallery opening in Poblenou that only got posted on Instagram two hours ago. You could spend every evening refreshing feeds. Or you could spin up an agent that does it for you, 24/7, across every source, surviving process restarts, node migrations, and scaling events — for the entire duration of your trip planning.

This post builds a **Travel Event Scanner** — a Fastify REST API backed by PilotSwarm that creates long-running LLM agents per trip. Each agent periodically wakes up via durable timers, scans Eventbrite, social feeds, and local event sites, then pushes new finds to your travel dashboard via Server-Sent Events.

No polling infrastructure. No cron jobs. No process babysitting. The agent dehydrates to blob storage between scans and resumes on any available worker.

## Architecture

```
┌──────────┐     ┌─────────────────┐     ┌──────────────┐     ┌─────────────────────┐
│ Browser  │────▶│  Fastify API    │────▶│ PilotSwarm   │────▶│     PostgreSQL       │
│          │◀─SSE│  (REST + SSE)   │     │ Client       │     │  (orchestration +    │
└──────────┘     └─────────────────┘     └──────────────┘     │   session catalog)   │
                                                               └──────────┬──────────┘
                                                                          │
                                                               ┌──────────▼──────────┐
                                                               │  PilotSwarm Worker   │
                                                               │  ─ LLM turns         │
                                                               │  ─ Tool execution    │
                                                               │  ─ Dehydrate/hydrate │
                                                               │  ─ Azure Blob Store  │
                                                               └──────────────────────┘
```

The **Client** is lightweight — no GitHub token, no LLM execution. It creates sessions, sends prompts, and subscribes to events. The **Worker** runs on a separate process (or separate machine entirely). It executes LLM turns, calls tools, and manages session lifecycle. They share a PostgreSQL database as the coordination plane.

This separation means your web server stays thin. Session state, tool execution, and model inference all happen on the worker side.

## Project Setup

### Directory Structure

```
travel-scanner/
├── package.json
├── .env
├── model_providers.json
├── server.js                   # Fastify API
├── worker.js                   # PilotSwarm worker process
├── travel-plugin/
│   ├── plugin.json
│   ├── agents/
│   │   └── event-scanner.agent.md
│   └── skills/
│       └── durable-timers/     # inherited from system plugin
└── tools/
    ├── search-events.js
    ├── scan-social-feed.js
    ├── check-local-happenings.js
    └── notify-user.js
```

### package.json

```json
{
  "name": "travel-scanner",
  "type": "module",
  "version": "1.0.0",
  "scripts": {
    "start:worker": "node worker.js",
    "start:server": "node server.js",
    "start": "concurrently \"npm run start:worker\" \"npm run start:server\""
  },
  "dependencies": {
    "pilotswarm": "^1.0.0",
    "fastify": "^5.2.0",
    "@fastify/cors": "^10.0.0",
    "concurrently": "^9.0.0"
  }
}
```

### .env

```bash
DATABASE_URL=postgresql://localhost:5432/travel_scanner
GITHUB_TOKEN=ghp_your_token_here
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...
EVENTBRITE_TOKEN=your_eventbrite_token
```

### Model Providers

Create `model_providers.json` in the project root. The worker loads this automatically to resolve `provider:model` strings.

```json
{
  "providers": [
    {
      "id": "github-copilot",
      "type": "github",
      "githubToken": "env:GITHUB_TOKEN",
      "models": [
        {
          "name": "claude-sonnet-4.6",
          "description": "Best balance of speed and quality for tool-heavy agents.",
          "cost": "medium"
        },
        {
          "name": "gpt-4.1",
          "description": "Strong general-purpose model.",
          "cost": "medium"
        }
      ]
    }
  ],
  "defaultModel": "github-copilot:claude-sonnet-4.6"
}
```

## Custom Tools

Tools are defined with `defineTool()` from the Copilot SDK (re-exported by PilotSwarm). Each tool is a self-contained unit: name, JSON schema for parameters, and an async handler. Tools are registered on the **Worker** and referenced by name from the **Client**.

### search_events — Eventbrite API

```javascript
// tools/search-events.js
import { defineTool } from "@affandar/pilotswarm";

export const searchEventsTool = defineTool("search_events", {
  description:
    "Search for events on Eventbrite by location and date range. " +
    "Returns structured event data including title, date, venue, and URL.",
  parameters: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "City or area to search (e.g. 'Barcelona')",
      },
      start_date: {
        type: "string",
        description: "Start date in YYYY-MM-DD format",
      },
      end_date: {
        type: "string",
        description: "End date in YYYY-MM-DD format",
      },
      categories: {
        type: "string",
        description:
          "Comma-separated category filter (e.g. 'music,food,arts')",
      },
    },
    required: ["location", "start_date", "end_date"],
  },
  handler: async ({ location, start_date, end_date, categories }) => {
    const params = new URLSearchParams({
      "location.address": location,
      "start_date.range_start": `${start_date}T00:00:00`,
      "start_date.range_end": `${end_date}T23:59:59`,
    });
    if (categories) {
      params.set("categories", categories);
    }

    const res = await fetch(
      `https://www.eventbriteapi.com/v3/events/search/?${params}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.EVENTBRITE_TOKEN}`,
        },
      }
    );

    if (!res.ok) {
      return { error: `Eventbrite API error: ${res.status}` };
    }

    const data = await res.json();
    return {
      events: (data.events || []).slice(0, 20).map((e) => ({
        title: e.name?.text,
        description: e.description?.text?.slice(0, 200),
        start: e.start?.local,
        end: e.end?.local,
        venue: e.venue?.name,
        url: e.url,
        category: e.category?.name,
      })),
      total: data.pagination?.object_count || 0,
    };
  },
});
```

### scan_social_feed — Social Media Scanner

```javascript
// tools/scan-social-feed.js
import { defineTool } from "@affandar/pilotswarm";

export const scanSocialFeedTool = defineTool("scan_social_feed", {
  description:
    "Scan social media feeds (Instagram, X/Twitter) for event-related posts " +
    "in a given location. Returns recent posts mentioning events, pop-ups, " +
    "markets, or happenings.",
  parameters: {
    type: "object",
    properties: {
      platform: {
        type: "string",
        enum: ["instagram", "twitter"],
        description: "Social platform to scan",
      },
      location: {
        type: "string",
        description: "City or area to search",
      },
      hashtags: {
        type: "array",
        items: { type: "string" },
        description:
          "Hashtags to search for (e.g. ['barcelonaevents', 'bcnfoodie'])",
      },
      since_hours: {
        type: "number",
        description: "Only return posts from the last N hours (default: 24)",
      },
    },
    required: ["platform", "location"],
  },
  handler: async ({ platform, location, hashtags, since_hours }) => {
    const hours = since_hours || 24;
    const tags = hashtags || [`${location.toLowerCase()}events`];

    // In production, integrate with the platform's API or a social listening service.
    // This example uses a hypothetical social search endpoint.
    const res = await fetch("https://api.your-social-service.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform,
        location,
        hashtags: tags,
        since_hours: hours,
      }),
    });

    if (!res.ok) {
      return { error: `Social feed API error: ${res.status}` };
    }

    const data = await res.json();
    return {
      platform,
      posts: (data.posts || []).slice(0, 15).map((p) => ({
        author: p.author,
        text: p.text?.slice(0, 300),
        url: p.url,
        posted_at: p.created_at,
        engagement: p.likes + p.shares,
      })),
      scanned_hashtags: tags,
    };
  },
});
```

### check_local_happenings — Local Event Sites

```javascript
// tools/check-local-happenings.js
import { defineTool } from "@affandar/pilotswarm";

export const checkLocalHappeningsTool = defineTool("check_local_happenings", {
  description:
    "Check local event aggregator sites for a city. Covers sources that " +
    "Eventbrite misses: municipal event boards, local culture blogs, " +
    "venue calendars, and tourism office listings.",
  parameters: {
    type: "object",
    properties: {
      city: {
        type: "string",
        description: "City name (e.g. 'Barcelona')",
      },
      date_from: {
        type: "string",
        description: "Start date in YYYY-MM-DD format",
      },
      date_to: {
        type: "string",
        description: "End date in YYYY-MM-DD format",
      },
      types: {
        type: "array",
        items: { type: "string" },
        description:
          "Event types to filter (e.g. ['concert', 'market', 'festival', 'gallery'])",
      },
    },
    required: ["city", "date_from", "date_to"],
  },
  handler: async ({ city, date_from, date_to, types }) => {
    const params = new URLSearchParams({
      city,
      from: date_from,
      to: date_to,
    });
    if (types && types.length > 0) {
      params.set("types", types.join(","));
    }

    const res = await fetch(
      `https://api.your-local-events.com/happenings?${params}`
    );

    if (!res.ok) {
      return { error: `Local events API error: ${res.status}` };
    }

    const data = await res.json();
    return {
      city,
      events: (data.events || []).slice(0, 25).map((e) => ({
        title: e.title,
        type: e.type,
        date: e.date,
        time: e.time,
        venue: e.venue,
        neighborhood: e.neighborhood,
        source: e.source_name,
        url: e.url,
        free: e.is_free,
      })),
    };
  },
});
```

### notify_user — Push Notification

```javascript
// tools/notify-user.js
import { defineTool } from "@affandar/pilotswarm";

export const notifyUserTool = defineTool("notify_user", {
  description:
    "Send a push notification to the user about a newly discovered event. " +
    "Use this when you find something especially relevant to their interests.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Notification title",
      },
      body: {
        type: "string",
        description: "Notification body text",
      },
      url: {
        type: "string",
        description: "Link to the event",
      },
      priority: {
        type: "string",
        enum: ["low", "normal", "high"],
        description: "Notification priority (default: normal)",
      },
    },
    required: ["title", "body"],
  },
  handler: async ({ title, body, url, priority }) => {
    // In production, integrate with your push notification service
    // (e.g. Firebase Cloud Messaging, Apple Push Notification Service, or a webhook).
    console.log(`[NOTIFY] ${priority || "normal"}: ${title} — ${body}`);

    // Example: POST to a webhook endpoint
    const res = await fetch(process.env.NOTIFICATION_WEBHOOK_URL || "https://api.your-push-service.com/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        body,
        url: url || null,
        priority: priority || "normal",
      }),
    });

    if (!res.ok) {
      return { error: `Push notification failed: ${res.status}` };
    }

    return { sent: true, title };
  },
});
```

## The Event Scanner Agent

PilotSwarm loads agent definitions from `.agent.md` files inside plugin directories. An agent file is a markdown file with YAML frontmatter that defines the agent's name, tools, and system prompt. The worker loads these automatically from directories listed in `pluginDirs`.

For the plugin architecture details and directory structure, see the [Plugin Architecture Guide](plugin-architecture-guide.md).

### Plugin Manifest

```json
{
  "name": "travel-scanner",
  "description": "Travel event scanner agent with social feed monitoring tools.",
  "version": "1.0.0",
  "agents": "agents/",
  "skills": "skills/"
}
```

Save this as `travel-plugin/plugin.json`.

### Agent Definition

```markdown
---
name: event-scanner
description: Monitors multiple event sources for a travel destination and reports new findings.
tools:
  - search_events
  - scan_social_feed
  - check_local_happenings
  - notify_user
  - wait
---

# Event Scanner Agent

You are a travel event discovery agent. Your job is to continuously monitor event sources for a specific destination and date range, finding interesting events the traveler might enjoy.

## Your workflow

1. When given a destination and travel dates, immediately do a first scan across all sources:
   - Search Eventbrite for structured event listings
   - Scan social media for trending event posts and local recommendations
   - Check local event aggregators for community events, markets, and pop-ups
2. Compile your findings into a structured report with event name, date, type, venue, and a link
3. Send a push notification for any particularly exciting finds
4. Call `wait(3600)` to sleep for 1 hour
5. When you wake up, scan again — but focus on NEW events since your last scan
6. Repeat this cycle until the traveler's trip end date has passed

## Important rules

- ALWAYS use the `wait` tool for periodic scanning — never try to loop without waiting
- After each wait, you resume on a potentially different worker node — do NOT rely on in-memory state
- Keep a running summary of events you've already reported to avoid duplicates
- Prioritize events that match the traveler's stated interests
- Include a mix of popular and off-the-beaten-path finds
- When scanning social media, use location-specific hashtags
```

Save this as `travel-plugin/agents/event-scanner.agent.md`.

## The Durable Timer Pattern

This is the key architectural insight. When the agent calls `wait(3600)`, here's what actually happens:

1. The agent's LLM turn completes with a `wait` tool call
2. The orchestration catches the wait result and dehydrates the session — the full conversation history is serialized to Azure Blob Storage
3. A **durable timer** is scheduled in the duroxide orchestration engine (persisted in PostgreSQL)
4. The worker releases all in-memory state for this session. It can handle other sessions, or even shut down entirely
5. One hour later, the durable timer fires. Duroxide picks any available worker
6. That worker **hydrates** the session — downloads the conversation from blob storage, rebuilds the `CopilotSession`
7. The agent continues from exactly where it left off, with full conversation history intact

The agent doesn't know any of this happened. It just called `wait(3600)` and woke up an hour later. But behind the scenes, the process may have restarted, the pod may have been rescheduled to a different node, and a different worker instance may be handling the resumed session.

PilotSwarm ships with a built-in **durable-timers skill** that teaches agents this pattern. The skill is loaded automatically from the system plugin, so agents understand the `wait` → dehydrate → timer → hydrate lifecycle without any extra configuration.

## The Fastify REST API

The server process runs `PilotSwarmClient` — no GitHub token needed, no LLM execution. It creates sessions, sends messages, and subscribes to events.

### server.js

```javascript
// server.js
import Fastify from "fastify";
import cors from "@fastify/cors";
import { PilotSwarmClient } from "@affandar/pilotswarm";

const fastify = Fastify({ logger: true });
await fastify.register(cors);

// ── PilotSwarm Client ────────────────────────────────────────────
const client = new PilotSwarmClient({
  store: process.env.DATABASE_URL,
});
await client.start();

// In-memory trip → session mapping (use a database in production)
const trips = new Map();

// ── POST /trips — Create a trip and start scanning ──────────────
fastify.post("/trips", async (request, reply) => {
  const { destination, start_date, end_date, interests } = request.body;

  const session = await client.createSession({
    toolNames: [
      "search_events",
      "scan_social_feed",
      "check_local_happenings",
      "notify_user",
    ],
    model: "github-copilot:claude-sonnet-4.6",
  });

  const tripId = crypto.randomUUID();
  trips.set(tripId, {
    tripId,
    sessionId: session.sessionId,
    destination,
    start_date,
    end_date,
    interests,
    created_at: new Date().toISOString(),
  });

  // Send the initial prompt — don't await the full result
  const prompt =
    `Find events in ${destination} from ${start_date} to ${end_date}. ` +
    `My interests: ${interests || "anything fun"}. ` +
    `Scan all sources (Eventbrite, social media, local sites), ` +
    `compile a report, then set up hourly monitoring until the trip ends.`;

  // Fire and forget — the agent runs asynchronously
  session.sendAndWait(prompt).catch((err) => {
    fastify.log.error({ tripId, err: err.message }, "Session error");
  });

  return reply.code(201).send({
    tripId,
    sessionId: session.sessionId,
    status: "scanning",
    message: `Event scanner started for ${destination}`,
  });
});

// ── GET /trips/:id — Trip status and latest finds ───────────────
fastify.get("/trips/:id", async (request, reply) => {
  const trip = trips.get(request.params.id);
  if (!trip) {
    return reply.code(404).send({ error: "Trip not found" });
  }

  const info = await client.getSessionInfo(trip.sessionId);

  return {
    ...trip,
    session: {
      status: info.status,
      lastActivity: info.lastActivity,
      turnCount: info.turnCount,
    },
  };
});

// ── POST /trips/:id/messages — Update preferences ───────────────
fastify.post("/trips/:id/messages", async (request, reply) => {
  const trip = trips.get(request.params.id);
  if (!trip) {
    return reply.code(404).send({ error: "Trip not found" });
  }

  const { message } = request.body;
  const session = client.getSession(trip.sessionId);

  // Send a follow-up message to the running agent
  const result = await session.sendAndWait(message);

  return { response: result };
});

// ── GET /trips/:id/events — SSE event stream ────────────────────
fastify.get("/trips/:id/events", async (request, reply) => {
  const trip = trips.get(request.params.id);
  if (!trip) {
    return reply.code(404).send({ error: "Trip not found" });
  }

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const session = client.getSession(trip.sessionId);

  const unsubscribe = session.on((event) => {
    const payload = JSON.stringify({
      type: event.eventType,
      data: event.data,
      seq: event.seq,
    });
    reply.raw.write(`data: ${payload}\n\n`);
  });

  // Clean up on client disconnect
  request.raw.on("close", () => {
    unsubscribe();
    reply.raw.end();
  });
});

// ── Start server ─────────────────────────────────────────────────
const port = process.env.PORT || 3000;
await fastify.listen({ port: Number(port), host: "0.0.0.0" });
console.log(`Travel scanner API running on http://localhost:${port}`);
```

## The Worker Process

The worker runs separately. It handles all LLM execution, tool calls, and session lifecycle. In development you can run both processes locally; in production the worker runs on dedicated compute (see [Production Deployment](#production-deployment)).

### worker.js

```javascript
// worker.js
import { PilotSwarmWorker } from "@affandar/pilotswarm";
import { searchEventsTool } from "./tools/search-events.js";
import { scanSocialFeedTool } from "./tools/scan-social-feed.js";
import { checkLocalHappeningsTool } from "./tools/check-local-happenings.js";
import { notifyUserTool } from "./tools/notify-user.js";

const worker = new PilotSwarmWorker({
  store: process.env.DATABASE_URL,
  githubToken: process.env.GITHUB_TOKEN,
  pluginDirs: ["./travel-plugin"],
  blobConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
});

// Register tools at the worker level — available to all sessions
worker.registerTools([
  searchEventsTool,
  scanSocialFeedTool,
  checkLocalHappeningsTool,
  notifyUserTool,
]);

await worker.start();
console.log("Travel scanner worker running");

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Shutting down worker...");
  await worker.stop();
  process.exit(0);
});
```

Key points:

- **`pluginDirs`** tells the worker to load agents and skills from the `travel-plugin/` directory. It picks up `event-scanner.agent.md` automatically.
- **`blobConnectionString`** enables session dehydration. Without it, long waits would keep sessions pinned in memory.
- **`worker.registerTools()`** makes tools available to all sessions by name. The client references them with `toolNames: ["search_events", ...]` — a serializable array of strings that travels through the duroxide orchestration.
- Tools contain handler functions (non-serializable), so they live on the worker. The client never sees the handler code.

### Worker Configuration Options

The `PilotSwarmWorker` constructor accepts several configuration options beyond the basics shown above:

```javascript
const worker = new PilotSwarmWorker({
  // Required
  store: process.env.DATABASE_URL,
  githubToken: process.env.GITHUB_TOKEN,

  // Plugins — agents, skills, MCP servers loaded from these directories
  pluginDirs: ["./travel-plugin"],

  // Blob storage — required for session dehydration across workers
  blobConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
  blobContainer: "copilot-sessions",  // default

  // Model providers — path to model_providers.json (auto-discovered if omitted)
  modelProvidersPath: "./model_providers.json",

  // Performance tuning
  maxSessionsPerRuntime: 50,         // concurrent sessions per worker (default: 50)
  turnTimeoutMs: 120_000,            // LLM turn timeout (default: 2 minutes)
  sessionIdleTimeoutMs: 3_600_000,   // idle session cleanup (default: 1 hour)

  // Management agents — auto-started system agents for monitoring and maintenance
  disableManagementAgents: false,    // set true in test environments

  // Ops
  workerNodeId: process.env.POD_NAME, // identifies this worker in logs and CMS
  logLevel: "info",                   // "error" | "warn" | "info" | "debug"
});
```

For production deployments with multiple workers, each worker connects to the same database and blob storage. They don't need to know about each other — duroxide coordinates via the database queue. See [Deploying to AKS](deploying-to-aks.md) for the full Kubernetes setup.

## Running and Testing

### Start Everything

```bash
# Terminal 1: Start the worker
node --env-file=.env worker.js

# Terminal 2: Start the API server
node --env-file=.env server.js
```

Or use the combined script:

```bash
npm start
```

### Create a Trip

```bash
curl -X POST http://localhost:3000/trips \
  -H "Content-Type: application/json" \
  -d '{
    "destination": "Barcelona",
    "start_date": "2026-06-15",
    "end_date": "2026-06-22",
    "interests": "live music, street food, art galleries, pop-up markets"
  }'
```

Response:

```json
{
  "tripId": "a1b2c3d4-...",
  "sessionId": "e5f6g7h8-...",
  "status": "scanning",
  "message": "Event scanner started for Barcelona"
}
```

### Check Status

```bash
curl http://localhost:3000/trips/a1b2c3d4-...
```

```json
{
  "tripId": "a1b2c3d4-...",
  "destination": "Barcelona",
  "start_date": "2026-06-15",
  "end_date": "2026-06-22",
  "session": {
    "status": "waiting",
    "lastActivity": "2026-03-14T10:15:00Z",
    "turnCount": 3
  }
}
```

A status of `"waiting"` means the agent completed its scan, compiled a report, and is now dehydrated — sleeping on a durable timer until the next scan cycle.

### Update Preferences

```bash
curl -X POST http://localhost:3000/trips/a1b2c3d4-.../messages \
  -H "Content-Type: application/json" \
  -d '{
    "message": "I just found out I love flamenco. Add flamenco shows to your search."
  }'
```

This wakes the agent from its timer (if waiting), delivers the new message, and the agent adjusts its search criteria for all future scans.

### Stream Events

```bash
curl -N http://localhost:3000/trips/a1b2c3d4-.../events
```

```
data: {"type":"turn_start","data":{},"seq":12}

data: {"type":"tool_call","data":{"name":"search_events","args":{"location":"Barcelona","start_date":"2026-06-15","end_date":"2026-06-22","categories":"music,food,arts"}},"seq":13}

data: {"type":"message","data":{"content":"Found 3 new events since last scan..."},"seq":14}

data: {"type":"tool_call","data":{"name":"wait","args":{"seconds":3600,"reason":"Sleeping for 1 hour before next scan"}},"seq":15}
```

### Lifecycle Walkthrough

Here's what happens over the life of a trip:

1. **Minute 0** — `POST /trips` creates a session. The agent runs its first full scan across all sources, compiles a report, sends push notifications for highlights, then calls `wait(3600)`.
2. **Minute 0–60** — The session is dehydrated in blob storage. The worker is free to handle other sessions. The process could restart and nothing would be lost.
3. **Minute 60** — The durable timer fires. Duroxide picks an available worker. The session hydrates — conversation history is restored from blob. The agent wakes up and says "Time to scan again."
4. **Minute 60–61** — The agent scans all sources, diffs against its previous findings, reports only new events, then calls `wait(3600)` again.
5. **Repeat** — This cycle continues for days or weeks. The agent tracks what it's already reported in its conversation history, so it never sends duplicates.
6. **Trip end** — When the trip end date passes, the agent recognizes this and completes its session.

## Production Deployment

For production, separate the worker from the API server and scale them independently.

### Separate Processes

The Fastify server runs `PilotSwarmClient` only — lightweight, no GPU, scales horizontally behind a load balancer. The worker runs `PilotSwarmWorker` — heavier, handles LLM inference and tool execution. You can run multiple worker replicas; duroxide distributes sessions across them.

```bash
# API pods (lightweight, many replicas)
node --env-file=.env server.js

# Worker pods (heavier, fewer replicas)
node --env-file=.env worker.js
```

### Blob Storage

Session dehydration requires Azure Blob Storage. Set `AZURE_STORAGE_CONNECTION_STRING` in your environment. The worker serializes the full `CopilotSession` (conversation history, tool state) into a blob before long waits, and deserializes it when the timer fires. Without blob storage, sessions stay pinned in worker memory during waits — which defeats the purpose of durable timers.

### Kubernetes Scaling

Workers are stateless between turns. A session that dehydrated on Worker A can hydrate on Worker B. This means you can autoscale workers based on active session count:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: travel-scanner-worker
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: worker
          image: your-registry/travel-scanner-worker:latest
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: travel-scanner-secrets
                  key: database-url
            - name: GITHUB_TOKEN
              valueFrom:
                secretKeyRef:
                  name: travel-scanner-secrets
                  key: github-token
            - name: AZURE_STORAGE_CONNECTION_STRING
              valueFrom:
                secretKeyRef:
                  name: travel-scanner-secrets
                  key: blob-connection-string
          resources:
            requests:
              memory: "512Mi"
              cpu: "250m"
            limits:
              memory: "1Gi"
              cpu: "1000m"
```

## What's Next

This post covered the SDK fundamentals: client/worker separation, custom tools, durable timers, agent definitions, and a REST API layer. The travel scanner is a complete working example, but it's also a template. Any long-running monitoring agent — price trackers, job board scanners, competitor watchers — follows the same pattern:

1. Define tools for your data sources
2. Write an agent that scans and calls `wait()`
3. Serve it through a REST API with `PilotSwarmClient`
4. Let `PilotSwarmWorker` handle the rest

For the plugin directory structure and packaging conventions, see the [Plugin Architecture Guide](plugin-architecture-guide.md). For the first post in this series (building a test swarm with the CLI), see [Blog 1: Building a Test Swarm with the CLI](blog-test-swarm-cli.md).

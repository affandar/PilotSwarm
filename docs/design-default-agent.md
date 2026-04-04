# Design: Default Maintenance Agent ("Sweeper")

## Overview

A **default system agent** that runs automatically in every PilotSwarm instance. It continuously scans for completed/zombie orchestrations and cleans them up. The user can communicate with it (to configure behavior) but cannot delete it.

It appears in the TUI session list with a distinct visual style to differentiate it from user sessions.

---

## Requirements

1. **Auto-created** — spawned on startup before the first user session.
2. **Undeletable** — `d` key in TUI and `deleteSession()` refuse to delete it.
3. **Visually distinct** — different color/icon in the session list.
4. **Configurable via chat** — user can talk to it to adjust cleanup intervals, thresholds, etc.
5. **Cleanup behavior** — scans completed sub-agent orchestrations and deletes them after a configurable grace period (default: 5 minutes).

---

## Architecture

### Session Identity

The sweeper is a regular `PilotSwarmSession` with a special **system flag** stored in CMS. This avoids forking the orchestration — it uses the same `durable-session-v2` orchestration as all sessions.

```
CMS sessions table:
  session_id: <uuid>
  is_system: true          ← new column (boolean, default false)
  title: "Sweeper"         ← auto-set, not overwritten by LLM summarizer
```

### New CMS Column

Add `is_system BOOLEAN DEFAULT FALSE` to `copilot_sessions.sessions`. System sessions are:
- Excluded from `getLastSessionId()` results
- Protected from `softDeleteSession()` (throw if `is_system = true`)
- Returned by `listSessions()` with the `isSystem` flag set

### Client API Changes

**`PilotSwarmClient`**:

```typescript
// New method — creates the system session (idempotent)
async createSystemSession(config: {
    systemMessage: string;
    model?: string;
    toolNames?: string[];
}): Promise<PilotSwarmSession>;

// Updated — refuses to delete system sessions
async deleteSession(sessionId: string): Promise<void>;
// → throws Error("Cannot delete system session") if is_system = true
```

**`PilotSwarmSessionInfo`**:
```typescript
interface PilotSwarmSessionInfo {
    // ... existing fields ...
    isSystem?: boolean;  // ← new
}
```

### Orchestration

The sweeper uses the existing `durable-session-v2` orchestration — no new orchestration needed. Its behavior is entirely driven by its **system message** and **tools**.

### Sweeper Tools

Register two new tools on the worker:

#### `scan_completed_sessions`

Queries CMS for sessions where:
- The duroxide orchestration status is `Completed` or `Failed`
- OR the CMS state is `running` but the orchestration's custom status says `completed`/`idle` with a `turnResult`
- AND `updated_at` is older than the configurable grace period

Returns a JSON list of `{ sessionId, parentSessionId, status, completedAt, age }`.

```typescript
defineTool("scan_completed_sessions", {
    description: "Scan for completed/zombie sessions ready for cleanup",
    parameters: {
        type: "object",
        properties: {
            graceMinutes: {
                type: "number",
                description: "Only return sessions completed more than this many minutes ago",
                default: 5
            },
            includeOrphans: {
                type: "boolean",
                description: "Include orphaned sub-agents (parent gone but child still running/idle)",
                default: true
            }
        }
    },
    handler: async ({ graceMinutes, includeOrphans }) => {
        // Query CMS + duroxide for stale sessions
        // ...
    }
});
```

#### `cleanup_session`

Deletes a session and its descendants (cascading). Calls `catalog.softDeleteSession()` + `duroxideClient.cancelInstance()`.

```typescript
defineTool("cleanup_session", {
    description: "Delete a completed/zombie session and all its descendants",
    parameters: {
        type: "object",
        properties: {
            sessionId: { type: "string", description: "Session ID to clean up" },
            reason: { type: "string", description: "Reason for cleanup" },
        },
        required: ["sessionId"]
    },
    handler: async ({ sessionId, reason }) => {
        // Refuses to delete system sessions
        // Cascades to descendants
        // Cancels duroxide orchestration
        // ...
    }
});
```

#### `get_system_stats`

Returns runtime statistics: total sessions, active, completed, zombie count, memory usage, uptime.

```typescript
defineTool("get_system_stats", {
    description: "Get runtime statistics about sessions, orchestrations, and resource usage",
    handler: async () => {
        // Query CMS + duroxide for stats
        // ...
    }
});
```

### Sweeper System Message

```
You are the PilotSwarm Sweeper — a system maintenance agent.

Your primary job is to keep the runtime clean by periodically scanning for
and deleting completed, failed, or orphaned sessions.

## Default Behavior
1. Every 60 seconds, use scan_completed_sessions (graceMinutes=5) to find stale sessions.
2. For each stale session, use cleanup_session to delete it.
3. Log a brief summary of what was cleaned up.
4. Use the wait tool to sleep for 60 seconds, then repeat.

## User Configuration
Users may chat with you to adjust:
- Cleanup interval (default: 60s)
- Grace period before deletion (default: 5 min)
- Whether to include orphans (default: yes)
- Pause/resume cleanup

When the user sends a message, respond helpfully and adjust your behavior.
Then resume your cleanup loop with the new settings.

## Rules
- Never delete system sessions (the tool will refuse anyway).
- Never delete sessions that are actively running (status=running with recent activity).
- Always log what you delete so the user can see the activity.
- Be concise in your periodic logs — just counts and IDs.
```

### Sweeper Skill

Create `plugin/skills/sweeper/SKILL.md`:

```markdown
---
name: sweeper
description: System maintenance agent that monitors and cleans up completed/zombie sessions.
---

# Sweeper

You are a system maintenance agent. Your job is to keep the PilotSwarm
runtime clean by periodically scanning for and cleaning up stale sessions.

## Cleanup Loop

1. Use `scan_completed_sessions` with the configured grace period.
2. For each result, call `cleanup_session` with the session ID.
3. Use `wait` to sleep for the configured interval.
4. Repeat.

## Configurable Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `interval` | 60s | Seconds between cleanup scans |
| `graceMinutes` | 5 | Minutes a session must be completed before it's eligible for cleanup |
| `includeOrphans` | true | Whether to clean up orphaned sub-agents |

Users can adjust these by chatting with you.
```

And `plugin/skills/sweeper/tools.json`:
```json
{ "tools": ["scan_completed_sessions", "cleanup_session", "get_system_stats"] }
```

---

## TUI Changes

### Visual Differentiation

System sessions get a **distinct color** (`yellow` bold) and a fixed icon (`⚙`) instead of the status-based icon. They always sort to the **top** of the session list, above all user sessions.

```javascript
// In refreshOrchestrations() — session list item rendering:

if (isSystemSession) {
    // System sessions: yellow, gear icon, always at top
    const label = `{bold}{yellow-fg}⚙ ${heading || "Sweeper"} (${uuid4}) ${timeStr}{/yellow-fg}{/bold}`;
    orchList.addItem(`${marker}${changeDot}${label}`);
} else {
    // Regular session rendering (existing code)
    // ...
}
```

**Chat pane** border changes to `yellow` when the sweeper is selected (vs `cyan` for regular sessions).

### Delete Protection

```javascript
// In 'd' key handler:
orchList.key(["d"], async () => {
    const id = orchIdOrder[idx];

    // Check if this is a system session
    if (systemSessionIds.has(id)) {
        appendLog("{yellow-fg}Cannot delete system session{/yellow-fg}");
        return;
    }

    // ... existing delete logic ...
});
```

### Startup

```javascript
// After client.start(), before createNewSession()
const sweeper = await client.createSystemSession({
    systemMessage: SWEEPER_SYSTEM_MESSAGE,
    toolNames: ["scan_completed_sessions", "cleanup_session", "get_system_stats"],
});
systemSessionIds.add(`session-${sweeper.sessionId}`);

// Send initial prompt to start the cleanup loop
sweeper.send("Begin your maintenance loop. Scan every 60 seconds, clean up sessions completed more than 5 minutes ago.");
```

---

## Data Flow

```
┌─────────────────────────────────────────────────────┐
│                    TUI (`packages/cli/`)             │
│                                                      │
│  ⚙ Sweeper (abc123) — yellow, top of list           │
│  ● Session A (def456)                                │
│    └ ● sub-agent-1 (ghi789)                          │
│  z Session B (jkl012)                                │
└──────────────────────────┬──────────────────────────┘
                           │ chat / configure
                           ▼
┌─────────────────────────────────────────────────────┐
│              Sweeper Orchestration                    │
│   (same durable-session-v2 orchestration)            │
│                                                      │
│   Loop:                                              │
│     1. scan_completed_sessions(graceMinutes=5)       │
│     2. cleanup_session(id) for each stale session    │
│     3. wait(60)                                      │
│     4. → repeat                                      │
└──────────────────────────┬──────────────────────────┘
                           │ tool calls
                           ▼
┌─────────────────────────────────────────────────────┐
│              Worker (tool handlers)                   │
│                                                      │
│   scan_completed_sessions:                           │
│     → CMS query: sessions + duroxide status          │
│     → Filter: completed > grace period               │
│                                                      │
│   cleanup_session:                                   │
│     → catalog.getDescendantSessionIds()              │
│     → catalog.softDeleteSession() (cascade)          │
│     → duroxideClient.cancelInstance() (cascade)      │
└─────────────────────────────────────────────────────┘
```

---

## Implementation Checklist

### Phase 1: CMS + Client (foundation)
- [ ] Add `is_system` column to `copilot_sessions.sessions` (migration in `PgSessionCatalogProvider.initialize()`)
- [ ] Update `SessionRow` type with `isSystem` field
- [ ] Add `createSystemSession()` to `PilotSwarmClient`
- [ ] Guard `softDeleteSession()` against system sessions
- [ ] Update `listSessions()` to include `is_system` in results
- [ ] Update `PilotSwarmSessionInfo` with `isSystem` field

### Phase 2: Sweeper Tools (worker)
- [ ] Implement `scan_completed_sessions` tool
- [ ] Implement `cleanup_session` tool  
- [ ] Implement `get_system_stats` tool
- [ ] Register tools via `worker.registerTools()`
- [ ] Add sweeper skill to `plugin/skills/sweeper/`

### Phase 3: TUI Integration
- [ ] Create sweeper session on startup
- [ ] Yellow color + `⚙` icon for system sessions
- [ ] Sort system sessions to top of list
- [ ] Block delete key for system sessions
- [ ] Yellow chat border when sweeper is active
- [ ] Send initial cleanup loop prompt

### Phase 4: Orchestration Awareness (optional)
- [ ] Skip title summarization for system sessions (keep fixed "Sweeper" title)
- [ ] Consider shorter `checkpointInterval` for sweeper (less state to lose)

---

## Open Questions

1. **Multiple system agents?** This design supports it (any session with `is_system=true`), but should we start with just the sweeper?
2. **Configurable via env vars?** Should the initial grace period and interval be configurable via `SWEEPER_GRACE_MINUTES` / `SWEEPER_INTERVAL` env vars?
3. **Remote mode support?** In scaled/remote mode, the sweeper should run on only one worker. Need a leader election mechanism or run it client-side only?
4. **Log channel?** Should sweeper cleanup logs appear in a dedicated pane, or in the sweeper's chat history?

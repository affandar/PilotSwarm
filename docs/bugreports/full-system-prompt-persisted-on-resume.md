# Bug: Full Copilot system prompt is persisted to CMS on session resume/replay

**Status:** Open  
**Filed:** 2026-04-20  
**Component:** `@pilotswarm/sdk` session resume + CMS event persistence  
**Affected versions:** observed in PilotSwarm as vendored by a downstream app on 2026-04-20, after SDK orchestration updates through `e635145`  
**Severity:** High for storage / observability quality, Medium for runtime correctness — sessions continue to run, but CMS and UI accumulate huge duplicated system-message rows

## Symptom

After worker restart, dehydration/rehydration, or lossy fresh-session replay, the CMS session-events table stores a giant `system.message` row that begins with:

```text
You are the GitHub Copilot CLI, a terminal assistant built by GitHub. You are an interactive CLI tool that helps users with software engineering tasks.
```

This is not just a short resume notice. The stored row contains the full layered system prompt:

- GitHub Copilot CLI base prompt
- PilotSwarm framework prompt
- app default prompt (for a downstream app's `default.agent.md`)
- active agent prompt (for example a downstream named-agent prompt)
- runtime context sections

Concrete DB evidence from a live downstream remote deployment:

### Example A — downstream named-agent session

Session: `<session-a>`

```
seq 2467782  system.message  "The runtime is replaying this turn after a worker restart lost the live Copilot session state ..."
seq 2467790  system.message  "You are the GitHub Copilot CLI, a terminal assistant built by GitHub ..."
```

The full-prompt row at `seq=2467790` is **85,464 bytes**.

Inspection of that stored content confirms it includes:

```text
# App Default Instructions
...
# Example Named Agent
...
```

### Example B — PilotSwarm Agent system session

Session: `<session-b>`

The persisted full-prompt row is **62,178 bytes** and includes:

```text
# PilotSwarm Agent
You are a helpful assistant running in a durable execution environment. Be concise.
...
```

### Example C — ordinary session after rehydrate

Session: `<session-c>`

```
seq 2468729  system.message  "The session was dehydrated and has been rehydrated on a new worker ..."
seq 2468735  system.message  "You are the GitHub Copilot CLI, a terminal assistant built by GitHub ..."
```

## Why this is a bug

PilotSwarm's CMS `session_events` stream is supposed to hold user-visible operational history:

- user prompts
- assistant output
- tool activity
- explicit runtime notices such as rehydration, recovery, or child updates

Persisting the entire Copilot system prompt on every recreate/resume path is harmful:

1. **Storage bloat.** Tens of kilobytes per row, repeated many times per session.
2. **UI pollution.** Activity panes and event readers show giant internal prompt blobs instead of meaningful runtime events.
3. **Operator confusion.** It looks like the whole prompt is being "sent back" as a user-visible event on each resume.
4. **Information leakage into telemetry.** App-internal prompt content, environment context, tool descriptions, and orchestration instructions are copied into the CMS event log even though they were not authored as operational telemetry.
5. **Skewed metrics / history scans.** Any feature that pages `system.message` rows or counts event volume pays the cost of these giant duplicates.

Even if the Copilot SDK contract requires the worker to pass the full `systemMessage` again when reconstructing a session, that does **not** imply PilotSwarm should persist that text into CMS as a normal `system.message` event.

## What PilotSwarm passes today

There are two distinct layers:

### 1. Durable orchestration input stores only compact prompt metadata

`PilotSwarmClient` sends compact `OrchestrationInput.config` into `durable-session-v2` in [`packages/sdk/src/client.ts`](../../packages/sdk/src/client.ts):

- `model`
- `systemMessage` override if caller supplied one
- `workingDirectory`
- `waitThreshold`
- `boundAgentName`
- `promptLayering`
- `toolNames`

This is the lightweight durable representation.

### 2. SessionManager reconstructs the full Copilot SDK session config

Before talking to `@github/copilot-sdk`, `SessionManager` expands the compact config into a full `sessionConfig` in [`packages/sdk/src/session-manager.ts`](../../packages/sdk/src/session-manager.ts):

```ts
const sessionConfig: any = {
  sessionId,
  tools: allTools,
  model: sdkModelName,
  systemMessage: systemMessage
    ? (typeof systemMessage === "string" ? { content: systemMessage } : systemMessage)
    : undefined,
  configDir: path.dirname(this.sessionStateDir),
  workingDirectory: config.workingDirectory,
  hooks: config.hooks,
  onPermissionRequest: ...,
  infiniteSessions: { enabled: true },
  excludedTools: ["task"],
  ...resolvedProviderConfig,
  ...(this.workerDefaults.skillDirectories?.length && { skillDirectories: this.workerDefaults.skillDirectories }),
  ...(this.workerDefaults.customAgents?.length && { customAgents: this.workerDefaults.customAgents }),
  ...(this.workerDefaults.mcpServers && Object.keys(this.workerDefaults.mcpServers).length > 0 && { mcpServers: this.workerDefaults.mcpServers }),
};
```

That full `systemMessage` is built via [`packages/sdk/src/prompt-layering.ts`](../../packages/sdk/src/prompt-layering.ts) and [`packages/sdk/src/session-manager.ts`](../../packages/sdk/src/session-manager.ts), combining:

- framework base prompt
- app default prompt
- active agent prompt
- runtime context / last instructions

### 3. We pass that full config on both create and resume

`SessionManager` currently does:

```ts
copilotSession = await client.createSession(sessionConfig);
```

for fresh sessions, and:

```ts
copilotSession = await client.resumeSession(sessionId, sessionConfig);
```

for cold resume / rehydrate / recreate paths.

That means the full prompt is indeed passed to the Copilot SDK again on actual SDK resumption, not just on the first session start.

## Confirmed root cause inside PilotSwarm

The short runtime notices are explicitly persisted by PilotSwarm in [`packages/sdk/src/session-proxy.ts`](../../packages/sdk/src/session-proxy.ts):

- rehydration / replay / recovery notices
- internal orchestration wake-up notices
- turn-specific `turnSystemPrompt`

But the giant `You are the GitHub Copilot CLI ...` rows are **not** written by that small explicit notice path.

The likely root cause is:

1. PilotSwarm reconstructs and passes the full `systemMessage` on `createSession` / `resumeSession`.
2. The Copilot SDK emits a `system.message` event containing that full system prompt during session creation or reconstruction.
3. PilotSwarm's generic event capture path persists emitted events to CMS without filtering:

```ts
catalog.recordEvents(input.sessionId, [event], workerNodeId)
```

in [`packages/sdk/src/session-proxy.ts`](../../packages/sdk/src/session-proxy.ts).

So the bug is not simply "we pass systemMessage on resume." The bug is that the resulting full prompt re-emission is being stored as ordinary operational telemetry.

## Evidence from representative sessions

Query used in a downstream remote deployment:

```sql
SELECT session_id,
       count(*) FILTER (
         WHERE event_type='system.message'
           AND data->>'content' ILIKE 'You are the GitHub Copilot CLI,%'
       ) AS full_prompt_rows,
       count(*) FILTER (
         WHERE event_type='system.message'
           AND data->>'content' ILIKE 'The session was dehydrated and has been rehydrated on a new worker%'
       ) AS rehydrated_rows,
       count(*) FILTER (
         WHERE event_type='system.message'
           AND data->>'content' ILIKE 'The runtime is replaying this turn after a worker restart lost the live Copilot session state%'
       ) AS lossy_replay_rows
FROM <cms_schema>.session_events
WHERE session_id IN (
  '<session-a>',
  '<session-b>',
  '<session-c>'
)
GROUP BY session_id
ORDER BY session_id;
```

Observed result:

| Session | full_prompt_rows | rehydrated_rows | lossy_replay_rows |
|---|---:|---:|---:|
| `<session-c>` | 190 | 157 | 0 |
| `<session-b>` | 260 | 204 | 0 |
| `<session-a>` | 1 | 8 | 1665 |

This is enough to confirm the persistence is real, repeated, and not a one-off anomaly.

## What is *not* happening

Warm in-memory turns do **not** reconstruct the whole session prompt. Once a live `CopilotSession` already exists on the same worker, `ManagedSession.runTurn()` just calls:

```ts
await this.copilotSession.send({ prompt: effectivePrompt, ... })
```

in [`packages/sdk/src/managed-session.ts`](../../packages/sdk/src/managed-session.ts).

So this bug is specific to actual create/recreate/resume paths, not every ordinary turn.

## Proposed fix

### Primary fix: filter giant full-system-prompt events before persisting to CMS

In the generic event persistence path in [`packages/sdk/src/session-proxy.ts`](../../packages/sdk/src/session-proxy.ts), drop SDK-emitted `system.message` rows that are clearly the full Copilot base prompt / reconstructed session prompt.

Pragmatic filter options:

1. If `event.eventType === "system.message"` and content starts with:
   - `You are the GitHub Copilot CLI, a terminal assistant built by GitHub.`
2. Or if content exceeds a large threshold and contains obvious framework headers such as:
   - `# Tone and style`
   - `# Search and delegation`
   - `# Tool usage efficiency`

That content should not be written to `session_events`.

### Keep these system messages

Do **not** filter the short runtime notices that are genuinely useful operational telemetry:

- `The session was dehydrated and has been rehydrated on a new worker ...`
- `The runtime is replaying this turn after a worker restart lost the live Copilot session state ...`
- `The runtime recovered this session after the live Copilot session was lost ...`
- internal child-update wake-ups and similar concise orchestration notices

### Secondary investigation

Determine exactly which Copilot SDK event is re-emitting the full prompt on create/resume and whether the SDK offers a narrower event surface or flag that excludes system-prompt echoing from the runtime event stream.

### Optional future optimization

If the Copilot SDK does **not** actually need the fully materialized system prompt text on `resumeSession`, and can recover it from durable session state safely, we may be able to trim the resume-time config further. That is a separate optimization question and should not block the CMS filtering fix.

## Verification

After the fix:

1. Rehydrate or replay several sessions across worker restarts.
2. Confirm `session_events` still records the short rehydration / recovery notices.
3. Confirm no new rows begin with `You are the GitHub Copilot CLI, ...`.
4. Confirm Activity / event readers are readable again and event volume drops materially.
5. Confirm session correctness is unchanged — the Copilot SDK still resumes successfully.

## Related

- [`runTurn-session-not-found-infinite-retry.md`](./runTurn-session-not-found-infinite-retry.md)
- [`wait-boundary-leakage-before-resume.md`](./wait-boundary-leakage-before-resume.md)

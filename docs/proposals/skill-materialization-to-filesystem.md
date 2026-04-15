# Skill Materialization to Filesystem

## Summary

Extend the shared skills pipeline so that curated skills are stored as literal SKILL.md file content in the facts table, then materialized to the plugin filesystem by the `runTurn` activity. This aligns learned skills with the Copilot SDK's native skill format, giving them identical treatment to hand-authored skills: YAML frontmatter indexing, lazy `read_file` retrieval, and the standard `<skill>` XML prompt injection. The same materialized path also lets PilotSwarm capture exact learned-skill consumption stats in the per-session and fleet aggregate surfaces added by the Session Stats Management API work.

## Motivation

The current shared skills pipeline stores curated skills as JSON objects in the facts table and injects them via a custom `[CURATED SKILLS]` prompt block. This works but has several drawbacks:

1. **Different retrieval path.** File-based skills use `read_file` (a primitive the model is heavily trained on). Facts-based skills use `read_facts` (a custom tool with less model familiarity).
2. **Different prompt shape.** File skills appear in a `<skill>` XML block that the Copilot SDK natively understands. Facts skills appear in a plain-text `[CURATED SKILLS]` block.
3. **No portability.** Facts-based skills only work inside PilotSwarm sessions. File-based skills work everywhere — VS Code, CLI, remote workers.
4. **Redundant code.** `knowledge-index.ts` duplicates what the SDK's skill loader already does.

Storing the full SKILL.md content inside the fact and materializing it to disk solves all four problems.

## Design

### Fact Value: Literal SKILL.md Content

The Facts Manager writes each curated skill as a fact whose `value` is a JSON object with two top-level fields:

```jsonc
{
  // The complete SKILL.md file content, ready to write to disk verbatim.
  "skillmd": "---\nname: Use service-principal federated-token login when az --identity fails\ndescription: In pods with multiple user-assigned managed identities, az login --identity may fail. Use federated-token login instead.\ntools: az\n---\n\n## Problem\n\nWhen a pod has multiple user-assigned managed identities...\n\n## Instructions\n\n1. Read `$AZURE_FEDERATED_TOKEN_FILE`\n2. Run `az login --service-principal ...`\n...",

  // Curation metadata (not part of the SKILL.md file, used by the Facts Manager only).
  "meta": {
    "confidence": "medium",
    "version": 2,
    "evidence_count": 3,
    "contradiction_count": 0,
    "linked_ask": "asks/azure/identity-login",
    "linked_intakes": ["intake/azure-identity-login/session-abc123"],
    "created": "2026-04-14T22:46:56Z",
    "last_reviewed": "2026-04-15T05:50:35Z",
    "last_corroborated": "2026-04-14T22:46:56Z",
    "expires_at": "2026-05-14T22:46:56Z"
  }
}
```

### SKILL.md Format

The `skillmd` field contains a complete SKILL.md file with standard YAML frontmatter:

```markdown
---
name: Use service-principal federated-token login when az --identity fails
description: >-
  In pods with multiple user-assigned managed identities, az login --identity
  may fail to resolve the intended identity. Use federated-token login instead.
tools: az, kubectl
confidence: medium
evidence_count: 3
expires_at: 2026-05-14T22:46:56Z
---

## Problem

When a pod has multiple user-assigned managed identities, `az login --identity`
may fail with "Identity not found" even with `--client-id`.

## Instructions

1. Read the federated token from `$AZURE_FEDERATED_TOKEN_FILE`
2. Log in as a service principal:
   ```
   az login --service-principal \
     --username "$AZURE_CLIENT_ID" \
     --tenant "$AZURE_TENANT_ID" \
     --federated-token "$(cat "$AZURE_FEDERATED_TOKEN_FILE")"
   ```
3. Verify with `az account show`

## Caveats

- Only works in pods with workload identity enabled.
- Cached credentials from earlier `az login --identity` calls can mask the issue.
```

The frontmatter includes `confidence`, `evidence_count`, and `expires_at` so that agents can assess skill reliability without needing a separate metadata lookup. The `tools` field is a comma-separated string (the existing YAML frontmatter parser handles simple `key: value` pairs only).

### Global Skills Version Counter

The Facts Manager maintains a global version counter:

```
key:   skills/_version
value: { "version": 17, "updated_at": "2026-04-15T06:00:00Z" }
scope: shared
```

Every time the Facts Manager creates, updates, or deletes a curated skill, it increments this counter. The version is a monotonic integer — no ordering ambiguity.

### Orchestration: Pass Version to runTurn

Before each `runTurn` call, the orchestration reads the current skills version from the KV store (fast, no DB round-trip if cached by duroxide):

```typescript
// In orchestration generator, before runTurn
const skillsVersion: number = yield manager.getSkillsVersion();
turnResult = yield session.runTurn(prompt, promptIsBootstrap, iteration, {
    skillsVersion,
    // ...existing options
});
```

The `getSkillsVersion` activity reads the `skills/_version` fact and returns the integer. If the fact does not exist, returns `0`.

### runTurn Activity: Sync Skills to Disk

The `runTurn` activity (in `session-proxy.ts`) receives `skillsVersion` in its input. Before calling `ManagedSession.runTurn`, it checks whether the local skill files are current:

```typescript
// In the runTurn activity handler
const { skillsVersion } = input;
const learnedSkillsDir = path.join(pluginDir, "skills", "learned");
const versionFile = path.join(learnedSkillsDir, ".version");

const localVersion = readLocalVersion(versionFile); // returns 0 if missing

if (skillsVersion > localVersion) {
    await syncLearnedSkills(factStore, learnedSkillsDir, versionFile, skillsVersion);
}
```

The `syncLearnedSkills` function:

1. Reads all `skills/*` facts (excluding `skills/_version`) from the fact store.
2. For each fact:
   - Derives a directory name from the fact key: `skills/azure/identity-login` → `learned/azure--identity-login/`
   - Writes the `skillmd` field verbatim to `SKILL.md` in that directory.
   - Skips facts where `meta.status === "aged-out"`.
3. Deletes any `learned/*/SKILL.md` directories that no longer have a corresponding fact.
4. Writes `skillsVersion` to `.version`.

After sync, the session is created/resumed with `skillDirectories` pointing at the plugin skills dir (which now includes `learned/`). The Copilot SDK reads the directories fresh on create/resume, so the new skills take effect immediately.

### Directory Layout

```
plugin/
  skills/
    hammerdb-runner/          # Hand-authored skill (checked in)
      SKILL.md
    azure-deployment/         # Hand-authored skill (checked in)
      SKILL.md
    learned/                  # Materialized from facts table (gitignored, ephemeral)
      .version                # Contains current skillsVersion integer
      azure--identity-federated-token-login/
        SKILL.md
      kubernetes--work-pod-state-source-of-truth/
        SKILL.md
      hammerdb--tpcc-allwarehouse-requirement/
        SKILL.md
      ...
```

The `learned/` directory is:
- **Gitignored** — not checked in; it is runtime state.
- **Ephemeral** — recreated on each worker pod startup if missing.
- **Per-worker** — each worker materializes independently. No shared filesystem needed.

### Facts Manager: Writing SKILL.md Content

The Facts Manager's skill promotion logic changes from writing a flat JSON object to writing the `{ skillmd, meta }` structure. Its prompt instructs it to produce the SKILL.md content with proper YAML frontmatter.

Example prompt guidance for the Facts Manager:

```
When promoting an intake observation to a curated skill, write the fact value as:

{
  "skillmd": "<full SKILL.md content with YAML frontmatter and markdown body>",
  "meta": { <curation metadata> }
}

The skillmd field must be a complete, valid SKILL.md file:
- Start with `---` YAML frontmatter containing: name, description, tools, confidence, evidence_count, expires_at
- Follow with a markdown body containing: ## Problem, ## Instructions, ## Caveats sections
- The description must be a single sentence or short paragraph
- The instructions must be actionable — specific commands, patterns, or decision rules
- Include caveats for known limitations or untested conditions

The meta field contains curation metadata not visible to consuming agents.
```

### Removing the Custom Knowledge Block

Once skills are materialized to disk, the `[CURATED SKILLS]` prompt block becomes redundant. The Copilot SDK's native skill loader handles indexing and lazy retrieval.

Migration path:
1. **Phase 1**: Materialize skills to disk AND keep the `[CURATED SKILLS]` block (belt and suspenders).
2. **Phase 2**: Remove `buildKnowledgePromptBlocks`, `loadKnowledgeIndexFromFactStore`, and the `tool_instructions` section override for skills. Keep the ask block — asks have no filesystem equivalent.
3. **Phase 3**: Clean up `knowledge-index.ts` to only handle asks.

### Handling Asks

Active asks (`asks/*`) remain in the prompt-injected block since they are ephemeral requests, not persistent skills. They continue to use the `[ACTIVE FACT REQUESTS]` text block. This is a small, bounded set that benefits from eager injection rather than lazy file reading.

## Implementation

### New Activity: `getSkillsVersion`

```typescript
// session-proxy.ts
runtime.registerActivity("getSkillsVersion", async () => {
    const result = await factStore.readFacts(
        { keyPattern: "skills/_version", scope: "shared", limit: 1 },
        { readerSessionId: null, grantedSessionIds: [] },
    );
    if (result?.facts?.length) {
        const val = typeof result.facts[0].value === "string"
            ? JSON.parse(result.facts[0].value)
            : result.facts[0].value;
        return val?.version ?? 0;
    }
    return 0;
});
```

### Sync Function: `syncLearnedSkills`

```typescript
// New file: skill-sync.ts
import fs from "node:fs";
import path from "node:path";
import type { FactStore } from "./facts-store.js";

export async function syncLearnedSkills(
    factStore: FactStore,
    learnedDir: string,
    versionFile: string,
    targetVersion: number,
): Promise<void> {
    // Read all curated skills from the fact store
    const result = await factStore.readFacts(
        { keyPattern: "skills/%", scope: "shared", limit: 200 },
        { readerSessionId: null, grantedSessionIds: [] },
    );

    const activeKeys = new Set<string>();

    for (const row of result?.facts ?? []) {
        if (row.key === "skills/_version") continue;

        const val = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
        if (val?.meta?.status === "aged-out") continue;
        if (!val?.skillmd) continue;

        // Derive directory name: skills/azure/identity-login → azure--identity-login
        const dirName = row.key
            .replace(/^skills\//, "")
            .replace(/\//g, "--");

        activeKeys.add(dirName);

        const skillDir = path.join(learnedDir, dirName);
        const skillMdPath = path.join(skillDir, "SKILL.md");

        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(skillMdPath, val.skillmd, "utf-8");
    }

    // Remove directories that no longer have a corresponding fact
    if (fs.existsSync(learnedDir)) {
        for (const entry of fs.readdirSync(learnedDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            if (!activeKeys.has(entry.name)) {
                fs.rmSync(path.join(learnedDir, entry.name), { recursive: true, force: true });
            }
        }
    }

    // Write version marker
    fs.writeFileSync(versionFile, String(targetVersion), "utf-8");
}

export function readLocalVersion(versionFile: string): number {
    try {
        return parseInt(fs.readFileSync(versionFile, "utf-8").trim(), 10) || 0;
    } catch {
        return 0;
    }
}
```

### Orchestration Change

```typescript
// Before runTurn, after loadKnowledgeIndex (which now only handles asks)
if (config.agentIdentity !== "facts-manager") {
    try {
        const skillsVersion: number = yield manager.getSkillsVersion();
        turnOptions.skillsVersion = skillsVersion;
    } catch (err: any) {
        ctx.traceInfo(`[orch] getSkillsVersion failed (non-fatal): ${err.message}`);
    }
}
```

### runTurn Activity Change

```typescript
// At the top of the runTurn activity, before session create/resume
const { skillsVersion } = input;
if (skillsVersion != null && skillsVersion > 0) {
    const learnedDir = path.join(pluginDir, "skills", "learned");
    const versionFile = path.join(learnedDir, ".version");
    const localVersion = readLocalVersion(versionFile);
    if (skillsVersion > localVersion) {
        await syncLearnedSkills(factStore, learnedDir, versionFile, skillsVersion);
    }
}
```

### Facts Manager Prompt Update

Add to the Facts Manager agent prompt:

```
When you promote an observation to a curated skill, the fact value must contain:

1. A "skillmd" field: the complete SKILL.md file content with YAML frontmatter.
2. A "meta" field: curation metadata for your internal bookkeeping.

The SKILL.md format:

    ---
    name: <short imperative name>
    description: <one-sentence description of when and why to apply this skill>
    tools: <comma-separated tool names, or empty>
    confidence: <low|medium|high>
    evidence_count: <number>
    expires_at: <ISO 8601 timestamp>
    ---

    ## Problem

    <What goes wrong and under what conditions>

    ## Instructions

    <Step-by-step actionable guidance>

    ## Caveats

    <Known limitations, untested conditions, or edge cases>

After writing or updating any skill fact, always increment the global version:

    store_fact(key="skills/_version", value={"version": <previous + 1>, "updated_at": "<now>"}, shared=true)
```

## Migration

### From JSON Skills to SKILL.md Skills

Existing JSON-format skills in the facts table need a one-time migration. The Facts Manager can do this itself: on its next cycle after deployment, if it reads a skill fact whose `value` has no `skillmd` field, it rewrites the fact in the new format by generating the SKILL.md content from the existing `name`, `description`, `instructions`, and `tools` fields.

### Backward Compatibility

During the migration window:
- The `[CURATED SKILLS]` prompt block continues to work (reads `name` and `description` from either format).
- The materializer checks for `skillmd` and skips facts without it.
- Once all skills are migrated, the `[CURATED SKILLS]` block can be removed (Phase 2).

## Implementation Phases

| Phase | Scope | Files Changed |
|-------|-------|---------------|
| 1 | `syncLearnedSkills` + `readLocalVersion` utility | New `skill-sync.ts` |
| 2 | `getSkillsVersion` activity | `session-proxy.ts` |
| 3 | `runTurn` activity: sync before session create/resume | `session-proxy.ts` |
| 4 | Orchestration: read version, pass to runTurn | `orchestration.ts` (new version) |
| 5 | Facts Manager prompt: produce `{ skillmd, meta }` format | `facts-manager.agent.md` |
| 6 | Facts Manager prompt: increment `skills/_version` on mutation | `facts-manager.agent.md` |
| 7 | Migration logic: rewrite existing JSON skills | `facts-manager.agent.md` (prompt instruction) |
| 8 | Remove `[CURATED SKILLS]` block, simplify `knowledge-index.ts` | `knowledge-index.ts`, `session-manager.ts` |
| 9 | Learned-skill consumption stats: wire `skill.invoked`, CMS summary table, session/fleet aggregate reads | `session-proxy.ts`, `cms.ts`, `management-client.ts` |
| 10 | Tests | New `skill-materialization.test.js`, extend `session-stats.test.js` |

## Learned Skill Consumption Stats

### Motivation

Curated skills are only valuable if agents actually consume them. Today there is no exact operator-facing answer to:

- Which learned skills did this session actually use?
- How many times did it use each learned skill?
- Across the whole fleet, which learned skills are seeing real reuse?

The Copilot SDK already emits a `skill.invoked` event when a skill is read into the conversation context. Materializing learned skills onto disk gives us a stable filesystem path (`plugin/skills/learned/...`) that lets us distinguish learned skills from hand-authored skills and summarize only the learned ones in management stats.

Tracking learned skill consumption enables:
- **Session review**: Operators can inspect a session's stats and see which learned skills shaped behavior.
- **Fleet prioritization**: Frequently consumed learned skills are the ones worth curating carefully, exporting, and preserving.
- **Decay input**: The Facts Manager can use real consumption as another signal when deciding whether a learned skill is stale.

### Design Goals

1. Only learned skills appear in the new stats surfaces. Hand-authored file skills remain visible in raw session events if needed, but they do not clutter learned-skill reuse reports.
2. Reuse the exact per-session and fleet aggregate surfaces introduced by `session-stats-management-api.md` instead of creating a parallel management API.
3. Store summary rows, not per-invocation append-only rows, for operator views.
4. Keep session-level counts exact and fleet aggregates cheap to query.

### The `skill.invoked` Event

The Copilot SDK emits this event when the model decides a skill is relevant and its SKILL.md content is injected into the conversation:

```typescript
{
    type: "skill.invoked",
    data: {
        name: string,        // Skill name from frontmatter
        path: string,        // Filesystem path to the SKILL.md
        content: string,     // Full SKILL.md content injected
        allowedTools?: string[],  // Auto-approved tools for this skill
    }
}
```

### Wiring the Event

`session-proxy.ts` already records non-ephemeral SDK events into CMS and updates token summary fields from `assistant.usage`. Extend that same `onEvent` path to recognize learned skills:

```typescript
if (event.eventType === "skill.invoked") {
    const skillKey = learnedSkillPathToFactKey(event.data?.path);
    if (skillKey) {
        await catalog.upsertSessionLearnedSkillSummary(input.sessionId, {
            skillKey,
            skillName: String(event.data?.name || ""),
            invocationCountIncrement: 1,
        });
    }
}
```

`learnedSkillPathToFactKey()` returns `null` for anything outside `plugin/skills/learned/`, so static skills are ignored for stats purposes.

Examples:
- `.../plugin/skills/learned/azure--identity-login/SKILL.md` -> `skills/azure/identity-login`
- `.../plugin/skills/learned/kubernetes--ingress-timeout/SKILL.md` -> `skills/kubernetes/ingress-timeout`

The raw `skill.invoked` event still lands in `session_events`, so detailed event-level audit remains available without needing a second append-only invocation log.

### CMS Storage: `session_learned_skill_summaries`

Add a second summary table to the CMS schema, keyed by `(session_id, skill_key)`:

```sql
CREATE TABLE IF NOT EXISTS {schema}.session_learned_skill_summaries (
    session_id          TEXT NOT NULL,
    skill_key           TEXT NOT NULL,     -- e.g. "skills/azure/identity-login"
    skill_name          TEXT NOT NULL,

    -- Denormalized from the session at first insert so fleet queries stay cheap
    agent_id            TEXT,
    model               TEXT,
    parent_session_id   TEXT,
    session_created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ,

    -- Aggregate counters for this session + learned skill pair
    invocation_count    INTEGER NOT NULL DEFAULT 0,
    first_invoked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_invoked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (session_id, skill_key)
);

CREATE INDEX IF NOT EXISTS idx_{schema}_slss_skill
    ON {schema}.session_learned_skill_summaries(skill_key);
CREATE INDEX IF NOT EXISTS idx_{schema}_slss_created
    ON {schema}.session_learned_skill_summaries(session_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_{schema}_slss_agent_model
    ON {schema}.session_learned_skill_summaries(agent_id, model);
```

This follows the same philosophy as `session_metric_summaries`:
- one summary row per entity we want to query cheaply
- atomic upserts, never append-only write amplification
- denormalized session metadata so fleet reads stay simple

Row lifecycle:

- `createSession()` does nothing here; rows are created lazily on first learned skill use.
- `upsertSessionLearnedSkillSummary()` inserts the row on first use, then increments `invocation_count` and updates `last_invoked_at`.
- `softDeleteSession()` mirrors `deleted_at` onto these rows, just like `session_metric_summaries`.
- Summary pruning should delete these rows alongside `session_metric_summaries` rows for sessions older than the prune cutoff.

### CMS Types and Read Surface

Extend the management stats types with learned-skill summaries:

```typescript
interface LearnedSkillUsage {
    skillKey: string;
    skillName: string;
    invocationCount: number;
    firstInvokedAt: number | null;
    lastInvokedAt: number | null;
}

interface LearnedSkillAggregate extends LearnedSkillUsage {
    sessionCount: number;
}

interface SessionMetricSummary {
    // ...existing fields...
    learnedSkills: LearnedSkillUsage[];
}

interface SessionTreeStats {
    rootSessionId: string;
    self: SessionMetricSummary;
    tree: {
        // ...existing totals...
        learnedSkills: LearnedSkillAggregate[];
    };
}

interface FleetStats {
    // ...existing fields...
    learnedSkills: LearnedSkillAggregate[];
}
```

No new top-level management endpoint is required. The existing stats calls become the source of truth:

- `getSessionMetricSummary(sessionId)` returns the session's learned skill counts.
- `getSessionTreeStats(sessionId)` returns both the session's own learned skill counts (`self.learnedSkills`) and the rolled-up aggregate across descendants (`tree.learnedSkills`).
- `getFleetStats()` returns fleet-wide learned skill aggregates filtered by the same `includeDeleted` / `since` options as the rest of fleet stats.

Example fleet aggregate shape:

```typescript
{
  learnedSkills: [
    {
      skillKey: "skills/azure/identity-login",
      skillName: "Use service-principal federated-token login when az --identity fails",
      invocationCount: 67,
      sessionCount: 19,
      firstInvokedAt: 1776186000000,
      lastInvokedAt: 1776221400000
    }
  ]
}
```

### CMS Methods

Add a dedicated upsert helper in `cms.ts`:

```typescript
async upsertSessionLearnedSkillSummary(
    sessionId: string,
    usage: {
        skillKey: string;
        skillName: string;
        invocationCountIncrement: number;
    },
): Promise<void> {
    await this.pool.query(
        `INSERT INTO ${this.sql.learnedSkillSummaryTable}
         (session_id, skill_key, skill_name, agent_id, model, parent_session_id, session_created_at,
          invocation_count, first_invoked_at, last_invoked_at)
         SELECT
             $1,
             $2,
             $3,
             s.agent_id,
             s.model,
             s.parent_session_id,
             s.created_at,
             $4,
             now(),
             now()
         FROM ${this.sql.table} s
         WHERE s.session_id = $1
         ON CONFLICT (session_id, skill_key) DO UPDATE SET
             skill_name = EXCLUDED.skill_name,
             invocation_count = ${this.sql.learnedSkillSummaryTable}.invocation_count + $4,
             last_invoked_at = now()`,
        [sessionId, usage.skillKey, usage.skillName, usage.invocationCountIncrement],
    );
}
```

`getSessionMetricSummary()`, `getSessionTreeStats()`, and `getFleetStats()` then issue an additional grouped read against `session_learned_skill_summaries` and attach the resulting `learnedSkills` arrays to their returned objects.

### Facts Manager Tool: `read_skill_stats`

Expose a lightweight aggregate tool to the Facts Manager so it can inspect learned-skill reuse during curation:

```typescript
const readSkillStats = defineTool("read_skill_stats", {
    description:
        "Read aggregate consumption stats for a learned skill. " +
        "Returns lifetime invocation count, number of sessions that consumed it, " +
        "and first/last invocation times.",
    parameters: {
        type: "object",
        properties: {
            skill_key: {
                type: "string",
                description: 'The learned skill fact key, e.g. "skills/azure/identity-login"',
            },
        },
        required: ["skill_key"],
    },
    handler: async ({ skill_key }) => {
        return await cms.getLearnedSkillFleetAggregate(skill_key);
    },
});
```

This tool reads from the same summary table that powers session and fleet stats, so there is a single source of truth for learned-skill consumption.

### Learned Skill Stats in Skill Metadata

The Facts Manager can optionally snapshot consumption data into the skill's `meta` block during its curation cycle:

```jsonc
{
  "skillmd": "...",
  "meta": {
    "confidence": "high",
    "evidence_count": 4,
    "consumption_stats": {
      "total": 67,
      "unique_sessions": 19,
      "first_invoked": "2026-04-13T05:30:00Z",
      "last_invoked": "2026-04-15T05:30:00Z"
    },
    // ...
  }
}
```

This makes learned-skill reuse visible alongside the skill without requiring a separate tool call, and it persists into skill exports for cross-deployment portability.

### Decay Signal

The Facts Manager's expiry logic (from the shared-skills-pipeline proposal) gains a new input: consumption. A learned skill that is still being consumed across many sessions should not age out as aggressively as one that nobody is using.

Suggested heuristic (configurable via `config/facts-manager/invocation-decay-rules`):
- `total = 0` after one full TTL window -> eligible for accelerated decay
- `unique_sessions >= 5` or `last_invoked` within the last 7 days -> skip one decay step
- Standard decay rules apply otherwise

If exact rolling-window invocation totals ever become important, add bucketed history as a follow-on. The session/fleet stats integration proposed here is intentionally summary-oriented and optimized for exact current-state reads.

## Test Plan

### Suite 1: Materialization Utilities

**Test 1: `readLocalVersion()` returns 0 when `.version` is missing**

- Create an empty `plugin/skills/learned/` directory.
- Call `readLocalVersion(versionFile)`.
- Verify the result is `0`.

**Test 2: `syncLearnedSkills()` writes learned skill directories from facts**

- Seed the fact store with:
  - `skills/_version`
  - one active skill fact containing `{ skillmd, meta }`
- Run `syncLearnedSkills(...)`.
- Verify:
  - a directory is created under `plugin/skills/learned/<topic>--<subtopic>/`
  - `SKILL.md` exists
  - file contents exactly match `skillmd`
  - `.version` contains the target version

**Test 3: `syncLearnedSkills()` skips aged-out skills**

- Seed one active learned skill and one skill with `meta.status = "aged-out"`.
- Run sync.
- Verify only the active skill is materialized.

**Test 4: `syncLearnedSkills()` ignores malformed or legacy rows without `skillmd`**

- Seed one old JSON-format skill and one valid `{ skillmd, meta }` skill.
- Run sync.
- Verify the valid skill is written and the legacy row is skipped without crashing.

**Test 5: `syncLearnedSkills()` removes stale local skill directories**

- Pre-create two local learned skill directories.
- Seed facts for only one of them.
- Run sync.
- Verify the extra local directory is removed.

### Suite 2: Versioning and Migration

**Test 6: `getSkillsVersion()` returns 0 when `skills/_version` does not exist**

- Start with an empty facts table.
- Call the activity.
- Verify it returns `0`.

**Test 7: `getSkillsVersion()` returns the shared version integer**

- Write `skills/_version = { "version": 17, ... }`.
- Call the activity.
- Verify it returns `17`.

**Test 8: Legacy JSON skill can be rewritten to `{ skillmd, meta }` by the Facts Manager**

- Seed a legacy learned skill row with `name`, `description`, `instructions`, and `tools`.
- Simulate the Facts Manager migration step.
- Verify the rewritten fact contains:
  - `skillmd`
  - `meta`
  - the original guidance rendered into the SKILL.md body
- Verify `skills/_version` is incremented.

### Suite 3: Runtime Integration

**Test 9: Worker syncs learned skills before `runTurn` and the agent can consume them**

- Seed a learned skill fact with distinctive content.
- Start a worker/client pair.
- Run a session whose prompt should trigger that skill.
- Verify:
  - the learned skill is materialized locally before the turn
  - the response reflects the learned skill guidance

**Test 10: Updated learned skill takes effect after a version bump without worker restart**

- Seed v1 of a learned skill and run a turn that uses it.
- Update the fact with changed `skillmd` and increment `skills/_version`.
- Run another turn in the same deployment.
- Verify the second turn reflects the updated skill content.

**Test 11: Active asks still inject while learned skills come from the filesystem**

- Seed one learned skill and one open ask.
- Run a turn.
- Verify:
  - the skill is available via native skill loading
  - the ask still appears in the prompt-injected ask block

**Test 12: Multi-worker deployment converges on the same learned skill set**

- Start two workers against the same store.
- Seed a learned skill and increment `skills/_version`.
- Trigger a turn on both workers.
- Verify both materialize the same `SKILL.md` contents independently.

### Suite 4: Learned Skill Stats Persistence

**Test 13: `skill.invoked` for a learned skill increments the session learned-skill summary**

- Emit or trigger a `skill.invoked` event whose `path` points under `plugin/skills/learned/...`.
- Verify a `session_learned_skill_summaries` row is created with:
  - correct `session_id`
  - correct `skill_key`
  - `invocation_count = 1`
  - `first_invoked_at` and `last_invoked_at` set

**Test 14: Static skills are ignored by learned-skill stats**

- Emit or trigger a `skill.invoked` event for a non-learned skill path.
- Verify no learned-skill summary row is created.

**Test 15: Repeated learned-skill use in one session increments rather than duplicating rows**

- Trigger the same learned skill multiple times in one session.
- Verify a single `(session_id, skill_key)` row exists and `invocation_count` equals the number of invocations.

**Test 16: Session soft-delete mirrors `deleted_at` to learned-skill summary rows**

- Create a session with learned-skill usage.
- Soft-delete the session.
- Verify the learned-skill summary row remains and has `deleted_at` set.

**Test 17: Prune removes learned-skill summary rows for deleted sessions past cutoff**

- Create and soft-delete a session with learned-skill usage.
- Set `deleted_at` older than the prune cutoff.
- Run summary pruning.
- Verify the learned-skill summary row is deleted alongside the session metric summary row.

### Suite 5: Session and Fleet Stats Reads

**Test 18: `getSessionMetricSummary()` includes learned skill usage**

- Create a session that consumes two learned skills.
- Call `getSessionMetricSummary(sessionId)`.
- Verify `learnedSkills` contains only learned skills with correct counts and timestamps.

**Test 19: `getSessionTreeStats()` rolls learned skill counts up across descendants**

- Create parent + child sessions that consume different learned skills.
- Call `getSessionTreeStats(parentId)`.
- Verify:
  - `self.learnedSkills` reflects only the parent's own usage
  - `tree.learnedSkills` includes parent + child aggregates

**Test 20: `getFleetStats()` aggregates learned skills across sessions**

- Create multiple sessions consuming overlapping learned skills.
- Call `getFleetStats()`.
- Verify each learned skill aggregate reports:
  - total `invocationCount`
  - `sessionCount`
  - first/last invocation timestamps

**Test 21: `getFleetStats({ since })` filters learned skill aggregates by session creation window**

- Create older and newer sessions with learned skill usage.
- Call `getFleetStats({ since: cutoff })`.
- Verify only learned skill usage from sessions created after the cutoff is included.

### Suite 6: End-to-End Knowledge Pipeline Flow

**Test 22: Facts Manager promotion -> materialization -> agent consumption -> session stats**

- Write intake.
- Simulate or run Facts Manager promotion to a learned skill in `{ skillmd, meta }` form.
- Increment `skills/_version`.
- Run a task agent session that should use the learned skill.
- Verify:
  - the learned skill materializes locally
  - the agent response reflects the learned skill
  - the session stats show the learned skill and its invocation count

**Test 23: Learned skill update remains visible in fleet aggregates**

- Promote a learned skill, consume it from multiple sessions, then update the skill content and version.
- Run additional sessions that use the updated skill.
- Verify fleet aggregates remain keyed by `skill_key` and combine pre- and post-update usage correctly.

### Test Registration

- Add `skill-materialization.test.js` to `packages/sdk/test/local/`.
- Extend `packages/sdk/test/local/session-stats.test.js` with learned-skill summary coverage for session/tree/fleet reads.
- Add the new suite to the local test runner registration alongside the existing knowledge-pipeline and session-stats suites.

## Risks

- **SKILL.md quality**: The Facts Manager must produce well-formed YAML frontmatter. Malformed frontmatter will cause the skill to be silently skipped by `loadSkills`. Mitigation: validate frontmatter in `syncLearnedSkills` before writing.
- **Disk I/O on every turn**: The version check is a single file read. Full sync only triggers on version mismatch. Typical steady-state cost: one `stat()` call per turn.
- **Race between workers**: Two workers may sync simultaneously. This is safe — they both write the same content. Last writer wins is fine since content is identical.
- **Large skill count**: With 200 skills, sync writes ~200 files. At typical SKILL.md sizes (1-2 KB), this is <1 MB and completes in milliseconds.
- **Session-skill summary growth**: Row count scales with unique `(session_id, learned_skill)` pairs, not raw invocations. A deployment with 10K sessions and an average of 3 learned skills per session yields ~30K rows, which is modest.

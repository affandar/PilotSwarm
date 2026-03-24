# Shared Skills Pipeline

## Summary

A knowledge pipeline where task agents write raw observations into an intake namespace, a singleton Facts Manager system agent curates those observations into shared skills, and all agents consume a filtered index of curated skills and open corroboration requests.

## Motivation

Agents operating in PilotSwarm discover operational knowledge during task execution — environment quirks, configuration requirements, workarounds, failure modes. Today that knowledge is lost when the session ends. The facts table already provides durable shared storage, but there is no convention for how agents should contribute to and consume a shared knowledge base.

Asking every task agent to write well-structured, deduplicated shared skills directly does not work. LLMs are inconsistent writers: they produce duplicate keys, inconsistent taxonomies, and overly confident guidance from thin evidence. A dedicated curator agent solves this by separating evidence collection (cheap, low-friction) from knowledge synthesis (editorial, high-judgment).

## Architecture

```
Task Agents                    Facts Manager                 All Agents
(write only intake)            (singleton system agent)      (read skills + asks)
                                                             
  observe something ──────►  intake/<topic>/<id>              
                                    │                         
                              ┌─────▼──────┐                  
                              │   TRIAGE    │                  
                              └─────┬──────┘                  
                                    │                         
                         ┌──────────┼──────────┐              
                         ▼          ▼          ▼              
                      ignore    open ask    promote            
                                    │          │              
                              asks/<t>/<s>  skills/<t>/<s> ──► agents read
                                    │                          in context
                              ◄─────┘                         
                         agents see ask                       
                         in context,                          
                         write more intake ──►                
```

### Namespaces

| Namespace | Writer | Reader | Purpose |
|-----------|--------|--------|---------|
| `intake/<topic>/<session-id>` | Any task agent | Facts Manager only | Raw observations, incidents, outcomes |
| `asks/<topic>/<subtopic>` | Facts Manager only | All agents (index injected into context) | Active requests for corroboration |
| `skills/<topic>/<subtopic>` | Facts Manager only | All agents (index injected into context) | Curated operational guidance |

### Key Naming Rules

- Lowercase, hyphens between words.
- Topic = technology or domain area (e.g. `kubernetes`, `terraform`, `docker`).
- Subtopic = specific technique, failure mode, or pattern (e.g. `ingress-timeout`, `s3-backend-encryption`).
- No abbreviations: `kubernetes`, not `k8s`.
- Intake keys use the writing agent's session ID as the leaf segment to guarantee uniqueness without coordination.

### Namespace Access Control

The three pipeline namespaces (`intake/`, `asks/`, `skills/`) are **reserved key spaces**. The `store_fact`, `read_facts`, and `delete_fact` tool handlers enforce access control based on the calling agent's identity. This is not prompt-level guidance — it is a hard enforcement boundary in the tool layer.

| Namespace | Task Agents | Facts Manager |
|-----------|-------------|---------------|
| `intake/*` | write | read, delete |
| `asks/*` | read | read, write, delete |
| `skills/*` | read | read, write, delete |
| `config/facts-manager/*` | — | read, write |

Enforcement happens in `createFactTools()` in `facts-tools.ts`:

- **`store_fact` handler**: Before writing, checks the key prefix. If the key starts with `skills/` or `asks/`, the handler rejects the call unless `ctx.agentId === "facts-manager"`. If the key starts with `intake/`, any agent may write.
- **`read_facts` handler**: Before reading, checks the key pattern. If the pattern matches `intake/%` or `intake/*`, the handler rejects the call unless `ctx.agentId === "facts-manager"`. Task agents cannot read raw intake.
- **`delete_fact` handler**: Same prefix check as `store_fact`. Only the Facts Manager can delete from `intake/`, `asks/`, and `skills/`.

Error messages returned to the LLM on violation:

```
"Error: the 'skills/' key namespace is reserved for the Facts Manager. 
Write observations to 'intake/<topic>/<your-session-id>' instead."
```

```
"Error: the 'intake/' key namespace is not readable by task agents. 
Read curated skills from 'skills/' or open asks from 'asks/' instead."
```

This ensures that even if an agent ignores prompt instructions, it cannot corrupt the curated namespace or spy on raw intake.

## Schemas

### Intake Record

Written by any task agent via `store_fact(key="intake/<topic>/<session-id>", shared=true)`.

```jsonc
{
  "problem": "Terraform apply failed with 403 on S3 state push",
  "environment": "AWS us-east-1, Terraform 1.7",
  "action_taken": "Added encrypt=true to backend config",
  "outcome": "success",           // "success" | "failure" | "partial" | "observation"
  "detail": "S3 backend requires encrypt=true or state operations return 403",
  "related_ask": "asks/terraform/s3-backend-encryption",  // optional, if responding to an ask
  "artifacts": [],                // optional artifact:// links to logs, configs, etc.
  "timestamp": "2026-03-23T14:30:00Z"
}
```

Task agents should write intake when they:
- Discover an environment-specific requirement
- Find a workaround for a failure
- Confirm or contradict a previously seen pattern
- Complete a task that required non-obvious configuration

Task agents should NOT write intake for:
- Routine successful operations with no surprises
- Speculative hypotheses they did not verify
- User preferences (use regular session-scoped facts for those)

### Ask Record

Written by the Facts Manager via `store_fact(key="asks/<topic>/<subtopic>", shared=true)`.

```jsonc
{
  "summary": "Does S3 backend for Terraform require encrypt=true?",
  "detail": "One agent reported a 403 when encrypt was not set. Need corroboration from other AWS environments.",
  "status": "open",              // "open" | "satisfied" | "stale" | "abandoned"
  "evidence_needed": "Outcomes from Terraform S3 backend operations with and without encrypt=true",
  "linked_intakes": [
    "intake/terraform/session-abc123"
  ],
  "opened": "2026-03-23T14:35:00Z",
  "last_reviewed": "2026-03-23T14:35:00Z"
}
```

Ask lifecycle:
- `open` — actively seeking corroboration; surfaced to all agents.
- `satisfied` — enough evidence collected; promoted to a skill. No longer surfaced.
- `stale` — no new evidence for an extended period. May be re-opened or abandoned.
- `abandoned` — determined to be not worth pursuing. Deleted on next compaction.

### Curated Skill Record

Written by the Facts Manager via `store_fact(key="skills/<topic>/<subtopic>", shared=true)`.

Curated skills mirror the structure of file-based `SKILL.md` files. The Copilot SDK already has a skill system where skills are loaded from disk with YAML frontmatter (`name`, `description`) and a markdown body (`prompt`), plus optional `toolNames` from a companion `tools.json`. Curated facts-table skills should present the same shape so agents receive a consistent experience regardless of whether a skill came from a static file or from the knowledge pipeline.

```jsonc
{
  // ── SKILL.md-equivalent fields (presented to agents like file-based skills) ──
  "name": "terraform-s3-backend-encryption",
  "description": "S3 backend for Terraform requires encrypt=true",
  "instructions": "When configuring Terraform with an S3 backend:\n1. Always set `encrypt = true` in the backend block.\n2. Without this flag, state operations return HTTP 403.\n3. This applies to all AWS regions tested so far (us-east-1, eu-west-1).\n\nCaveats:\n- Not yet verified on GovCloud regions.",
  "tools": [],                     // tool names relevant to this skill (may be empty)

  // ── Curation metadata (not surfaced to consuming agents) ──
  "confidence": "high",           // "low" | "medium" | "high"
  "version": 1,
  "evidence_count": 4,            // number of corroborating intakes
  "contradiction_count": 0,       // number of contradicting intakes
  "linked_ask": "asks/terraform/s3-backend-encryption",
  "linked_intakes": [
    "intake/terraform/session-abc123",
    "intake/terraform/session-def456"
  ],
  "created": "2026-03-23T15:00:00Z",
  "last_reviewed": "2026-03-23T15:00:00Z"
}
```

When the orchestration's `loadKnowledgeIndex` activity reads curated skills, it maps them into the same `Skill` interface used by the file-based loader:

```typescript
interface Skill {
    name: string;        // from value.name
    description: string; // from value.description
    prompt: string;      // from value.instructions (the markdown body)
    toolNames: string[]; // from value.tools
    dir: string;         // empty or synthetic — not applicable for facts-based skills
}
```

This means the Copilot SDK treats curated skills identically to file-loaded skills: they appear in the same skill index, are presented with the same context structure, and are invocable with the same conventions. An agent reading a curated skill gets the same experience as reading a skill that shipped with the application.

Confidence progression:
- 1 observation, no corroboration → `low`
- 2–3 corroborating observations → `medium`
- 4+ corroborating, no contradictions → `high`
- Contradictory evidence → confidence stays or drops; instructions must note the disagreement
- Repeated failures → skill revised or removed

## Facts Manager

### Identity

- System agent: `facts-manager`
- Singleton: duroxide guarantees exactly one instance exists per deployment.
- Runs in a perpetual loop with a 5-minute `wait` between cycles.
- Auto-starts with the deployment alongside Sweeper and ResourceMgr.

### Responsibilities

The Facts Manager has exactly four responsibilities:

1. **Intake triage** — Read all pending intake facts, assess quality, decide disposition.
2. **Ask management** — Open asks for corroboration when evidence is thin, close them when satisfied.
3. **Skill promotion and revision** — Synthesize intakes into curated skills, update existing skills with new evidence.
4. **Compaction** — Mark incorporated intakes, retire satisfied asks, prune stale entries.

### Decision Rules

On each cycle, the Facts Manager:

1. **Reads all intake facts**: `read_facts(key_pattern="intake/%", scope="shared")`
2. **Groups by topic**: Clusters intakes by their topic segment and semantic similarity.
3. **For each cluster, decides**:
   - **Noise** — Vague, unverifiable, or irrelevant. Mark as reviewed, delete on next cycle.
   - **Weak signal** — Interesting but unverified. If no ask exists, open one. If an ask exists, link the intake.
   - **Strong signal** — Multiple corroborating intakes with consistent outcomes. Promote to skill or update existing skill.
   - **Contradiction** — Conflicts with an existing skill. Note the contradiction in the skill record, lower confidence if warranted.
4. **Reviews open asks**: `read_facts(key_pattern="asks/%", scope="shared")`
   - If enough evidence has arrived → promote to skill, mark ask as `satisfied`.
   - If no new evidence for multiple cycles → mark as `stale`.
5. **Compacts**: Delete incorporated intakes, delete abandoned/satisfied asks.

### Editorial Principles

The Facts Manager prompt should instruct it to:

- Preserve caveats and qualifiers. Do not overgeneralize.
- Keep competing hypotheses when evidence conflicts.
- Note environment-specific conditions explicitly.
- Mark low-confidence guidance as tentative.
- Prefer narrow, precise skills over broad vague ones.
- Reject noisy or under-specified intake evidence rather than incorporating it.
- Act as a cautious runbook editor, not a summarizer.

### Cycle Pseudocode

```
loop:
  // 1. Harvest
  intakes = read_facts(key_pattern="intake/%", scope="shared")
  
  // 2. Read existing state
  asks = read_facts(key_pattern="asks/%", scope="shared")
  skills = read_facts(key_pattern="skills/%", scope="shared")
  
  // 3. Triage each intake
  for each intake:
    - classify: noise | weak signal | strong signal | contradiction
    - if noise: delete intake
    - if weak signal:
        - if related ask exists: link intake to ask
        - else: open new ask
    - if strong signal:
        - if related skill exists: update skill, bump version
        - else: create new skill
        - mark intake as incorporated
    - if contradiction:
        - update skill with caveat, adjust confidence
        - mark intake as incorporated
  
  // 4. Review asks
  for each open ask:
    - if sufficient linked evidence: promote to skill, mark satisfied
    - if stale: mark stale or abandon
  
  // 5. Compact
  delete incorporated intakes
  delete satisfied/abandoned asks (after retention window)
  
  // 6. Wait
  wait(300)  // 5 minutes
```

## Agent Context Injection

### Curated Skills as SDK Skills

The `loadKnowledgeIndex` activity does not just build a text index — it returns curated skills in the same `Skill` shape that the Copilot SDK uses for file-based SKILL.md skills. The orchestration passes these to the session config alongside the static `skillDirectories` skills.

This means:
- Curated skills are presented in the SDK's native skill format (name, description, prompt, toolNames).
- Agents interact with curated skills the same way they interact with file-loaded skills.
- The SDK's existing skill invocation and context presentation paths handle both types uniformly.
- No separate "curated skills" concept exists from the agent's perspective — they are just skills.

### Active Asks Index

Active asks are different — they are not skills, they are requests for corroboration. These are injected as a compact text block prepended to the user prompt:

```
[ACTIVE FACT REQUESTS]
The Facts Manager is seeking corroboration on these topics.
If any are relevant to your current task, read the full ask
with read_facts and contribute intake evidence if you can.
- asks/kubernetes/ingress-timeout
- asks/terraform/s3-backend-encryption
```

### Access Control Context

The orchestration also injects a brief reminder of namespace access rules so agents do not waste tool calls on operations that will be rejected:

```
[FACT NAMESPACE RULES]
- You can WRITE to: intake/<topic>/<session-id> (shared observations)
- You can READ from: skills/*, asks/* (curated knowledge, open requests)
- You CANNOT write to skills/ or asks/ (Facts Manager only)
- You CANNOT read from intake/ (Facts Manager only)
```

This is a prompt-level hint only — the actual enforcement is in the tool handlers.

### What Gets Injected

Before each `runTurn`, the orchestration loads curated skills and active asks via the `loadKnowledgeIndex` activity:

1. **Curated skills** → mapped to `Skill` objects and merged into the session's skill set (same as file-based skills).
2. **Active asks** → formatted as a compact text index prepended to the turn prompt.
3. **Namespace rules** → appended as a brief access control reminder.

### What Does NOT Get Injected

- Full skill or ask bodies (agents lazy-load with `read_facts`).
- Raw intake facts (only the Facts Manager reads those).
- Satisfied/stale/abandoned asks.

### Filtering

The index should be capped. If the total number of skills + asks exceeds a threshold (e.g. 50), surface only the most recently reviewed and highest confidence items. The orchestration activity handles this filtering.

## Orchestration Changes

### New Activity: `loadKnowledgeIndex`

Added to `session-proxy.ts`. Reads shared facts matching `skills/%` and `asks/%` (only open asks), applies a cap, and returns:

```typescript
{
  skills: Array<{
    name: string;        // e.g. "terraform-s3-backend-encryption"
    description: string; // one-line summary
    prompt: string;      // full instructions (markdown body)
    toolNames: string[]; // relevant tool names (may be empty)
  }>,
  asks: Array<{
    key: string;         // e.g. "asks/terraform/s3-backend-encryption"
    summary: string;     // one-line summary of what evidence is needed
  }>
}
```

The `skills` array uses the same `Skill` interface as the file-based skill loader, so the orchestration can merge them directly into the session config's skill set.

### Prompt Injection

In `orchestration.ts`, before each `runTurn`, the orchestration:

1. Yields `manager.loadKnowledgeIndex()`.
2. Merges returned `skills` into the session's skill config (alongside static file-based skills).
3. If `asks` is non-empty, prepends the active asks index + namespace rules to the user prompt.
4. This is an activity call, so it is replay-safe.

The injection is skipped for the Facts Manager's own sessions to avoid circular context.

### Tool Handler Changes: Namespace Access Control

In `facts-tools.ts`, the `createFactTools()` function accepts a new option:

```typescript
createFactTools({
    factStore,
    getDescendantSessionIds,
    agentIdentity?: string,  // NEW: the agent's identity for access control
})
```

Each tool handler checks the key or key pattern against the reserved namespaces and the calling agent's identity:

- `store_fact`: rejects writes to `skills/` and `asks/` unless `agentIdentity === "facts-manager"`.
- `read_facts`: rejects reads from `intake/` unless `agentIdentity === "facts-manager"`.
- `delete_fact`: rejects deletes from `intake/`, `asks/`, and `skills/` unless `agentIdentity === "facts-manager"`.

The `agentIdentity` is set from the session's bound agent config at tool construction time in `SessionManager.getOrCreate()`. It is not user-controllable — it comes from the `AgentConfig.id` field resolved by the orchestration.

### New Orchestration Version

This requires a new orchestration version (`1.0.24`) because it adds a `yield` before `runTurn`.

## Default Agent Prompt Changes

Add to `default.agent.md`:

### Shared Knowledge Pipeline

```markdown
## Shared Knowledge Pipeline

You operate in a system with a shared knowledge pipeline. There are three namespaces
in the facts table that support collaborative learning across agents:

### Reading Skills (all agents)

Before each turn, you receive a compact index of curated skills and open fact requests.
- If a **curated skill** is relevant to your task, call `read_facts(key_pattern="skills/<topic>/<subtopic>", scope="shared")` to read the full instructions, then apply them.
- If an **active fact request** is relevant, read it and — if you encounter the described situation during your work — contribute an intake observation.
- Skills are advisory. Read the full skill critically before applying it. Prefer high-confidence, recently reviewed skills.

### Writing Observations (all agents)

When you discover something operationally significant — a configuration requirement, a failure mode, a workaround, an environment quirk — write an intake observation:

    store_fact(
      key="intake/<topic>/<your-session-id>",
      value={ problem, environment, action_taken, outcome, detail, related_ask },
      shared=true
    )

Rules:
- Write intake only for verified findings, not speculative hypotheses.
- Use lowercase, hyphenated topic names (e.g. `kubernetes`, `terraform`, `docker`).
- Reference a `related_ask` key if you are responding to an active fact request.
- Do NOT write directly to `skills/` or `asks/` — only the Facts Manager does that.

### What NOT to Write as Intake

- Routine successful operations with no surprises.
- User preferences (use regular session-scoped facts).
- Unverified guesses.
```

## Facts Manager Agent Definition

New file: `packages/sdk/plugins/system/agents/facts-manager.agent.md`

```yaml
---
name: facts-manager
description: Singleton system agent that curates shared operational knowledge.
system: true
id: facts-manager
title: Facts Manager
tools:
  - store_fact
  - read_facts
  - delete_fact
  - wait
initialPrompt: >
  Begin your curation cycle. Read all intake observations, review open asks,
  and update curated skills as warranted. Then wait 5 minutes and repeat.
splash: |
  ┌─ Facts Manager ─┐
  │ Knowledge curator│
  └──────────────────┘
---
```

With a prompt body defining its editorial responsibilities, decision rules, and schema expectations as described in the Facts Manager section above.

## Implementation Phases

| Phase | Scope | Files Changed |
|-------|-------|---------------|
| 1 | Default agent prompt: add Shared Knowledge Pipeline section, namespace rules | `default.agent.md` |
| 2 | Facts Manager agent definition | New `facts-manager.agent.md` |
| 3 | Namespace access control in fact tool handlers | `facts-tools.ts` |
| 4 | `loadKnowledgeIndex` activity returning `Skill`-shaped objects + ask index | `session-proxy.ts` |
| 5 | Orchestration: merge curated skills into session config, inject asks index | `orchestration.ts` (new version 1.0.24) |
| 6 | Pass `agentIdentity` through session config to fact tool construction | `session-manager.ts`, `types.ts` |
| 7 | System agent auto-start: register Facts Manager | System agent startup wiring |
| 8 | Tests: namespace access control, intake/ask/skill lifecycle, context injection | New test file |

## Decisions (formerly Open Questions)

All Facts Manager operational parameters are stored as shared facts under a reserved config namespace (`config/facts-manager/*`). The Facts Manager lazily inserts defaults on its first bootstrap cycle if the config facts do not yet exist. Users can change any parameter by conversing with the Facts Manager directly — it updates the corresponding config fact. Users can also review all facts and request changes through conversation.

### 1. Retention window for compacted intakes

Default: infinite (never auto-delete). Stored as `config/facts-manager/retention-window`.

The user can adjust this by telling the Facts Manager to change its retention policy. Setting it to a finite value (e.g. `86400` seconds) causes the Facts Manager to prune incorporated intakes older than that threshold on each compaction cycle.

### 2. Cap on surfaced skills + asks

Default: 50 combined entries. Stored as `config/facts-manager/index-cap`.

If exceeded, prioritize by confidence and recency. The user can raise or lower this by conversing with the Facts Manager.

### 3. Facts Manager cycle interval

Default: 300 seconds (5 minutes). Stored as `config/facts-manager/cycle-interval`.

The user can adjust this by telling the Facts Manager. The Facts Manager reads this config fact at the start of each cycle to determine its next `wait` duration.

### 4. Knowledge base reporting

The Facts Manager can print a summary periodically in chat (e.g. after each compaction cycle: "Processed 3 intakes, promoted 1 skill, 2 open asks"). On demand, the user can ask the Facts Manager for a detailed report, which it produces as a markdown artifact via `write_artifact` + `export_artifact` for download.

### 5. Cross-deployment skill portability

User-driven. The user can ask the Facts Manager to export the entire knowledge base (all curated skills, open asks, and optionally retained intakes) as a tar artifact via `write_artifact` + `export_artifact`. The user downloads this and can upload it to another deployment using the artifact upload capability (`Ctrl+A` in TUI or the upload API). On the receiving side, the user tells the Facts Manager to import the uploaded artifact, which reads the tar contents and stores each entry as shared facts. This keeps the mechanism simple — no special export/import protocol, just artifacts and conversation.

### Self-Configuration Pattern

All config facts follow the key schema `config/facts-manager/<parameter>`. The namespace access control rules treat `config/facts-manager/*` the same as `skills/*` and `asks/*` — only the Facts Manager can write to it. Users interact with the config through conversation with the Facts Manager, not by writing facts directly.

On bootstrap, the Facts Manager checks for each config key and inserts the default if missing:

```
config/facts-manager/retention-window  → { "value": -1, "unit": "seconds", "description": "Intake retention after incorporation. -1 = infinite." }
config/facts-manager/index-cap         → { "value": 50, "description": "Max skills + asks surfaced to agents per turn." }
config/facts-manager/cycle-interval    → { "value": 300, "unit": "seconds", "description": "Seconds between compaction cycles." }
```

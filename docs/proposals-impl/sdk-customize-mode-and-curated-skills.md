# Proposal: SDK Customize Mode & Curated Skills Injection

## Status

Proposed

## Summary

Migrate PilotSwarm's system prompt assembly from monolith string concatenation (append mode) to the Copilot SDK's `customize` mode with per-section overrides and transform callbacks. Additionally, move the curated-skills injection from orchestration-time prompt prepending into the SDK's section transform pipeline, giving the CLI full visibility into injected context.

---

## Problem

### Monolith System Prompt

Today, `_buildSystemMessage()` in `session-manager.ts` calls `composeSystemPrompt()` from `prompt-layering.ts`, which concatenates framework base + app default + active agent + runtime context into a single string with markdown headers. This string is passed as `systemMessage: { content: "..." }` (append mode), which appends the entire blob after the CLI's built-in system prompt sections.

Consequences:

1. **Duplication.** The CLI already ships identity, safety, tool efficiency, and environment context sections. Our monolith appends on top; the LLM sees redundant or conflicting instructions.
2. **Blunt precedence.** We rely on a "these instructions are authoritative" preamble to override the CLI's own sections. This is fragile — the LLM may not honor positional precedence reliably across models.
3. **No surgical control.** We cannot remove, replace, or append to a specific CLI section. Everything is one blob.

### Curated Skills Injection

The orchestration (`orchestration.ts` §②½) prepends `[CURATED SKILLS]` and `[ACTIVE FACT REQUESTS]` blocks directly onto the user prompt string before calling `runTurn()`. This works, but:

1. **Invisible to the CLI.** The injected context is baked into the user message, not a system prompt section. The CLI's prompt structure is unaware of it.
2. **Grows the user message.** As the skill index grows, the user prompt balloons. System-level context belongs in the system prompt.
3. **Per-turn string manipulation in the orchestration.** The orchestration generator — which must be deterministic — does string concat that could move into a structured SDK callback.

---

## Proposed Design

### 1. Switch to `customize` Mode

Replace the `_buildSystemMessage()` return value with a `SystemMessageCustomizeConfig`:

```typescript
import type { SystemMessageCustomizeConfig } from "@github/copilot-sdk";

private _buildSystemMessage(config: SerializableSessionConfig): SystemMessageCustomizeConfig {
    const frameworkBase = this.workerDefaults.frameworkBasePrompt ?? this.workerDefaults.systemMessage;
    const runtimeContext = extractPromptContent(config.systemMessage);
    const boundAgentName = config.boundAgentName;
    const layerKind = config.promptLayering?.kind ?? (boundAgentName ? "app-agent" : undefined);
    const activeAgentPrompt = boundAgentName
        ? this.workerDefaults.agentPromptLookup?.[boundAgentName]?.prompt
        : undefined;
    const appDefault = (layerKind === "pilotswarm-system-agent")
        ? undefined
        : this.workerDefaults.appDefaultPrompt;

    const sections: Record<string, { action: string; content?: string }> = {};

    // Framework base → replace custom_instructions (our primary slot)
    if (frameworkBase) {
        sections.custom_instructions = { action: "replace", content: frameworkBase };
    }

    // App default → append to guidelines
    if (appDefault) {
        sections.guidelines = { action: "append", content: appDefault };
    }

    // Active agent + runtime context → replace last_instructions
    const lastParts = [activeAgentPrompt, runtimeContext].filter(Boolean);
    if (lastParts.length > 0) {
        sections.last_instructions = { action: "replace", content: lastParts.join("\n\n") };
    }

    return { mode: "customize", sections };
}
```

**What this preserves from the CLI:**

| CLI Section | Action |
|---|---|
| `identity` | Kept as-is (CLI default) |
| `tone` | Kept as-is |
| `tool_efficiency` | Kept as-is |
| `environment_context` | Kept as-is |
| `code_change_rules` | Kept as-is |
| `guidelines` | Appended with app default |
| `safety` | Kept as-is |
| `tool_instructions` | Kept as-is (or append — see §2) |
| `custom_instructions` | Replaced with framework base |
| `last_instructions` | Replaced with agent prompt + runtime context |

### 2. Move Curated Skills into `tool_instructions` Transform

Instead of prepending skills onto the user prompt in `orchestration.ts`, register a transform callback on the `tool_instructions` section that injects the curated skills index:

```typescript
// In session-manager.ts, when building sessionConfig:
sections.tool_instructions = {
    action: (currentContent: string) => {
        // knowledgeIndex is loaded per-session and cached
        const skillBlock = this._buildSkillBlock(knowledgeIndex);
        const askBlock = this._buildAskBlock(knowledgeIndex);
        return [currentContent, skillBlock, askBlock].filter(Boolean).join("\n\n");
    },
};
```

The knowledge index would be loaded once per `getOrCreateSession()` call (or refreshed per-turn via the existing `loadKnowledgeIndex` activity) and stored on the `ManagedSession` for the transform callback to access.

**Benefits:**

- The CLI sees the skills as part of the structured system prompt, not buried in the user message.
- The orchestration generator no longer does string manipulation — the curated skills injection moves entirely to the session layer.
- The `tool_instructions` section is the semantically correct home for "here are additional capabilities you can invoke."

### 3. Available Sections Reference

The SDK defines these system prompt sections (from `types.d.ts`):

| Section ID | Description |
|---|---|
| `identity` | Agent identity and role definition |
| `tone` | Communication style and tone guidance |
| `tool_efficiency` | Rules for efficient tool usage |
| `environment_context` | OS, editor, workspace context |
| `code_change_rules` | Rules for code modifications |
| `guidelines` | General behavioral guidelines |
| `safety` | Safety and security restrictions |
| `tool_instructions` | Tool-specific usage instructions |
| `custom_instructions` | User/framework custom instructions |
| `last_instructions` | Final instructions (highest positional priority) |

Override actions: `replace`, `remove`, `append`, `prepend`, or a `SectionTransformFn` callback `(currentContent: string) => string | Promise<string>`.

---

## Migration Plan

### Phase 1: Customize Mode (no behavior change)

1. Change `_buildSystemMessage()` to return `SystemMessageCustomizeConfig` instead of a string.
2. Update `sessionConfig.systemMessage` assignment in `session-manager.ts` to pass the config object directly (the SDK handles it).
3. Remove `composeSystemPrompt()` and the header constants from `prompt-layering.ts`.
4. Verify: run full test suite — LLM behavior should be equivalent or improved (less redundancy).

### Phase 2: Curated Skills Migration  

1. Add a `_knowledgeTransform` method on `SessionManager` (or `ManagedSession`) that returns a `SectionTransformFn` for `tool_instructions`.
2. Wire it into the `sections` map when knowledge pipeline is enabled.
3. Remove the `[CURATED SKILLS]` and `[ACTIVE FACT REQUESTS]` prompt-prepend block from `orchestration.ts` §②½.
4. Update `default.agent.md` skill-reading instructions if the section location changes.

### Phase 3: Section Tuning

Once customize mode is live, tune section assignments per agent type:

- **System agents** (PilotSwarm, Sweeper, ResourceMgr): may want to `replace` `identity` with their specific role.
- **Sub-agents**: may want to `remove` `code_change_rules` or `environment_context` if they don't interact with the workspace.
- **Facts Manager**: should `remove` curated skills injection (already skipped today, but cleaner as a section override).

---

## Risks & Considerations

1. **`@internal` API surface.** `registerTransformCallbacks` is marked internal — it's auto-invoked when passing `mode: "customize"`. We don't call it directly, but we depend on the SDK's `SystemMessageCustomizeConfig` contract. Pin the SDK version and track changes.

2. **Section ID stability.** If the CLI renames or removes a section, content-bearing overrides gracefully fall back (appended to additional instructions) and `remove` becomes a no-op. Monitor SDK changelogs.

3. **Transform callbacks are non-serializable.** Same constraint as tool handlers — they must live on the worker side. This is already the case for our architecture.

4. **Orchestration determinism.** Moving curated skills out of the orchestration's prompt-prepend and into a session-layer transform *improves* determinism — the orchestration generator no longer conditionally mutates the prompt string.

5. **Backward compatibility.** The `prompt-layering.ts` module is internal (`@internal`). No public API changes. Builder apps using `systemMessage` on `createSession` continue to work — their content flows into `runtimeContext` as before.

---

## Related

- [Prompt Layering and Precedence](prompt-layering-and-precedence.md) — current (implemented) design
- [Shared Skills Pipeline](../proposals/shared-skills-pipeline.md) — curated skills architecture
- [Plugin Architecture Guide](../plugin-architecture-guide.md) — plugin loading and layering

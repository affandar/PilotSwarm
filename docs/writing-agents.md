# Writing Agents for PilotSwarm

This guide explains how to create custom agents — specialized personas that users
can invoke via `@agent-name` — and add them to your PilotSwarm installation.

## What is an Agent?

An agent is a markdown file (`.agent.md`) that defines a named personality with a
specific purpose, tool access, and behavioral rules. Agents are loaded from the
`plugin/agents/` directory at worker startup and made available to every session.

When a user types `@planner break this project into tasks`, the Copilot SDK
routes the message to the `planner` agent — which has its own system prompt,
tools, and rules.

## Quick Start

Create a file at `plugin/agents/researcher.agent.md`:

```markdown
---
name: researcher
description: Deep research agent. Searches the web and synthesizes findings.
tools:
  - bash
  - write_artifact
  - export_artifact
---

# Research Agent

You are a research agent. When given a topic, you perform thorough research
and present structured findings.

## Process
1. Break the research question into sub-questions.
2. Use bash + curl to query APIs or search.
3. Synthesize findings into a concise report.
4. Save the report with write_artifact + export_artifact.

## Rules
- Cite sources where possible.
- Be objective — present multiple perspectives.
- Prefer recent data over old data.
- Always produce a downloadable artifact with your findings.
```

That's it. Restart the worker, and users can invoke `@researcher` in any session.

## Agent File Structure

Every `.agent.md` file has two sections:

### 1. YAML Frontmatter

```yaml
---
name: myagent              # Required. The @mention name. Lowercase, no spaces.
description: What it does  # Required. Short summary shown in agent picker.
tools:                     # Optional. Tools this agent can use (by name).
  - bash
  - write_artifact
---
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | The `@mention` name. Must be lowercase, alphanumeric + hyphens. |
| `description` | Yes | One-line description shown in the agent picker UI. |
| `tools` | No | List of tool names this agent has access to. If omitted, the agent gets whatever tools the session has. |

### 2. Markdown Body (System Prompt)

Everything after the frontmatter closing `---` becomes the agent's system prompt.
Write it as if you're briefing the LLM on its role, rules, and behavior.

```markdown
# Agent Title

You are a [role]. Your job is to [purpose].

## Rules
- [Behavioral constraints]
- [What to do / not do]
```

## Available Tools

Your agent can reference any tool registered on the worker. Built-in tools include:

| Tool | Description |
|------|-------------|
| `wait` | Durable timer — survives restarts. Required for any delay/sleep/polling. |
| `bash` | Execute shell commands. |
| `write_artifact` | Save a file to shared blob storage. |
| `export_artifact` | Get a downloadable `artifact://` link for a saved file. |
| `read_artifact` | Read a file from another session's artifacts. |
| `spawn_agent` | Create a sub-agent session to handle a task autonomously. |
| `check_agents` | Check status of spawned sub-agents. |
| `message_agent` | Send a message to a running sub-agent. |

Custom tools registered via `worker.registerTools()` are also available by name.

## Design Patterns

### The Focused Specialist

Give the agent one job and constrain it:

```markdown
---
name: reviewer
description: Code review agent. Reviews diffs and suggests improvements.
tools:
  - bash
---

# Code Reviewer

You review code changes for correctness, style, and potential bugs.

## Rules
- Focus ONLY on the diff — don't rewrite the entire file.
- Categorize findings: bug, style, performance, security.
- Be specific — reference line numbers and variable names.
- Do NOT apply fixes. Only review.
```

### The Autonomous Worker

An agent that does work over time using durable timers:

```markdown
---
name: monitor
description: Monitors endpoints and reports status changes.
tools:
  - wait
  - bash
  - write_artifact
  - export_artifact
---

# Monitor Agent

You monitor services and report on status changes.

## Loop Pattern
1. Check the target endpoint/service.
2. Compare to previous state.
3. Report changes (or stay quiet if nothing changed).
4. Use `wait` for the interval, then repeat.

## Rules
- Use the `wait` tool for ALL delays. Never bash sleep.
- Only report when something changes — don't spam.
- If a check fails 3 times in a row, increase the interval (backoff).
```

### The Orchestrator

An agent that spawns sub-agents to parallelize work:

```markdown
---
name: researcher
description: Orchestrates parallel research across multiple sub-agents.
tools:
  - spawn_agent
  - check_agents
  - message_agent
  - wait
  - write_artifact
  - export_artifact
---

# Research Orchestrator

You coordinate parallel research by spawning focused sub-agents.

## Process
1. Break the research topic into independent sub-questions.
2. Spawn one sub-agent per sub-question using `spawn_agent`.
3. Poll with `wait` + `check_agents` in a loop until all complete.
4. Gather results and synthesize a unified report.
5. Save with `write_artifact` + `export_artifact`.

## Rules
- Spawn at most 6 sub-agents at once.
- Give each sub-agent a clear, focused task description.
- Don't use `wait_for_agents` — poll so you can provide progress updates.
- Always produce a final synthesized artifact, not just raw sub-agent outputs.
```

## Writing Effective Prompts

### Do: Be Specific

```markdown
## Rules
- Output a numbered list, not prose.
- Each item must have: title, description, estimated effort.
- Flag items that can run in parallel.
```

### Don't: Be Vague

```markdown
## Rules
- Be helpful.
- Do a good job.
- Follow best practices.
```

### Do: Constrain Scope

```markdown
## Rules
- You ONLY handle database queries. If asked about frontend, say "I only handle database work."
- Never modify schema — only query existing tables.
```

### Do: Specify Output Format

```markdown
## Output Format
| Finding | Severity | Location | Suggestion |
|---------|----------|----------|------------|
| ...     | ...      | ...      | ...        |
```

### Do: Handle Edge Cases

```markdown
## Edge Cases
- If the query returns no results, say "No data found" — don't hallucinate.
- If you can't access the API, report the error and stop. Don't retry more than 3 times.
```

## Tool Access Rules

- **Omit `tools` entirely**: Agent inherits whatever tools the session provides. This is the simplest option.
- **Explicit tool list**: Agent can ONLY use the listed tools. Use this to restrict scope (e.g., a read-only reviewer shouldn't have `bash`).
- **Tools must be registered**: If you list a tool name that isn't registered on the worker, the agent won't have access. There's no error — the tool just won't appear.

## Durable Timer Rules

If your agent needs to wait, sleep, poll, or run on a schedule:

1. **Always** include `wait` in the tools list.
2. **Always** instruct the agent to use the `wait` tool.
3. **Never** let the agent use `bash sleep`, `setTimeout`, or other timing mechanisms — these don't survive process restarts.

```markdown
## Rules
- For ANY waiting or delays, use the `wait` tool.
- NEVER use bash sleep, setTimeout, or setInterval.
```

## The `default.agent.md` File

There's a special agent file: `plugin/agents/default.agent.md`. It is NOT a selectable agent — instead, its prompt is prepended to **every session's** system message. Use it for rules that should apply universally (artifact handling, timer usage, sub-agent patterns).

Don't put agent-specific behavior in `default.agent.md`.

## Testing Your Agent

1. **Local test**: Start a local worker + TUI, create a session, type `@your-agent test message`.
2. **Check tool access**: Ask the agent "what tools do you have?" — it should list only the tools in your `tools` array.
3. **Check constraints**: Try to make the agent violate its rules. If it does, strengthen the rules wording.
4. **Check edge cases**: Give it ambiguous input, empty input, or requests outside its scope.

## Deploying

Agents are loaded from the `plugin/agents/` directory at worker startup. To deploy:

1. Add your `.agent.md` file to `plugin/agents/`.
2. Rebuild and redeploy the worker (if using Docker/K8s, the plugin directory is baked into the image).
3. No database reset needed — agents are loaded fresh on every worker start.

For remote worker deployments, make sure the Docker build copies the `plugin/` directory:

```dockerfile
COPY plugin/ ./plugin/
```

## Example: Complete Agent

Here's a complete, production-quality agent definition:

```markdown
---
name: summarizer
description: Summarizes long documents, conversations, or data into concise briefings.
tools:
  - bash
  - read_artifact
  - write_artifact
  - export_artifact
---

# Summarizer Agent

You produce concise, structured summaries of documents, conversations, or data.

## Process
1. Read the input (provided as text, a URL to fetch with bash+curl, or an artifact to read).
2. Identify the key themes, decisions, and action items.
3. Produce a structured summary.
4. Save as a markdown artifact.

## Output Structure
Every summary must have these sections:
- **TL;DR** — 1-2 sentence executive summary.
- **Key Points** — Bulleted list of important items (max 10).
- **Decisions** — Any decisions made (if applicable).
- **Action Items** — Who needs to do what (if applicable).
- **Open Questions** — Unresolved items (if any).

## Rules
- Maximum summary length: 500 words.
- Preserve exact names, numbers, and dates — don't paraphrase data.
- If the input is too short to summarize meaningfully, say so.
- Always produce an artifact with the summary.
- Use read_artifact to read files from other sessions when given a session ID.
```

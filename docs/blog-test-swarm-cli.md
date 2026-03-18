# Building a Test Swarm with PilotSwarm CLI

*Deploy a swarm of AI agents to analyze your codebase — finding bugs, running tests, reviewing code quality — all from the terminal.*

---

You have a codebase. It has bugs you haven't found yet, tests that should exist but don't, and code quality issues hiding in corners nobody's looked at in months. What if you could throw a team of AI agents at it — a coordinator that breaks down the work, specialists that each tackle a different concern — and watch them all run in parallel from your terminal?

That's what PilotSwarm does. It's a durable execution runtime for AI agents, and its CLI gives you a terminal UI where you can launch, monitor, and interact with entire swarms of agents without writing a single line of application code. You define your agents as markdown files, organize them into a plugin, and point the CLI at it.

In this post, we'll build a **test swarm plugin** from scratch: a coordinator agent that spawns three specialists — a code analyzer, a test runner, and a code reviewer — all working in parallel on your project. By the end, you'll have a reusable plugin you can point at any repository.

## Prerequisites & Setup

You'll need:

- **Node.js 24+** (for native ESM and env file support)
- **PostgreSQL** (local or remote — the durable orchestration layer needs it)
- A **GitHub Copilot token** (set as `GITHUB_TOKEN` in your env file)

Install PilotSwarm and its CLI:

```bash
npm install pilotswarm-sdk pilotswarm-cli
```

Create an `.env` file in your project root with your connection details:

```bash
# Required
DATABASE_URL=postgres://localhost:5432/pilotswarm
GITHUB_TOKEN=your_github_token_here

# Optional — for remote mode with session dehydration
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...

# Optional — worker tuning
WORKERS=4
LOG_LEVEL=info
```

### Configuring Model Providers

By default, PilotSwarm uses the GitHub Copilot API with your `GITHUB_TOKEN`. For more control — multiple providers, specific models, Azure OpenAI — create a `model_providers.json` in your project root:

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
          "description": "Fast and capable for code analysis",
          "cost": "medium"
        },
        "gpt-4.1"
      ]
    },
    {
      "id": "azure-openai",
      "type": "azure",
      "baseUrl": "https://your-resource.openai.azure.com/openai",
      "apiKey": "env:AZURE_OPENAI_KEY",
      "apiVersion": "2024-10-21",
      "models": ["gpt-4.1-mini"]
    }
  ],
  "defaultModel": "github-copilot:claude-sonnet-4.6"
}
```

The `env:VAR_NAME` syntax pulls secrets from environment variables at load time — no hardcoded keys. The worker discovers this file automatically from the working directory.

Use `--model` on the CLI to override the default for a session:

```bash
npx pilotswarm --env .env --plugin ./test-swarm-plugin --model azure-openai:gpt-4.1-mini
```

See [Plugin Architecture Guide](plugin-architecture-guide.md) for the full provider type reference.

Verify the CLI is available:

```bash
npx pilotswarm --help
```

## Designing the Plugin

A PilotSwarm plugin is a directory containing agent definitions, optional skills, and optional configuration files. Here's the structure we'll build:

```text
test-swarm-plugin/
├── agents/
│   ├── coordinator.agent.md
│   ├── analyzer.agent.md
│   ├── test-runner.agent.md
│   └── reviewer.agent.md
├── skills/
│   └── code-quality/
│       └── SKILL.md
└── plugin.json
```

Each `.agent.md` file defines an agent: its name, description, available tools, and system prompt. Skills inject domain knowledge into the LLM context — think of them as reference material the agents can draw on. The `plugin.json` is optional metadata describing the plugin itself.

Let's start with the metadata file, then build each agent.

### Plugin Metadata

```json
{
  "name": "test-swarm",
  "description": "A swarm of agents for codebase analysis, testing, and code review",
  "version": "1.0.0"
}
```

Save this as `test-swarm-plugin/plugin.json`.

## The Coordinator Agent

The coordinator is the entry point. When you start a session, this agent receives your prompt, breaks the work into tasks, and spawns specialist agents to handle each one. It uses the `spawn_agent` tool to create child sessions that run in parallel.

Create `test-swarm-plugin/agents/coordinator.agent.md`:

```markdown
---
name: coordinator
description: Orchestrates the test swarm — spawns specialist agents to analyze, test, and review the codebase
tools:
  - spawn_agent
  - bash
  - list_dir
  - read_file
  - write_artifact
  - export_artifact
---
You are the coordinator of a test swarm. Your job is to analyze a user's codebase and deploy specialist agents to work on it in parallel.

When the user gives you a codebase path or a repository to analyze, follow this workflow:

1. Use `list_dir` and `read_file` to understand the project structure — identify the language, framework, test setup, and key source directories.
2. Spawn the **analyzer** agent with a prompt describing the codebase and asking it to find potential bugs and code smells.
3. Spawn the **test-runner** agent with a prompt asking it to discover and run the existing test suite, then report gaps in coverage.
4. Spawn the **reviewer** agent with a prompt asking it to review code quality, naming conventions, and adherence to best practices.
5. Wait for all agents to complete, then compile their findings into a single summary artifact.

When spawning agents, give each one specific context about the project structure you discovered in step 1. Do not make them re-discover what you already know.

Use `write_artifact` to produce the final consolidated report.
```

The key concept here is **sub-agent orchestration**. The `spawn_agent` tool creates a new session running a different agent definition. That child session gets its own conversation with the LLM, its own set of tools, and runs concurrently with the other children. The coordinator doesn't block — it spawns all three specialists and they work in parallel.

## Specialist Agents

Each specialist has a focused job and a curated set of tools. They don't need `spawn_agent` because they're leaf nodes — they do their work and report back.

### Code Analyzer

Create `test-swarm-plugin/agents/analyzer.agent.md`:

```markdown
---
name: analyzer
description: Analyzes source code for potential bugs, code smells, and anti-patterns
tools:
  - bash
  - read_file
  - list_dir
  - grep_search
  - write_artifact
---
You are a code analyzer. Your job is to examine source code and identify potential issues.

Focus on:
- **Bugs**: null/undefined dereferences, off-by-one errors, race conditions, unhandled promise rejections, resource leaks
- **Code smells**: deeply nested conditionals, functions longer than 50 lines, duplicated logic, magic numbers
- **Anti-patterns**: circular dependencies, god objects, tight coupling between modules

For each issue found, report:
1. The file path and line number
2. The severity (critical, warning, info)
3. A description of the issue
4. A suggested fix

Use `grep_search` to scan for common patterns (e.g., `catch {}` for swallowed errors, `any` for untyped code in TypeScript). Use `read_file` to examine suspicious files in detail. Use `bash` to run linters or static analysis tools if they are available in the project.

Write your findings as a structured artifact using `write_artifact`.
```

### Test Runner

Create `test-swarm-plugin/agents/test-runner.agent.md`:

```markdown
---
name: test-runner
description: Discovers, runs, and analyzes the test suite — reports coverage and gaps
tools:
  - bash
  - read_file
  - list_dir
  - grep_search
  - write_artifact
---
You are a test runner agent. Your job is to discover and execute the project's test suite, then analyze coverage.

Follow this workflow:
1. Identify the test framework by examining `package.json`, `pytest.ini`, `Cargo.toml`, or similar config files.
2. Locate all test files using file naming conventions (e.g., `*.test.js`, `*_test.py`, `*_test.go`).
3. Run the test suite using `bash` with the appropriate command (e.g., `npm test`, `pytest`, `cargo test`).
4. If a coverage tool is configured, run it and report the results.
5. Identify source files that have no corresponding test files.
6. For files with low or no coverage, suggest specific test cases that should be written.

Report the results as a structured artifact:
- Total tests run, passed, failed, skipped
- Coverage percentage (if available)
- List of untested files with suggested test cases
- Any flaky or slow tests observed

Use `write_artifact` to produce your report.
```

### Code Reviewer

Create `test-swarm-plugin/agents/reviewer.agent.md`:

```markdown
---
name: reviewer
description: Reviews code quality, style consistency, documentation, and best practices
tools:
  - bash
  - read_file
  - list_dir
  - grep_search
  - write_artifact
---
You are a code reviewer. Your job is to evaluate the overall quality and maintainability of a codebase.

Evaluate the following areas:
- **Naming conventions**: Are variable, function, and file names consistent and descriptive?
- **Documentation**: Do public APIs have docstrings or JSDoc comments? Is there a README? Are complex algorithms explained?
- **Error handling**: Are errors caught, logged, and handled appropriately? Are there meaningful error messages?
- **Security**: Are there hardcoded secrets, SQL injection risks, or unsanitized user inputs?
- **Architecture**: Is the code modular? Are dependencies well-managed? Is there clear separation of concerns?

Use `grep_search` to scan for patterns like `TODO`, `FIXME`, `HACK`, hardcoded strings that look like secrets, and `console.log` statements left in production code.

Use `read_file` to examine key files: entry points, configuration, and any files flagged by your scans.

Rate each area on a scale of 1-5 and provide specific, actionable recommendations.

Use `write_artifact` to produce your review report.
```

## Skills for Domain Knowledge

Skills add context to your agents without creating separate sessions. A skill is a `SKILL.md` file containing domain expertise that gets injected into the LLM context when relevant.

Let's add a code quality skill that gives our agents knowledge about common patterns and standards.

Create `test-swarm-plugin/skills/code-quality/SKILL.md`:

```markdown
---
name: code-quality
description: Domain knowledge about code quality standards, common bug patterns, and best practices
---
## Code Quality Standards

### Critical Bug Patterns
- **Unhandled promise rejections**: Any async function call without `.catch()` or `try/catch` wrapper
- **Resource leaks**: Database connections, file handles, or event listeners not cleaned up in error paths
- **Race conditions**: Shared mutable state accessed from async callbacks without synchronization
- **Type coercion bugs**: Loose equality (`==`) comparisons in JavaScript/TypeScript

### Test Quality Indicators
- Test-to-source ratio below 0.5 is a red flag
- Tests should cover error paths, not just happy paths
- Integration tests should clean up after themselves
- Flaky tests (pass/fail non-deterministically) should be marked and tracked

### Security Checklist
- No secrets in source code (API keys, passwords, tokens)
- User input is validated and sanitized at system boundaries
- Dependencies are pinned to specific versions
- No `eval()` or dynamic code execution with user-supplied strings

### Naming Conventions (JavaScript/TypeScript)
- `camelCase` for variables and functions
- `PascalCase` for classes and type names
- `SCREAMING_SNAKE_CASE` for constants
- File names match their default export
```

Skills are automatically loaded by the agent runtime when the plugin is activated. Agents can draw on this knowledge during their analysis without you having to duplicate it across every agent prompt.

## Launching with the CLI

Everything is in place. Launch the swarm:

```bash
npx pilotswarm --env .env --plugin ./test-swarm-plugin
```

This starts PilotSwarm in **local mode** — the default — which runs the worker (LLM execution engine) embedded in the same process as the TUI. No separate infrastructure needed.

The TUI opens and you'll see a session list on the left with your coordinator agent ready to go. Type your prompt:

```text
Analyze the codebase at ./src — find bugs, run tests, and review code quality
```

The coordinator reads your project structure, then spawns three specialist agents. You'll see them appear in the session list in real time.

### CLI Options

You can customize the launch with flags:

```bash
npx pilotswarm \
  --env .env \
  --plugin ./test-swarm-plugin \
  --workers 4 \
  --model gpt-4o
```

| Flag | Short | Description |
|------|-------|-------------|
| `--env <file>` | `-e` | Path to environment file with tokens and database URL |
| `--plugin <dir>` | `-p` | Path to the plugin directory |
| `--workers <count>` | `-n` | Number of worker threads (default: 1) |
| `--model <name>` | `-m` | LLM model to use |
| `--store <url>` | `-s` | Database connection URL (overrides env) |

For larger codebases, increase the worker count with `-n 4` so multiple agents can execute LLM turns concurrently.

### Worker Configuration

The CLI manages workers for you, but understanding the configuration helps when scaling up:

| Setting | CLI Flag | Env Var | Default | Description |
|---------|----------|---------|---------|-------------|
| Workers | `--workers` / `-n` | `WORKERS` | 4 | Concurrent LLM execution threads |
| Model | `--model` / `-m` | `COPILOT_MODEL` | From `model_providers.json` | LLM model for new sessions |
| Plugin dir | `--plugin` / `-p` | `PLUGIN_DIRS` | none | Plugin directory to load |
| Database | `--store` / `-s` | `DATABASE_URL` | from env | PostgreSQL connection URL |
| Log level | `--log-level` | `LOG_LEVEL` | `error` | Trace verbosity (`error`, `warn`, `info`, `debug`) |
| System prompt | `--system` | `SYSTEM_MESSAGE` | from plugin default | Base system message (path or inline) |

In **local mode**, these configure the embedded workers. In **remote mode** (`npx pilotswarm remote`), the TUI is a lightweight client — workers run separately and are configured via their own environment:

```bash
# Remote worker environment (.env on the worker machine)
DATABASE_URL=postgres://your-shared-db:5432/pilotswarm
GITHUB_TOKEN=ghp_...
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;...
PLUGIN_DIRS=./test-swarm-plugin
LOG_LEVEL=info
```

Blob storage (`AZURE_STORAGE_CONNECTION_STRING`) is required for remote mode — it enables session dehydration so sessions can migrate between workers. Without it, sessions are pinned to the worker that created them.

## Watching It Work in the TUI

The TUI is where the magic becomes visible. Once the coordinator spawns its specialists, the session list shows each sub-agent with status icons indicating their state:

- **Running** — the agent is actively executing an LLM turn or tool call
- **Waiting** — the agent is idle, waiting for input or for a child to complete
- **Completed** — the agent has finished its work

### TUI Keybindings

| Key | Action |
|-----|--------|
| `j` / `k` | Navigate up/down through the session list |
| `Enter` | Switch to the selected session's conversation view |
| `Tab` | Cycle between panes (session list, chat, logs) |
| `m` | Cycle through log display modes |
| `?` | Show the keybinding help modal |
| `Esc` → `q` | Quit the TUI |

Use `j`/`k` to scroll through the session list and `Enter` to jump into any agent's conversation. You can watch the analyzer scanning files, the test runner executing your test suite, and the reviewer flagging issues — all happening in parallel. Press `Tab` to switch to the log pane for a lower-level view of tool executions and orchestration events.

When all specialists complete, the coordinator compiles their findings into a final artifact. The durable execution runtime ensures that if anything crashes mid-run — your machine restarts, a network blip kills a connection — the swarm picks up exactly where it left off. Sessions are check-pointed to PostgreSQL, so no work is lost.

## Going Further

### Remote Mode

For large-scale analysis or production use, run in **remote mode**. In this setup, the TUI is a lightweight client and workers run separately — on Kubernetes, on other machines, wherever you need them:

```bash
npx pilotswarm --env .env --plugin ./test-swarm-plugin --store postgres://your-remote-db:5432/pilotswarm
```

Deploy workers on Kubernetes using the provided deployment manifests. The workers connect to the same database and pick up orchestration tasks automatically. See [Deploying to AKS](deploying-to-aks.md) for the full walkthrough.

### Adding MCP Servers

Need your agents to interact with external services — GitHub, Jira, a custom API? Add an `.mcp.json` file to your plugin directory:

```json
{
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

MCP (Model Context Protocol) servers expose external tools that your agents can call. Add the tool names to your agent's `tools` list in the frontmatter, and they'll be available alongside the built-in tools.

### Extending the Swarm

The pattern scales naturally. Want to add a security auditor? Create `agents/security.agent.md` with tools and prompts focused on vulnerability scanning. Want a documentation generator? Add `agents/doc-gen.agent.md` that reads source and produces API docs. Update the coordinator's prompt to spawn the new specialists, and the swarm grows.

You can also add more skills to enrich your agents' knowledge. Create additional directories under `skills/` with domain-specific `SKILL.md` files — framework-specific best practices, your team's style guide, or architecture decision records.

For a deeper look at how plugins, agents, and skills are structured, see the [Plugin Architecture Guide](plugin-architecture-guide.md).

---

## What's Next

In the next post, [Building a Travel Event Scanner with the PilotSwarm SDK](blog-travel-event-scanner-sdk.md), we'll move from the CLI to the programmatic SDK — building an application that uses PilotSwarm as a library to orchestrate agents that monitor travel deals and events in real time. Same durable runtime, different interface.

---

*PilotSwarm is open source. The durable execution runtime is powered by [duroxide](https://github.com/microsoft/duroxide), providing crash recovery, session dehydration, and multi-node scaling out of the box.*

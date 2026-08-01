# Building an Agent Package for PilotSwarm

> **Point your coding assistant (Copilot / Claude / …) at this file.** It is a
> complete, self-contained recipe for authoring an agent package that uploads
> to PilotSwarm and passes validation on the first try. Every schema, rule,
> and error listed here mirrors the actual validator
> (`packages/sdk/src/agent-package-format.ts`); when in doubt, that file wins.

An **agent package** is a folder of files that teaches a PilotSwarm
deployment new capabilities — without rebuilding or restarting anything.
Publish it and every worker in the fleet installs it within ~20 seconds; users
can immediately create sessions bound to its agents.

A package can ship four kinds of artifact, all optional except the manifest:

| Artifact | What it is | Runs where |
|---|---|---|
| **Agents** (`*.agent.md`) | A named persona: prompt + declared tools/skills/MCP servers | Sessions bind to it by name |
| **Skills** (`SKILL.md` dirs) | Reference text preloaded verbatim into an agent's context | Inlined into the prompt |
| **Worker tools** (`worker-module.js`) | Real JavaScript executed server-side on the worker | Worker process |
| **MCP servers** (`.mcp.json` + sources) | stdio/http MCP servers the agent can call | Spawned per session |

---

## 1. The shortest valid package

```
my-kit/
├── plugin.json                  # REQUIRED — the manifest
└── agents/
    └── greeter.agent.md         # one agent
```

`plugin.json` (identity is required; everything else has defaults):

```json
{
    "name": "my-kit",
    "version": "0.1.0",
    "description": "One-line summary shown in package listings."
}
```

- `name` — **DNS label**: lowercase letters, digits, hyphens; no dots,
  underscores, capitals, or leading/trailing hyphen. Globally unique per
  deployment. It becomes the namespace shown next to your agents.
- `version` — **concrete semver** (`1.2.3` or `1.2.3-dev.1`). No ranges, no
  `v` prefix. `name@version` is the immutable identity (see §7).
- `description` — strongly recommended; listings are blank without it.

## 2. plugin.json is the manifest — two layout modes

**Convention mode** (no layout fields): artifacts are discovered at fixed
paths relative to `plugin.json`:

```
my-kit/
├── plugin.json
├── agents/*.agent.md            # every agent, one file each
├── skills/<name>/SKILL.md       # one directory per skill
├── .mcp.json                    # MCP server catalog
├── mcp-servers/**               # stdio MCP server sources
└── tools/worker-module.js       # the single worker-tool entry point
```

**Manifest mode**: declare the layout explicitly and put files wherever you
like. Every path is relative to `plugin.json`; declaring **any** layout field
switches the package to manifest mode, and then **only declared artifacts
ship** (plus the manifest itself):

```json
{
    "name": "my-kit",
    "version": "0.1.0",
    "description": "…",
    "agents":     ["src/prompts/greeter.agent.md"],
    "skills":     ["kb/style-guide"],
    "mcpConfig":  "src/mcp.config.json",
    "mcpServers": ["src/servers/lookup.js"],
    "tools":      "src/worker-tools.js",
    "include":    ["README.md"]
}
```

| Field | Type | Points at |
|---|---|---|
| `agents` | `string[]` | `.agent.md` **files** |
| `skills` | `string[]` | skill **directories** (each contains `SKILL.md`) |
| `mcpConfig` | `string` | the MCP catalog JSON file |
| `mcpServers` | `string[]` | MCP server source files or directories |
| `tools` | `string` | the worker-module JS file |
| `include` | `string[]` | extra files/dirs shipped verbatim (README, fixtures) |

Rules: relative paths only (`..`, absolute paths, and escapes are rejected);
a listed-but-missing file is a **hard error**; two entries may not collide on
the same basename. At publish the artifacts are staged into the convention
layout above and `plugin.json` is rewritten with the canonical paths — the
published tarball always has one canonical shape regardless of how you
authored it.

## 3. Agents — `*.agent.md`

YAML frontmatter + markdown body. **The body IS the agent's system prompt**
and must not be empty.

```markdown
---
name: greeter
description: Greets people and demonstrates this package.
schemaVersion: 2
version: 0.1.0
title: Greeter
tools:
  - roll_dice
skills:
  - style-guide
mcpServers:
  - lookup-mcp
---

# Greeter

You are the Greeter. When greeted, respond warmly and offer to roll dice.
When asked to roll dice, CALL the roll_dice tool — never simulate output.
```

Frontmatter fields:

| Field | Required | Meaning |
|---|---|---|
| `name` | yes (else derived from filename) | How sessions bind to the agent (`create_session {agent: "greeter"}`). Matched case/punctuation-insensitively. |
| `description` | recommended | Shown in the agent picker/catalog. |
| `schemaVersion` | recommended: `2` | Only `1` and `2` are accepted. |
| `version` | recommended | Informational agent version. |
| `title` | optional | Display title. |
| `tools` | optional | Names of worker tools this agent may call — from this package's worker module or the deployment's built-ins. Omit for prompt-only agents. |
| `skills` | optional | Skill names to preload into the prompt (see §4). |
| `mcpServers` | optional | Server names from this package's MCP catalog (§6). |
| `inheritDefaultMcpServers` | optional | Also attach the deployment's default MCP servers. |
| `initialPrompt` | optional | Auto-sent first message when a session starts blank. |

**Rejected at validation**: `system: true` (background agents belong to the
deployment), an agent named `default`, names colliding with a built-in agent
(the check is case/punctuation-insensitive and also strips a trailing
"agent"), and two agents in one package whose names normalize identically.

## 4. Skills — `skills/<name>/SKILL.md`

```markdown
---
name: style-guide
description: House style for responses.
---

# Style Guide

1. Be concise.
2. Attribute quotes.
```

- The frontmatter `name` is what agents reference in their `skills:` list
  (it may differ from the directory name; the loader keys by frontmatter).
- The **whole body is inlined into the agent's prompt** at load time as
  `[PRELOADED SKILL: <name>]` — treat it as always-visible context, not
  lazily-fetched documentation. Keep it short and load-bearing.
- Every subdirectory of `skills/` must contain a parseable `SKILL.md`;
  stray directories fail validation.

## 5. Worker tools — `tools/worker-module.js`

Real code executed on the worker. The exact contract (copy this shape):

```js
/**
 * Export default { createTools({ workerNodeId }) => [tool, …] }.
 * Tools are plain objects: { name, description, parameters, handler }.
 */
export default {
    createTools: ({ workerNodeId }) => [
        {
            name: "roll_dice",
            description: "Roll dice server-side. Returns each roll and the total.",
            parameters: {
                type: "object",
                properties: {
                    sides: { type: "number", description: "Faces per die (default 6)" },
                    count: { type: "number", description: "How many dice (default 1, max 20)" },
                },
            },
            handler: async ({ sides = 6, count = 1 } = {}) => {
                const faces = Math.max(2, Math.min(1000, Math.floor(sides)));
                const dice = Math.max(1, Math.min(20, Math.floor(count)));
                const rolls = Array.from({ length: dice }, () => 1 + Math.floor(Math.random() * faces));
                return { rolls, total: rolls.reduce((a, b) => a + b, 0), rolledOn: workerNodeId };
            },
        },
    ],
};
```

- `parameters` is a JSON-Schema object; `handler` is async and returns a
  JSON-serializable value.
- **No bare imports.** The module loads from an install cache with no
  `node_modules` above it — `import x from "some-pkg"` fails at load and
  quarantines the package. `node:` built-ins are fine; anything else must be
  vendored inside the package (discouraged — export plain objects instead).
- The file must be valid **ES module** syntax; it is compile-checked (never
  executed) at validation.
- An agent only sees a tool if the tool's `name` appears in the agent's
  frontmatter `tools:` list.

## 6. MCP servers — `.mcp.json` + `mcp-servers/`

`.mcp.json` maps server names to configs. Each server needs `command`
(stdio) **or** `url` (http/sse):

```json
{
    "lookup-mcp": {
        "command": "node",
        "args": ["./mcp-servers/lookup.js"],
        "tools": ["*"]
    },
    "remote-api": {
        "url": "https://mcp.example.com/sse"
    }
}
```

- stdio `command`/`args` paths resolve inside the unpacked package — ship
  the server source in `mcp-servers/` and reference it with a relative path.
- `${VAR}` placeholders expand from the worker's environment at load time,
  never at validation.
- Server JS in `mcp-servers/` is syntax-checked like the worker module, and
  the same no-bare-imports rule applies.
- Agents opt in by listing the server name under `mcpServers:`.

## 7. Versioning and immutability

- **`name@version` is immutable.** Re-publishing the same version with
  different content is **hard-rejected** — there is no `--replace`. Bump the
  version instead; use prerelease semvers (`0.2.0-dev.1`, `-dev.2`, …) for
  the edit-test loop, then publish the clean release version.
- Publishing byte-identical content to the same version is a no-op (safe to
  retry).
- Every upload is normalized to a canonical tarball and hashed; the sha you
  see in the UI identifies the exact content.

## 8. Hard limits and forbidden content

| Rule | Limit / behavior |
|---|---|
| Compressed size | 16 MB max (portal **folder-upload** envelope: 2 MB) |
| `node_modules` vendored | warning above 2 MB — keep packages dependency-light |
| Symlinks | rejected |
| Non-ASCII file paths | rejected (rename to ASCII) |
| `session-policy.json` | rejected — session policy belongs to the deployment |
| `system: true` agents | rejected |
| Agent named `default` | rejected |
| Names colliding with built-in agents | rejected |

## 9. Validate locally, then upload

**Validate before uploading** (offline, prints every error verbatim):

```sh
pilotswarm agents validate ./my-kit
```

**Upload — any of these paths:**

1. **CLI**: `pilotswarm agents push ./my-kit --shared` (or `--user`).
2. **Portal**: Admin Console → **Agents** → **+ Add package**:
   - **GitHub / Azure DevOps** — paste the browser link to `plugin.json`
     (or the folder containing it); the branch and path are read from the
     link. **Your browser** reads the repo with **your** access — public
     GitHub needs no credential, Azure DevOps uses your signed-in account,
     and a PAT is only needed for private GitHub (used for that import
     only, never stored). The files are then published through the normal
     package-artifact upload, so nothing about the repo is kept server-side.
   - **Upload folder** — pick the folder in the browser (≤ 2 MB).

   Both portal paths are a point-in-time **import**, not a subscription: to
   ship an update, bump the version and import again (or use the CLI).
3. **MCP** (for assistants driving PilotSwarm): the `push_agent_package`
   tool takes inline base64 files, ≤ 2 MB total.

**Scopes**: `shared` = every user sees and can use the agents; `user` = only
you. Promote/demote later from the package detail page; running sessions are
never affected by scope changes.

## 10. What happens after publish

- Every worker notices the registry change on its next poll (~20 s) and
  installs the new version **without restarting** — watch fleet adoption on
  the package detail page ("N/N workers current").
- A broken package (bad import, runtime throw at load) is **quarantined
  alone**: its agents disappear, the error lands in the fleet view, and
  every other package keeps working.
- Users bind to your agent with its name (`create_session {agent: "greeter"}`
  via MCP, the portal's agent picker, or the TUI). The package name appears
  as the agent's namespace.
- Disabling or deleting a package removes its agents fleet-wide on the next
  poll; sessions already running fail their next turn's agent resolution.
- Every publish path — CLI, portal import, portal folder upload, MCP —
  converges on the same mechanism: files are validated, canonically packed,
  and stored as a package artifact. There is no server-side repo polling.

## 11. Complete worked example

The live reference package is `demo-agent-kit` (published on the demo
deployment): one agent (`kit-navigator`) wired to two worker tools
(`roll_dice`, `kit_info`), one preloaded skill (`fortune-craft`), and one
stdio MCP server (`fortune-mcp`) — in manifest mode:

```
demo-agent-kit/
├── plugin.json                      # manifest: identity + explicit layout
├── agents/kit-navigator.agent.md    # prompt references all three surfaces
├── skills/fortune-craft/SKILL.md    # contains a codeword to prove preloading
├── mcp-servers/fortune-server.js    # stdio MCP server source
├── tools/worker-module.js           # the §5 contract, two tools
├── .mcp.json                        # { "fortune-mcp": { command, args } }
└── README.md                        # shipped via "include"
```

A good smoke test for any new package, in a session bound to your agent:
ask it to use each surface once — a worker tool call, a fact only the skill
contains, and an MCP tool call — and confirm none of the answers are
hallucinated (the demo kit's tools return the executing `workerNodeId` for
exactly this reason).

### A multi-agent package you can read in this repo

[`examples/agent-packages/finance-research-lab/`](../examples/agent-packages/finance-research-lab/)
is a larger package checked into this repository, so it needs no deployment
to study: a lead agent that coordinates five specialists over six shared
worker tools, plus two skills — also in manifest mode:

```
finance-research-lab/
├── plugin.json                                # manifest: six agents, two skills
├── agents/finance-research-lead.agent.md      # coordinator for the five below
├── agents/equity-fundamentals.agent.md
├── agents/valuation-analyst.agent.md
├── agents/market-catalyst-scout.agent.md
├── agents/investment-risk-auditor.agent.md
├── agents/macro-sector-strategist.agent.md
├── skills/finance-research-standards/SKILL.md
├── skills/valuation-methods/SKILL.md
├── tools/worker-module.js                     # the §5 contract, six tools
└── README.md                                  # shipped via "include"
```

It shows two things a single-agent kit cannot: several agents sharing one
worker module while each declaring a different subset of its tools, and
skills scoped to the agents that need them rather than to the package (only
the valuation-facing agents preload `valuation-methods`). It ships no MCP
server, so it is also the smaller of the two starting points. Its only
external configuration is `SEC_USER_AGENT`, which the SEC's fair-access
policy requires of automated callers.

## 12. Checklist for assistants

Before telling the user the package is ready:

- [ ] `plugin.json` has DNS-label `name`, concrete-semver `version`, and a `description`.
- [ ] Manifest mode: every declared path exists; nothing needed is undeclared. Convention mode: files sit at the fixed paths in §2.
- [ ] Every `.agent.md` has a non-empty body, `schemaVersion: 2`, and a unique, non-reserved name.
- [ ] Agent `tools:` names exactly match the worker module's tool `name`s; `skills:` match SKILL.md frontmatter names; `mcpServers:` match `.mcp.json` keys.
- [ ] `worker-module.js` and `mcp-servers/*.js` are valid ESM with **no bare imports**.
- [ ] `pilotswarm agents validate ./my-kit` prints no errors.
- [ ] Version bumped if this `name@version` was ever published with different content.

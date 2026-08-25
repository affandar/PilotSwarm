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
  underscores, capitals, or leading/trailing hyphen. Unique per
  `(scope, owner)` — **not** deployment-wide, so you and the shared
  deployment can both publish a `triager` (§9). A leading `__` is reserved
  for the platform and rejected. It becomes the namespace shown next to your
  agents.
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
- Agents opt in by listing the server name under `mcpServers:`, and an agent
  that does so must declare `schemaVersion: 2` (validator error
  `mcp_requires_schema_v2`).
- A reference to a server the package does not define is a warning
  (`unknown_mcp_server`): it must exist in the deployment catalog, or the
  reference is dropped at load.

Two fields are **deployment-catalog only** and rejected in a package
`.mcp.json`:

- `"default": true` (`mcp_default_forbidden`) — it would add the server to
  every agent that inherits the deployment default set.
- `"allowedAgents"` (`mcp_allowed_agents_forbidden`) — only a deployment may
  restrict who uses a server.

### Using a server the deployment restricts

A deployment can restrict one of its own catalog entries to named agents:

```json
{
    "icm-mcp-rw": {
        "type": "stdio", "command": "node", "args": ["/app/plugin/mcp/icm-proxy.mjs"],
        "allowedAgents": ["ops-analyst", "rcakit:rcakit-cosmosdb"],
        "tools": ["*"]
    }
}
```

Entries are agent identities: a bare `name` is a deployment (baked) agent;
`namespace:name` is the agent `name` from the plugin or package whose
namespace is `namespace` — for a package, its `plugin.json` name. A package
agent matches only the **shared** copy of the package; a user-scope copy is
a different package and never inherits the grant. Any other reference to a
restricted server is dropped at load with a warning, and restricted servers
never join the default set. The catalog is flat, so a package cannot define
a server with **any** name the deployment catalog already uses — restricted
or not (`reserved_mcp_server_name` at publish; workers drop such a
definition at load). Pick your own server names.

## 7. Versioning and immutability

- **`name@version` is immutable.** Re-publishing the same version with
  different content is **hard-rejected** — there is no `--replace`. Bump the
  version instead; use prerelease semvers (`0.2.0-dev.1`, `-dev.2`, …) for
  the edit-test loop, then publish the clean release version.
- Publishing byte-identical content to the same version is a no-op (safe to
  retry).
- Every upload is normalized to a canonical tarball and hashed; the sha you
  see in the UI identifies the exact content.
- **Ship a `CHANGELOG.md`.** It lives inside the package, so it is versioned,
  diffable, and travels with the artifact; the portal and TUI render it on the
  package detail page. The Agent Manager (§11) refuses to publish a version
  that has no entry, and signs its own entries with the approver's name —
  which is how a reader tells an agent edit from a human `agents push`.

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

   ```sh
   pilotswarm auth login --api-url https://<your-portal>
   export PILOTSWARM_API_URL=https://<your-portal>   # or pass --api-url
   pilotswarm agents push ./my-kit --shared
   ```

   No database credentials: your own sign-in decides what you may publish.
   §11 covers the rest of the lifecycle — updating, inspecting, pinning,
   disabling, deleting — and the ≤ 2 MB upload envelope.
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

**Scopes and namespaces**: `shared` = every user sees and can use the agents;
`user` = only you. Package identity is `(scope, owner, name)`, so the first
person to publish `triager` does not own that word for the whole deployment.
Where both exist, **your own enabled copy shadows the shared one** — which is
also the recovery path: disable your personal copy and the shared one takes
over, with no other action. Promote/demote later from the package detail page;
running sessions are never affected by scope changes.

## 10. What happens after publish

- Every worker notices the registry change on its next poll (~20 s) and
  installs the new version **without restarting** — watch fleet adoption on
  the package detail page ("N/N workers current").
- A broken package (bad import, runtime throw at load) is **quarantined
  alone**: its agents disappear, the error lands in the fleet view, and
  every other package keeps working.
- Users bind to your agent with its name (`create_session {agent: "greeter"}`
  via MCP, the portal's agent picker, or the TUI). The package name appears
  as the agent's namespace. A bare name resolves to **your own enabled copy
  first, then the shared one**; these forms reach past that default:

  | Form | Resolves to |
  |---|---|
  | `<package>` | your own enabled copy, else the deployment's |
  | `__shared:<package>` | the deployment-wide copy, explicitly |
  | `<owner>:<package>` | a named owner's copy |
  | `<any of the above>:<semver>` | pinned to one version |

  `__` is reserved at the database for both package names and user subjects,
  so `__shared` cannot be minted by a user. A bare two-segment `a:b` keeps its
  long-standing reading as `namespace:agent` first, and is only tried as
  `owner:package` after that.
- Disabling or deleting a package removes its agents fleet-wide on the next
  poll; sessions already running fail their next turn's agent resolution.
- Every publish path — CLI, portal import, portal folder upload, MCP —
  converges on the same mechanism: files are validated, canonically packed,
  and stored as a package artifact. There is no server-side repo polling.

## 11. Managing a published package from the CLI

Every registry operation is available from the terminal. The CLI talks to a
deployment's Web API, so your own sign-in decides what you may see and change
— no database credentials anywhere.

**Getting the CLI** (full detail, including corporate-network fallbacks:
[Getting Started → Installing the CLI on its own](./quickstart/local.md#installing-the-cli-on-its-own)):

```sh
npm install -g pilotswarm

# Blocked from registry.npmjs.org? Use your mirror, or fetch the tarball:
npm install -g pilotswarm --registry https://<your-npm-mirror>/
curl -fL -o pilotswarm.tgz https://registry.npmjs.org/pilotswarm/-/pilotswarm-<version>.tgz
npm install -g ./pilotswarm.tgz
```

To use subcommands that have not been published yet, run the repo entry point
instead: `node /path/to/pilotswarm/packages/app/tui/bin/tui.js agents …`.

**Signing in:**

```sh
pilotswarm auth login --api-url https://<your-portal>   # once; the token is cached
export PILOTSWARM_API_URL=https://<your-portal>         # or pass --api-url each time
```

**The three you need most:**

```sh
pilotswarm agents push ./my-kit --user      # upload (--shared to publish to everyone)
pilotswarm agents push ./my-kit             # update: bump plugin.json "version" first
pilotswarm agents rm my-kit --yes           # delete every version and its artifacts
```

Updating is the same command as uploading — the version in `plugin.json` is
what makes it a new release (§7). Re-pushing an unchanged version is a no-op
("already up to date"), not an error, so a push in a script is safe to repeat.
`rm` refuses without `--yes`.

**The rest of the surface:**

| Command | What it does |
|---|---|
| `agents list` | Packages visible to you: shared, plus your own user-scope ones |
| `agents show <name>` | Version history, scope, owner, active version |
| `agents tree <name>` | The published file list — what actually shipped |
| `agents cat <name> <file>` | One file's contents from the package |
| `agents pin <name>@<semver>` | Roll the active version back or forward |
| `agents enable\|disable <name>` | Turn a package off fleet-wide without deleting it |
| `agents promote\|demote <name>` | Move between `shared` and `user` scope |
| `agents validate <dir>` | Offline check; no deployment needed |

`tree` and `cat` take `--semver <v>` to inspect a version other than the
active one — useful for confirming what a release actually contains before
pinning to it. `list` and `show` take `--json`.

**Two things to know:**

- **Only what the manifest declares is uploaded.** In manifest mode the CLI
  publishes exactly the staged tree, so a `scratch/`, `docs/`, or `.git`
  directory sitting beside `plugin.json` is neither uploaded nor counted
  against the size limit. Use `agents tree` after publishing to confirm.
- **Web upload is capped at ≤ 2 MB**, the same envelope as the portal and MCP
  paths. A larger package needs `--store <postgres-url>` (which packs up to
  16 MB compressed). That path talks to the datastore directly and **bypasses
  authentication and authorization entirely** — operator break-glass, not a
  normal path. It announces itself on stderr whenever it engages, including
  when it is selected by a `DATABASE_URL` left in your shell.

**Or let an agent do it.** The `agent-manager` package (in `agent-packages/`
in this repo) installs an agent that reads, edits and ships packages on your
behalf: it diagnoses a misbehaving session, stages an edit seeded from the
bytes actually running, renders the change as reviewable `.patch` artifacts,
and publishes a new version only once a human approves. It can also author a
package from scratch. Importing from a URL reaches only origins the
deployment has allowlisted in `.agent_packages.json`, so a URL injected into a
transcript it is reading cannot be fetched at all.

## 12. Complete worked example

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

### An offline package with all four artifact kinds

[`examples/agent-packages/editorial-desk/`](../examples/agent-packages/editorial-desk/)
is the example to copy when you want every surface at once, in **convention
mode**, with no credentials and no network:

```
editorial-desk/
├── plugin.json                             # identity only — no layout fields
├── agents/editor-in-chief.agent.md         # coordinator; self-starting, with splash art
├── agents/structure-editor.agent.md
├── agents/line-editor.agent.md
├── agents/caveman-editor.agent.md          # optional compression pass
├── skills/editorial-standards/SKILL.md     # the map — the rulebook lives in MCP
├── tools/worker-module.js                  # the §5 contract, seven tools
├── .mcp.json                               # { "style-desk": { command, args } }
├── mcp-servers/style-desk.js               # the §6 contract, hand-rolled JSON-RPC
└── README.md                               # shipped automatically in convention mode
```

Four things it demonstrates that the other two do not:

- **Convention mode.** `plugin.json` carries identity only; every artifact is
  found at its fixed path (§2), and files like `README.md` ship without being
  declared.
- **A stdio MCP server shipped inside the package.** Because package code
  loads from an install cache with no `node_modules` above it,
  `@modelcontextprotocol/sdk` is not importable — `mcp-servers/style-desk.js`
  speaks the MCP stdio transport directly (newline-delimited JSON-RPC 2.0 over
  stdin/stdout) using only Node built-ins. Copy it as the starting point for
  any in-package MCP server.
- **The skill/MCP split, deliberately.** The preloaded skill holds the map
  because it costs prompt space on every turn; the full rulebook, the format
  checklists, and the preferred-term list sit behind MCP and are fetched only
  when needed.
- **Model transforms, code verifies.** The optional caveman pass has the model
  do the compressing, but a worker tool masks every protected region first so
  code, URLs, paths, and numbers return byte-identical, and a second worker
  tool *errors* if any of them went missing. When a capability cannot be made
  deterministic, this is the shape to reach for.

Every tool in it is deterministic and offline, so the same input always
produces the same numbers — which is what lets it double as a smoke test.

## 13. Checklist for assistants

Before telling the user the package is ready:

- [ ] `plugin.json` has DNS-label `name`, concrete-semver `version`, and a `description`.
- [ ] Manifest mode: every declared path exists; nothing needed is undeclared. Convention mode: files sit at the fixed paths in §2.
- [ ] Every `.agent.md` has a non-empty body, `schemaVersion: 2`, and a unique, non-reserved name.
- [ ] Agent `tools:` names exactly match the worker module's tool `name`s; `skills:` match SKILL.md frontmatter names; `mcpServers:` match `.mcp.json` keys.
- [ ] `worker-module.js` and `mcp-servers/*.js` are valid ESM with **no bare imports**.
- [ ] `pilotswarm agents validate ./my-kit` prints no errors.
- [ ] Version bumped if this `name@version` was ever published with different content.
- [ ] `CHANGELOG.md` has an entry for the version being published (§7).
- [ ] After publishing: `pilotswarm agents tree <name>` shows exactly the files you intended — no stray directories, nothing missing (§11).

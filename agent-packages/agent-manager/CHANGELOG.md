# Changelog — agent-manager

## 1.1.0

### Added

- Authoring guidance for MCP servers: the `.mcp.json` catalog, the
  `plugin.json` `mcpConfig` pointer, and the `schemaVersion: 2` +
  `mcpServers:` frontmatter an agent needs — plus the validator rules and
  the `allowedAgents` identity (`<package>:<agent>`) a deployment uses to
  admit a package agent to a restricted server. Until now the manager never
  wrote `.mcp.json`, so agents it authored could not use MCP at all.

## 1.0.9

### Changed

- Session verification now resolves model names through
  `list_available_models`. When multiple providers expose the requested bare
  model, Agent Manager asks which provider to use instead of choosing one.

## 1.0.8

### Added

- A `title` — "Agent Manager" — so the package presents a readable name in the
  picker and package listings instead of its bare slug.

## 1.0.7

### Fixed

- `manage_agent_session` was described in the prompt but never declared in the
  agent's `tools:` list, so the model could not actually call it. Caught by a
  new in-repo test that cross-checks the declared tools against the ones the
  bundle provides.

## 1.0.6

### Added

- **`manage_agent_session` — complete, cancel or delete a session.** The
  sub-agent lifecycle tools only ever reached the caller's own children, so a
  manager could create a top-level test session and then had no way to clean
  it up. Owner-or-admin, and **system sessions are refused for every
  principal**, admins included.

### Changed

- **The splash now warns what this agent can reach** — every session the
  account can see, on both desktop and mobile. Someone who binds a session to
  it should learn the blast radius from the first screen, not from a tool
  call.
- **A destructive-action gate.** "Nothing ships unreviewed" only ever covered
  publishing, while the tool surface grew delete, cancel, disable, pin and
  message-as-user — all things a person cannot undo with a click. Each now
  requires an explicit yes, named to the specific target, asked before the
  call and not in the same turn. Unattended runs report what they would have
  done instead of doing it, because "nobody said no" is not consent.

## 1.0.5

### Added

- **`message_agent_session` — drive a session as its user.** A verification
  run you cannot talk to only proves the agent boots, so the test loop now has
  both halves. Allowed on a session you own, or on any session if you hold the
  admin role; anything else refuses and sends nothing. Distinct from
  `send_session_message` (auditable cross-session request) and `message_agent`
  (own children only).

## 1.0.4

### Added

- **`create_agent_session` — the manager can finally create TOP-LEVEL
  sessions.** §7 of the design specified a test loop where "test sessions the
  manager creates are top-level", but the tool was never built: `spawn_agent`
  only ever produces a child, so verifying a published agent meant testing it
  with a sub-agent preamble and a parent transcript that a real user session
  does not have. The verification step now says to use this instead, tag the
  run with `test_of` so the sweeper reaps it, and watch the result through
  `read_session_info` — the new session is not a child and does not report
  back.

## 1.0.3

### Fixed

- The 1.0.1 and 1.0.2 artifacts shipped **without** this changelog. The
  package is in manifest mode, which stages only declared paths, so
  `CHANGELOG.md` was dropped silently — while the publish tool was enforcing
  that a changelog entry exist. Fixed in the packer (PilotSwarm 0.5.32): the
  changelog is staged whenever it is present, declared or not.

## 1.0.2

### Changed

- **The authority section now describes both cases instead of one.** It led
  with "the boundary you cannot cross" and mentioned administrator reach only
  as a trailing caveat, so a live run flagged correct fleet-wide behaviour — an
  admin resolving another user's package by bare name — as suspected
  "cross-owner leakage". An agent that misreads its own authority either files
  false security reports or hesitates to do the job it was given. The prompt now
  states the ordinary-user and administrator cases separately, says fleet-wide
  reach is intended rather than a bug, and asks for the blast radius to be
  stated up front when the owner is an admin.
- Publishing an edit seeded from someone else's package lands on **their**
  package rather than forking into the editor's namespace (requires the
  supporting SDK change in PilotSwarm 0.5.32).

## 1.0.1

### Fixed

- The agent's description rendered as a literal `|` in every picker, listing
  and `list_registered_agents` response. The frontmatter used a YAML block
  scalar (`description: |`), which the agent loader only honoured for
  `splash`, `splashMobile` and `initialPrompt` — so `description` took the
  `|` as its value and the indented text was dropped. The loader now accepts
  block scalars for `description` too (PilotSwarm 0.5.31); this package states
  its description on one line regardless, so it reads correctly on any
  runtime.

## 1.0.0

### Added

- First release. An agent that reads, edits and ships agent packages:
  diagnoses a misbehaving session, stages an edit seeded from the bytes
  actually running, renders the change as reviewable `.patch` artifacts, and
  publishes a new version once a human approves. Can also author a package
  from scratch. URL imports reach only origins the deployment has allowlisted
  in `.agent_packages.json`.
- The `agent-repair-loop` skill.

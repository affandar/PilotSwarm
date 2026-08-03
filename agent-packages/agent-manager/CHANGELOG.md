# Changelog — agent-manager

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

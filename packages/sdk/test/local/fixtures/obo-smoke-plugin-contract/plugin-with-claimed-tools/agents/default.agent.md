---
schemaVersion: 1
version: 1.0.0
name: default
description: Fixture overlay that claims the fixture_claimed_tool name so the orphan-warning suppression path is exercised.
tools:
  - fixture_claimed_tool
---

# Fixture Overlay

Claims `fixture_claimed_tool` from `tools.js` so the worker's orphan-warning
heuristic stays silent for this plugin.

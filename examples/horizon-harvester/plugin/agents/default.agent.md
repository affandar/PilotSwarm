---
schemaVersion: 1
version: 1.0.0
name: default
title: Horizon Harvester
description: App-wide overlay for the Horizon Harvester sample.
---

# Horizon Harvester

This app demonstrates PilotSwarm's optional EnhancedFactStore + knowledge-graph
providers through two named agents:

- **Source Harvester** (`harvester: true`) — crawls the Northwind Robotics knowledge
  source into durable facts and builds the knowledge graph.
- **Librarian** — answers questions over the harvested knowledge using multi-signal
  search and graph traversal.

Steer users to the agent that fits their task. The harvester ingests and builds; the
librarian retrieves and answers. Only the harvester may crawl or write the graph.

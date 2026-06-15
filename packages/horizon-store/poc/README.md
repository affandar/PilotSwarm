# PoCs — Enhanced Facts on HorizonDB

Each PoC validates one capability against a **real HorizonDB instance**. They
are deliberately ordered to match the phased plan in [../SPEC.md](../SPEC.md).
None of them touch a PilotSwarm database — they create an isolated PoC schema.

## Prerequisites

```bash
cp ../.env.example ../.env
# edit ../.env → HORIZON_DATABASE_URL pointing at a HorizonDB (preview) instance
npm install        # from the package root
```

## PoCs

| Script | Phase | Validates | Requires |
| --- | --- | --- | --- |
| `01-lexical.mjs` | P1 | pg_textsearch ranked recall vs `LIKE`; ACL clause composes | pg_textsearch |
| `02-semantic.mjs` | P2 | embedding column + ANN recall; embed pipeline drains backlog | AI pipelines, vector |
| `03-graph.mjs` | P3 | AGE structural backfill + lineage traversal, ACL-resolved | AGE |
| `04-hybrid.mjs` | P4 | fuse all three signals (uses src fusion) end to end | all four |

Run an individual PoC:

```bash
npm run build
npm run poc:lexical
```

## What "pass" means

Every PoC asserts the **governance invariant**: a search returns only facts the
caller could already read via the standard ACL predicate. A PoC that surfaces a
fact outside the caller's scope is a hard failure.

> These are exploration harnesses, not the integration. The decision to adopt
> any of this into PilotSwarm is separate and gated on PoC results.

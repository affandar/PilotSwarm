# Editorial Desk

A four-agent PilotSwarm package that edits drafts: a coordinating **editor in
chief**, a **structure editor**, a **line editor**, and an optional
**caveman editor** that compresses prose to the bone — backed by seven
deterministic prose tools and a house **style desk** served over MCP.

It is the example that exercises **all four artifact kinds at once** — agents,
a skill, worker tools, and an MCP server the package ships itself — in
**convention mode**, and it needs no credentials, no network, and no API keys.
Every tool result is reproducible, which is what makes the package usable as a
smoke test: the same paragraph always produces the same numbers.

The manifest, agent, skill, worker-tool, and MCP contracts it implements are
documented in
[Building an Agent Package for PilotSwarm](../../../docs/building-agent-packages.md).

## Layout

`plugin.json` declares **no layout fields**, so the package is in convention
mode and every artifact is discovered at its fixed path:

```
editorial-desk/
├── plugin.json                             # identity only — convention mode
├── agents/
│   ├── editor-in-chief.agent.md            # coordinator; self-starting, with splash art
│   ├── structure-editor.agent.md           # outline, ordering, headings
│   ├── line-editor.agent.md                # sentences, verbs, hedges, terminology
│   └── caveman-editor.agent.md             # optional extreme-compression pass
├── skills/editorial-standards/SKILL.md     # the map, preloaded into every prompt
├── tools/worker-module.js                  # seven deterministic prose tools
├── .mcp.json                               # one stdio server: style-desk
├── mcp-servers/style-desk.js               # the rulebook, checklists, preferred terms, caveman ladder
└── README.md                               # shipped automatically in convention mode
```

## What each surface is for

The package is built around one distinction that is easy to get wrong:

| Surface | Cost | Holds |
|---|---|---|
| **Skill** (`editorial-standards`) | Inlined into the prompt on **every** turn | The map: pass order, the measure-don't-assert rule, the line you never cross |
| **MCP server** (`style-desk`) | Queried on demand, spawned per session | The long tail: 18 style rules with rationale, 6 format checklists, 16 preferred terms, the caveman ladder and its guardrails |
| **Worker tools** | Executed server-side per call | Anything that must be *computed* rather than judged |

Putting the whole rulebook in the skill would burn context on every turn to
answer a question the agent asks a few times per document. Putting the pass
order in MCP would mean the agent might never look it up.

## Worker tools

All seven are pure functions over text — deterministic, offline, and free of
`node_modules`. Each result carries `analyzedOn` (the worker node id) so a
hallucinated answer is visibly distinguishable from a real one.

| Tool | Returns |
|---|---|
| `prose_lint` | Passive voice, weasel words, hedges, wordy phrases, clichés, repeated words, stray adverbs, over-long sentences — each with line, context, and a fix |
| `readability_score` | Counts, Flesch Reading Ease, Flesch–Kincaid grade, Gunning Fog, reading time, three longest sentences |
| `text_diff` | Word- or line-granular redline (`{+added+}`, `[-removed-]`) with change statistics |
| `heading_outline` | Heading tree with per-section word counts, plus skipped levels, duplicate/missing H1, empty or bloated sections, TODO markers |
| `term_consistency` | Spelling and casing drift for the terms you name, plus common pairs (email/e-mail, website/web site, …) |
| `caveman_draft` | The mechanical half of a caveman pass, with every protected region masked so it returns byte-identical |
| `caveman_check` | Errors when a conversion lost code, inline code, URLs, numbers, or headings; warns on compression anti-patterns; reports measured savings |

Agents declare different subsets: the line editor never sees `heading_outline`,
the structure editor never sees `prose_lint`, and only the caveman editor sees
the two compression tools.

## The optional caveman pass

`caveman-editor` is opt-in and runs last. It compresses prose to the bone —
articles, filler, pleasantries, and hedging go; substance stays. The style is
adapted from the [caveman project](https://github.com/juliusbrussee/caveman)
(MIT, © Julius Brussee); the rules are reimplemented here and no upstream code
is used.

What makes it more than a party trick is the division of labour, which is the
second thing this package exists to demonstrate:

- **The model compresses**, because deciding which of three restatements to
  keep is judgement, and a regex would produce garbage.
- **`caveman_draft` protects.** It masks fenced code, inline code, URLs,
  markdown links, file paths, environment variables, and version numbers before
  touching a single word, so those spans return byte-identical by construction
  rather than by the model's good intentions.
- **`caveman_check` verifies.** It *errors* when a code block changed, inline
  code vanished, a URL moved, a number or version disappeared, or the heading
  count shifted — and *warns* on bullet drift and on the anti-patterns the
  upstream project measured as pure loss: invented abbreviations (`cfg`,
  `impl`, `req`), arrows, and emoji, none of which a tokenizer rewards.

Three intensity levels — `lite` (keeps articles and full sentences), `full`
(classic caveman), `ultra` (maximum terseness) — with guardrails that force
full prose for security warnings, destructive actions, legal text, and ordered
procedures where a dropped article makes the sequence ambiguous. On the example
sentence below the mechanical pass alone removes 7%, 11%, and 35% of
characters; the model's judgement pass is where the real reduction comes from,
because restated ideas cost far more than long words do.

Token figures are reported as a `chars/4` **estimate** and labeled as one — a
worker tool has no business guessing at a model's tokenizer.

```sh
cd examples/agent-packages/editorial-desk
node --input-type=module -e '
import mod from "./tools/worker-module.js";
const T = Object.fromEntries(mod.createTools({ workerNodeId: "local" }).map((t) => [t.name, t]));
const before = "You should really make sure to run the test suite before pushing, because it helps catch bugs early.";
const { draft, savings } = await T.caveman_draft.handler({ text: before, level: "ultra" });
console.log(draft, savings.characters);
console.log(await T.caveman_check.handler({ before, after: draft }));
'
```

## The stdio MCP server

`mcp-servers/style-desk.js` is a **hand-rolled MCP server**. Package code loads
from an install cache with no `node_modules` above it, so
`@modelcontextprotocol/sdk` is not importable — the file speaks the stdio
transport directly: newline-delimited JSON-RPC 2.0 over stdin/stdout, using
only Node built-ins. Copy it as the starting point for any MCP server you want
to ship inside a package.

It exposes `list_checklists`, `get_checklist`, `lookup_style_rule`,
`preferred_term`, `caveman_rules`, and `caveman_guardrails`.

`.mcp.json` points at it with a relative path; the loader anchors a missing
`cwd` to the directory that owns `.mcp.json`, so the same config works on every
worker regardless of where the package was unpacked.

Exercise it without PilotSwarm:

```sh
cd examples/agent-packages/editorial-desk
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_checklist","arguments":{"kind":"release-note"}}}' \
  | node ./mcp-servers/style-desk.js
```

## Exercise the worker tools directly

```sh
cd examples/agent-packages/editorial-desk
node --input-type=module -e '
import mod from "./tools/worker-module.js";
const tools = Object.fromEntries(mod.createTools({ workerNodeId: "local" }).map((t) => [t.name, t]));
const text = "The report was written by the team, and it is very clearly the best-in-class solution.";
console.log(await tools.prose_lint.handler({ text }));
console.log((await tools.readability_score.handler({ text })).scores);
'
```

## Splash art alignment

The editor in chief ships `splash` and `splashMobile`. Box-drawing art only
closes if every line has the same **visible** width once markup is stripped:

```sh
cd examples/agent-packages/editorial-desk
node --input-type=module -e '
import fs from "node:fs";
const fm = fs.readFileSync("agents/editor-in-chief.agent.md", "utf8").split("---")[1];
for (const key of ["splash", "splashMobile"]) {
  const lines = fm.split(new RegExp(`^${key}: \\|$`, "m"))[1].split("\n").slice(1);
  const widths = [];
  for (const line of lines) {
    if (/^[a-zA-Z#]/.test(line)) break;
    widths.push(line.trim() ? [...line.replace(/\{\/?[a-z-]+\}/g, "")].length : 0);
  }
  console.log(key, widths.join(", "));
}'
```

## Validate and upload

From the PilotSwarm repository root:

```sh
pilotswarm agents validate ./examples/agent-packages/editorial-desk
pilotswarm agents push ./examples/agent-packages/editorial-desk --user
```

Use `--shared` instead of `--user` to publish to everyone. `name@version` is
immutable, so bump to a prerelease version (`0.1.1-dev.1`, `-dev.2`, …) before
re-uploading changed content.

## Smoke tests

Each of these forces a different surface, and each answer is checkable:

1. **Worker tool.** Start `line-editor`, paste a paragraph, and ask:
   `Lint this and score it, then edit it and show me the before/after numbers
   and a word-level redline.` The counts must come from the tools — ask it to
   quote `analyzedOn`.
2. **MCP server.** Start `structure-editor` and ask:
   `What does the incident-postmortem checklist require, and which items does
   this draft fail?` The six checklist items come from `style-desk`, not from
   the model.
3. **Preloaded skill.** Ask any agent: `What is the pass order, and why is it
   in that order?` Structure before line, because reordering after a line edit
   throws the line edit away — that reasoning is in the skill, not the prompt.
4. **Delegation.** Start `editor-in-chief` with a long, badly organized draft
   and ask for a full pass. It should spawn `structure-editor` first, then
   `line-editor` on the restructured text, and diff every child's output before
   accepting it.
5. **Opt-in compression.** Start `caveman-editor`, paste a paragraph containing
   a code block, a URL, and a percentage, and ask for `ultra`. The code, link,
   and number must come back untouched, and the agent must quote
   `caveman_check` reporting `ok: true`. Then ask `editor-in-chief` for a
   normal edit and confirm it does **not** compress anything — the pass is
   opt-in and must never fire on its own.

## Attribution

The caveman pass adapts the rules of the
[caveman project](https://github.com/juliusbrussee/caveman) by Julius Brussee,
MIT licensed. The intensity ladder, the never-invent-abbreviations finding, and
the compress-then-validate split are its ideas; the implementation here is
independent and vendors no upstream code.

## Related examples

- [`pilotswarm-tour-guide`](../pilotswarm-tour-guide/) — one agent, a **remote**
  http MCP server, self-start and splash art.
- [`finance-research-lab`](../finance-research-lab/) — six agents over live
  network data, manifest mode, skills scoped per agent.

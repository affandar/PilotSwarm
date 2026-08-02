#!/usr/bin/env node
/**
 * style-desk — a stdio MCP server shipped inside an agent package.
 *
 * Package code loads from an install cache with no `node_modules` above it, so
 * `@modelcontextprotocol/sdk` is not importable here (see
 * docs/building-agent-packages.md §5–§6). This file therefore speaks the MCP
 * stdio transport directly: newline-delimited JSON-RPC 2.0 on stdin/stdout,
 * using nothing but Node built-ins.
 *
 * Rule of the transport: **stdout carries protocol frames only.** Anything you
 * want to log goes to stderr, or the client's parser breaks.
 *
 * It serves the long tail of house style — the full rulebook, per-format
 * checklists, and the preferred-term list — which is deliberately NOT in the
 * `editorial-standards` skill: a skill is inlined into every prompt, so it
 * holds the map, and this server holds the reference the agent queries when it
 * actually needs a specific rule.
 */

const SERVER_NAME = "style-desk";
const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

// ── House rulebook ──────────────────────────────────────────────

const RULES = [
    {
        id: "voice-active",
        category: "voice",
        title: "Prefer the active voice",
        rule: "Name the actor and put it in front of the verb. Use the passive only when the actor is unknown, irrelevant, or deliberately withheld.",
        why: "Passive constructions hide who is responsible, which is exactly the information a reader needs in docs and incident writing.",
        yes: "The scheduler retries the turn.",
        no: "The turn is retried.",
    },
    {
        id: "voice-second-person",
        category: "voice",
        title: "Address the reader as 'you'",
        rule: "Use second person for instructions. Reserve 'we' for decisions the team made, never for steps the reader performs.",
        why: "'We run the migration' leaves the reader unsure whether they are supposed to do anything.",
        yes: "You run the migration before deploying.",
        no: "We then run the migration.",
    },
    {
        id: "voice-present-tense",
        category: "voice",
        title: "Write in the present tense",
        rule: "Describe what the system does, not what it will do.",
        why: "Future tense reads as a promise and ages badly in reference material.",
        yes: "The worker installs the package within 20 seconds.",
        no: "The worker will then install the package.",
    },
    {
        id: "structure-bluf",
        category: "structure",
        title: "Lead with the conclusion",
        rule: "Put the outcome, decision, or answer in the first paragraph. Background follows; it never opens.",
        why: "Most readers stop after the first screen. Burying the answer beneath context spends their attention on setup.",
        yes: "Sessions now survive worker restarts. Here is how that works.",
        no: "Before we explain the change, some history about durable execution.",
    },
    {
        id: "structure-one-idea",
        category: "structure",
        title: "One idea per paragraph",
        rule: "Cap paragraphs at roughly four sentences and give each a single job. Split anything longer.",
        why: "Dense paragraphs hide the transitions that carry the argument.",
    },
    {
        id: "structure-headings-scannable",
        category: "structure",
        title: "Headings state content, not category",
        rule: "A heading should be informative when read alone in a table of contents. Avoid 'Overview', 'Details', 'More'.",
        why: "Readers navigate by headings; a category label tells them nothing about whether to stop there.",
        yes: "How a turn survives a crash",
        no: "Details",
    },
    {
        id: "structure-no-level-skips",
        category: "structure",
        title: "Never skip a heading level",
        rule: "H1 → H2 → H3 in order. If a section needs an H3, it needs an H2 above it.",
        why: "Skipped levels break document outlines, screen readers, and generated navigation.",
    },
    {
        id: "clarity-short-sentences",
        category: "clarity",
        title: "Keep sentences under 30 words",
        rule: "Split any sentence past 30 words, and any sentence with more than one subordinate clause.",
        why: "Comprehension falls off sharply past about 25 words, especially for readers scanning.",
    },
    {
        id: "clarity-cut-hedges",
        category: "clarity",
        title: "Cut hedges and intensifiers",
        rule: "Delete 'very', 'quite', 'basically', 'simply', 'just'. If a claim is uncertain, state the uncertainty and its cause instead of softening the verb.",
        why: "'It is basically instant' communicates less than '95th percentile is 120 ms'.",
        yes: "Installation completes in about 20 seconds.",
        no: "Installation is basically pretty much instant.",
    },
    {
        id: "clarity-no-jargon-without-gloss",
        category: "clarity",
        title: "Gloss a term the first time it appears",
        rule: "Define domain terms on first use, in one clause. Do not define them twice.",
        why: "A single inline gloss serves both the newcomer and the expert; a glossary at the end serves neither in the moment.",
        yes: "Replay — re-running the orchestration from its recorded history — makes the turn deterministic.",
    },
    {
        id: "evidence-quantify",
        category: "evidence",
        title: "Replace adjectives with measurements",
        rule: "Every performance, size, or reliability claim carries a number and the conditions it was measured under.",
        why: "'Fast' is unfalsifiable; '120 ms at p95 on a warm session' can be checked and defended.",
        no: "Dramatically faster startup.",
        yes: "Cold start dropped from 4.1 s to 1.3 s (p50, 20 runs).",
    },
    {
        id: "evidence-link-primary",
        category: "evidence",
        title: "Link the primary source",
        rule: "Cite the commit, filing, spec section, or dashboard — not a summary of it, and not a search result.",
        why: "A secondary source cannot be verified without re-doing the research it summarizes.",
    },
    {
        id: "terminology-one-name",
        category: "terminology",
        title: "One name per concept",
        rule: "Pick a single term for each concept and never alternate for variety. Consult the preferred-term list.",
        why: "Elegant variation ('agent', 'bot', 'assistant') makes readers wonder whether three different things are being discussed.",
    },
    {
        id: "formatting-code-in-code",
        category: "formatting",
        title: "Code voice for code things",
        rule: "Backtick file names, commands, flags, environment variables, function names, and literal values. Do not backtick concepts.",
        why: "Typographic distinction is what tells a reader that a string is meant to be typed exactly.",
    },
    {
        id: "formatting-list-parallel",
        category: "formatting",
        title: "Keep list items parallel",
        rule: "Every item in a list starts with the same part of speech and ends with the same punctuation policy.",
        why: "Broken parallelism reads as a formatting error and slows scanning.",
    },
    {
        id: "inclusive-plain",
        category: "inclusive",
        title: "Plain, non-idiomatic English",
        rule: "Avoid idioms, sports metaphors, and culture-specific references. Prefer 'straightforward' to 'easy' and never 'obviously' or 'simply'.",
        why: "Idioms do not translate, and 'obviously' tells a stuck reader that the problem is them.",
        no: "Simply hit it out of the park by tweaking the config.",
        yes: "Change the two settings below.",
    },
    {
        id: "release-notes-user-impact",
        category: "release-notes",
        title: "Release notes describe impact, not commits",
        rule: "Each entry states what a user can now do, or what stopped happening to them. Implementation detail goes in the linked PR.",
        why: "A changelog of refactors gives users no way to decide whether to upgrade.",
        no: "Refactored the session manager.",
        yes: "Sessions now resume after a worker restart instead of failing the turn.",
    },
    {
        id: "postmortem-blameless",
        category: "postmortem",
        title: "Postmortems are blameless and specific",
        rule: "Describe systems and decisions, never individuals. Name the missing guardrail rather than the person who hit it.",
        why: "Blame suppresses the reporting the process depends on, and guardrails are the only fixable part.",
        no: "An engineer deployed without running migrations.",
        yes: "The deploy path did not verify migration state before rollout.",
    },
];

const CHECKLISTS = {
    "blog-post": {
        title: "Blog post",
        audience: "Readers who do not already use the product.",
        items: [
            "The first paragraph states the takeaway without requiring prior context.",
            "Every claim about performance or scale carries a number and its measurement conditions.",
            "There is one concrete example, ideally with the actual output shown.",
            "Headings are informative when read alone.",
            "The ending tells the reader exactly what to do next, with a link.",
            "No sentence over 30 words; no paragraph over four sentences.",
        ],
    },
    "release-note": {
        title: "Release note",
        audience: "Existing users deciding whether and how to upgrade.",
        items: [
            "Entries are grouped: Added, Changed, Fixed, Deprecated, Removed, Security.",
            "Each entry states user-visible impact, not the implementation.",
            "Breaking changes appear first and state the required migration step.",
            "Every entry links to the PR or issue.",
            "Version number and date are present and correct.",
            "No internal-only refactors are listed.",
        ],
    },
    "incident-postmortem": {
        title: "Incident postmortem",
        audience: "The team and anyone auditing reliability later.",
        items: [
            "Impact stated first: who was affected, how, and for how long.",
            "Timeline uses absolute timestamps with a stated timezone.",
            "Root cause distinguishes the trigger from the underlying condition.",
            "Detection gap is named: how long until anyone knew, and why.",
            "Every action item has an owner and a date.",
            "The narrative is blameless: systems and decisions, never individuals.",
        ],
    },
    readme: {
        title: "README",
        audience: "A developer deciding whether to use this in the next ten minutes.",
        items: [
            "One sentence saying what this is and who it is for, above the fold.",
            "Install and run in a copyable block that works from a clean checkout.",
            "A minimal working example, not a feature tour.",
            "Prerequisites and required environment variables are listed explicitly.",
            "Links to deeper docs rather than inlining them.",
            "No unresolved TODO or TBD markers.",
        ],
    },
    "api-reference": {
        title: "API reference",
        audience: "Someone integrating against the surface right now.",
        items: [
            "Every parameter lists type, whether it is required, and its default.",
            "Units and ranges are stated for every numeric field.",
            "Error cases are documented with the condition that triggers them.",
            "At least one request/response pair per operation.",
            "Idempotency, pagination, and rate limits are addressed or explicitly declared absent.",
            "Terminology matches the rest of the docs exactly.",
        ],
    },
    "announcement-email": {
        title: "Announcement email",
        audience: "Busy recipients who may read only the subject and first line.",
        items: [
            "Subject line states the change in under nine words.",
            "First line answers: what changed, when, and does the reader need to act.",
            "Any required action is a labeled list with a deadline.",
            "Body is under 200 words; detail moves to a link.",
            "One owner and one channel are named for questions.",
        ],
    },
};

const PREFERRED_TERMS = [
    { preferred: "agent", avoid: ["bot", "assistant", "AI"], note: "One name per concept; 'agent' is the product term." },
    { preferred: "sub-agent", avoid: ["subagent", "child agent", "sub agent"], note: "Hyphenated, lowercase except at sentence start." },
    { preferred: "email", avoid: ["e-mail", "E-Mail"], note: "One word, no hyphen." },
    { preferred: "website", avoid: ["web site", "web-site"], note: "One word." },
    { preferred: "log in", avoid: ["login"], note: "Two words as a verb; 'login' only as a noun or adjective." },
    { preferred: "sign in", avoid: ["signin", "log on"], note: "Verb form for authentication flows." },
    { preferred: "open source", avoid: ["opensource"], note: "Two words as a noun; hyphenate only as a modifier." },
    { preferred: "runtime", avoid: ["run-time", "run time"], note: "One word." },
    { preferred: "dataset", avoid: ["data set"], note: "One word." },
    { preferred: "PostgreSQL", avoid: ["Postgres SQL", "postgresql", "PostGres"], note: "'Postgres' is acceptable in informal prose." },
    { preferred: "JavaScript", avoid: ["Javascript", "javascript", "JS"], note: "Spell it out in prose; 'JS' only in code voice." },
    { preferred: "TypeScript", avoid: ["Typescript", "typescript"], note: "Capital T and S." },
    { preferred: "GitHub", avoid: ["Github", "github"], note: "Capital H, except in URLs and package names." },
    { preferred: "macOS", avoid: ["MacOS", "Mac OS", "OSX"], note: "Lowercase m, capital OS." },
    { preferred: "command line", avoid: ["commandline"], note: "Two words as a noun; hyphenate as a modifier ('command-line flag')." },
    { preferred: "set up", avoid: ["setup"], note: "Two words as a verb; 'setup' only as a noun." },
];

// ── Caveman mode reference ──────────────────────────────────────
//
// Adapted from the rules of the MIT-licensed `caveman` project by Julius
// Brussee (https://github.com/juliusbrussee/caveman). Rules reimplemented
// here; no upstream code is used.
//
// This lives in MCP rather than in the preloaded skill on purpose: the desk
// answers caveman questions a few times per document, and a skill costs
// prompt space on every single turn.

const CAVEMAN_LADDER = {
    lite: {
        level: "lite",
        summary: "Professional but tight. Nothing structural changes.",
        drops: ["filler words", "pleasantries", "hedging", "wordy phrases"],
        keeps: ["articles", "complete sentences", "connectives", "the author's register"],
        useWhen: "External-facing prose, or a reader who has to trust the document.",
        example: {
            original: "Sure! You should really make sure to run the test suite before you push, because it helps catch bugs early.",
            compressed: "Run the test suite before pushing; it catches bugs early.",
        },
    },
    full: {
        level: "full",
        summary: "Classic caveman. Articles go, fragments are fine.",
        drops: ["everything lite drops", "articles (a/an/the)", "long words with short synonyms"],
        keeps: ["technical terms", "code", "commands", "error strings", "numbers", "sentence order"],
        useWhen: "Internal notes, agent memory files, working docs, chat.",
        example: {
            original: "The API gateway routes all of the incoming requests to the appropriate service.",
            compressed: "API gateway routes incoming requests to correct service.",
        },
    },
    ultra: {
        level: "ultra",
        summary: "Maximum terseness. One word when one word is enough; each fact stated once.",
        drops: ["everything full drops", "connective fluff", "softeners (you should, make sure to)", "conjunctions where cause and effect stay unambiguous"],
        keeps: ["code symbols", "function and API names", "error strings", "anything whose order carries meaning"],
        useWhen: "Machine-read notes and memory files. Rarely appropriate for humans.",
        risk: "Dropped articles and conjunctions can make ordered instructions ambiguous. If the text is a procedure, stay at full.",
        example: {
            original: "The component re-renders because you create a new object reference on each render. Wrap it in useMemo.",
            compressed: "Inline object prop, new ref, re-render. Wrap in useMemo.",
        },
    },
};

const CAVEMAN_ANTIPATTERNS = [
    {
        id: "invented-abbreviations",
        rule: "Never invent abbreviations: cfg, impl, req, res, fn, auth, cmd, msg.",
        why: "A tokenizer splits the abbreviation the same way it splits the full word, so the saving is zero — and the reader pays a decode step. The full word is cheaper AND clearer.",
    },
    {
        id: "no-arrows",
        rule: "No arrows (X arrow Y) as a substitute for a word.",
        why: "An arrow is its own token and replaces a word that was already one token. It buys nothing and reads worse.",
    },
    {
        id: "no-decoration",
        rule: "No emoji, no decorative tables, no ASCII art.",
        why: "Decoration is the opposite of compression.",
    },
    {
        id: "no-self-reference",
        rule: "Never announce the mode. No 'caveman mode on', no 'me caveman', no third-person tags, and never a normal answer plus a compressed recap.",
        why: "The style is a delivery format, not a character. Announcing it spends the tokens it just saved.",
    },
    {
        id: "preserve-language",
        rule: "Compress in the language the text is written in.",
        why: "Compressing the style is the job; translating is a different edit the author did not ask for.",
    },
    {
        id: "state-once",
        rule: "State each fact once. Delete the restatement, not the fact.",
        why: "Redundancy is where the tokens actually are; word-shortening is a rounding error next to it.",
    },
];

const CAVEMAN_GUARDRAILS = [
    {
        id: "security-warnings",
        situation: "Security warnings and anything describing a vulnerability or its blast radius.",
        action: "Write in full prose. Resume compression after the warning.",
    },
    {
        id: "destructive-actions",
        situation: "Irreversible or destructive operations: data deletion, schema drops, production rollouts, key rotation.",
        action: "Full prose, including the confirmation step and how to recover.",
    },
    {
        id: "ordered-procedures",
        situation: "Multi-step procedures where dropped articles or conjunctions make the order ambiguous — 'migrate table drop column backup first' has no readable order.",
        action: "Stay at lite, or keep the step list in full prose.",
    },
    {
        id: "legal-and-compliance",
        situation: "Licences, contracts, compliance statements, safety notices, medical or financial disclaimers.",
        action: "Never compress. The exact wording is the artifact.",
    },
    {
        id: "reader-confusion",
        situation: "The reader asks for clarification, or repeats a question.",
        action: "Answer in full prose. Compression is not worth a second round trip.",
    },
    {
        id: "ambiguity-created",
        situation: "Compression itself introduced an ambiguity you can see.",
        action: "Put the words back. A shorter sentence that must be re-read is longer.",
    },
];

const CAVEMAN_NEVER_TOUCH = [
    "fenced and indented code blocks",
    "inline code in backticks",
    "commands and CLI flags",
    "URLs and markdown links",
    "file paths and environment variables",
    "error strings, log lines, and stack traces",
    "numbers, versions, dates, and units",
    "proper nouns, API names, and identifiers",
    "quoted material and headings",
];



// ── Tool implementations ────────────────────────────────────────

function normalize(value) {
    return String(value ?? "").trim().toLowerCase();
}

function listChecklists() {
    return {
        checklists: Object.entries(CHECKLISTS).map(([kind, value]) => ({
            kind,
            title: value.title,
            audience: value.audience,
            items: value.items.length,
        })),
        usage: "Call get_checklist with one of the `kind` values before declaring a draft ready.",
    };
}

function getChecklist({ kind }) {
    const key = normalize(kind).replace(/[\s_]+/g, "-");
    const found = CHECKLISTS[key];
    if (!found) {
        const known = Object.keys(CHECKLISTS).join(", ");
        throw new Error(`unknown checklist "${kind}" — known kinds: ${known}`);
    }
    return { kind: key, ...found, servedBy: SERVER_NAME };
}

function lookupStyleRule({ query, category, limit }) {
    const q = normalize(query);
    const cat = normalize(category);
    const cap = Math.max(1, Math.min(20, Number.isFinite(limit) ? Math.floor(limit) : 5));

    const scored = RULES
        .filter((rule) => (cat ? rule.category === cat : true))
        .map((rule) => {
            if (!q) return { rule, score: 1 };
            const haystack = normalize(`${rule.id} ${rule.category} ${rule.title} ${rule.rule} ${rule.why}`);
            let score = 0;
            if (normalize(rule.id) === q) score += 100;
            if (haystack.includes(q)) score += 10;
            for (const token of q.split(/\s+/).filter(Boolean)) {
                if (haystack.includes(token)) score += 2;
            }
            return { rule, score };
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.rule.id.localeCompare(b.rule.id))
        .slice(0, cap)
        .map((entry) => entry.rule);

    return {
        query: query ?? null,
        category: category ?? null,
        matches: scored,
        totalRules: RULES.length,
        categories: [...new Set(RULES.map((r) => r.category))],
        servedBy: SERVER_NAME,
    };
}

function preferredTerm({ term }) {
    const q = normalize(term).replace(/[\s_-]+/g, "");
    if (!q) {
        return { terms: PREFERRED_TERMS, servedBy: SERVER_NAME };
    }
    const collapse = (value) => normalize(value).replace(/[\s_-]+/g, "");
    const exact = PREFERRED_TERMS.filter((entry) =>
        collapse(entry.preferred) === q || entry.avoid.some((a) => collapse(a) === q));
    const partial = PREFERRED_TERMS.filter((entry) =>
        !exact.includes(entry)
        && (collapse(entry.preferred).includes(q) || entry.avoid.some((a) => collapse(a).includes(q))));

    const matches = [...exact, ...partial].slice(0, 8);
    return {
        term,
        matches,
        verdict: exact.length === 0
            ? "not in the preferred-term list — pick one spelling and use it consistently"
            : collapse(exact[0].preferred) === q
                ? "this is the preferred form"
                : `use "${exact[0].preferred}" instead`,
        servedBy: SERVER_NAME,
    };
}

function cavemanRules({ level }) {
    const key = normalize(level);
    if (key && !CAVEMAN_LADDER[key]) {
        throw new Error(`unknown level "${level}" — use lite, full, or ultra`);
    }
    return {
        levels: key ? [CAVEMAN_LADDER[key]] : Object.values(CAVEMAN_LADDER),
        default: "full",
        antipatterns: CAVEMAN_ANTIPATTERNS,
        neverTouch: CAVEMAN_NEVER_TOUCH,
        procedure: [
            "Confirm the level with the user; never assume ultra.",
            "Run caveman_draft for the mechanical pass — it protects code, URLs, paths, and numbers.",
            "Repair the draft by judgement. It will read roughly; that is expected.",
            "Run caveman_check. Do not deliver anything while it reports ok: false.",
            "Quote the measured savings from the tool. Never estimate them yourself.",
        ],
        credit: "Rules adapted from the MIT-licensed caveman project by Julius Brussee (https://github.com/juliusbrussee/caveman).",
        servedBy: SERVER_NAME,
    };
}

function cavemanGuardrails() {
    return {
        dropOutOfCavemanWhen: CAVEMAN_GUARDRAILS,
        neverTouch: CAVEMAN_NEVER_TOUCH,
        principle: "Caveman mode changes how something is said. It never changes what is claimed, and it is never applied unless the user asked for it.",
        resume: "Write the protected span in full prose, then continue compressed. Do not announce the switch.",
        servedBy: SERVER_NAME,
    };
}

const TOOLS = [
    {
        name: "list_checklists",
        description: "List the pre-publication checklists this desk serves (blog post, release note, postmortem, README, API reference, announcement email).",
        inputSchema: { type: "object", properties: {} },
        handler: listChecklists,
    },
    {
        name: "get_checklist",
        description: "Fetch the full pre-publication checklist for one content type. Run it against the draft item by item before calling anything ready to ship.",
        inputSchema: {
            type: "object",
            properties: {
                kind: {
                    type: "string",
                    description: "Checklist id from list_checklists, e.g. blog-post, release-note, incident-postmortem, readme, api-reference, announcement-email.",
                },
            },
            required: ["kind"],
        },
        handler: getChecklist,
    },
    {
        name: "lookup_style_rule",
        description: "Search the house style rulebook by keyword, rule id, or category (voice, structure, clarity, evidence, terminology, formatting, inclusive, release-notes, postmortem). Returns the rule, its rationale, and worked examples.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Keyword or rule id, e.g. 'passive', 'headings', 'voice-active'." },
                category: { type: "string", description: "Restrict to one category." },
                limit: { type: "number", description: "Maximum rules to return (default 5, max 20)." },
            },
        },
        handler: lookupStyleRule,
    },
    {
        name: "preferred_term",
        description: "Resolve the house-preferred spelling of a product or technical term and the variants to avoid. Call it before renaming anything in a draft.",
        inputSchema: {
            type: "object",
            properties: {
                term: { type: "string", description: "The term to resolve, e.g. 'sub agent', 'Github', 'setup'. Omit to list every entry." },
            },
        },
        handler: preferredTerm,
    },
    {
        name: "caveman_rules",
        description: "The caveman-speak intensity ladder (lite, full, ultra): what each level drops, what it keeps, when to use it, worked examples, and the compression anti-patterns that measurably save nothing. Call this before running a caveman pass.",
        inputSchema: {
            type: "object",
            properties: {
                level: { type: "string", description: "Restrict to one level: lite, full, or ultra. Omit for all three." },
            },
        },
        handler: cavemanRules,
    },
    {
        name: "caveman_guardrails",
        description: "When to drop out of caveman mode entirely (security warnings, destructive actions, ordered procedures, legal text, a confused reader) and the regions that are never compressed at any level.",
        inputSchema: { type: "object", properties: {} },
        handler: cavemanGuardrails,
    },
];

// ── JSON-RPC over stdio ─────────────────────────────────────────

function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
    send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
    send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(message) {
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    switch (method) {
        case "initialize": {
            const requested = params?.protocolVersion;
            respond(id, {
                protocolVersion: typeof requested === "string" ? requested : DEFAULT_PROTOCOL_VERSION,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            });
            return;
        }
        case "notifications/initialized":
        case "notifications/cancelled":
            return; // notifications are never answered
        case "ping":
            respond(id, {});
            return;
        case "tools/list":
            respond(id, {
                tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
            });
            return;
        case "tools/call": {
            const tool = TOOLS.find((t) => t.name === params?.name);
            if (!tool) {
                respond(id, {
                    content: [{ type: "text", text: `Unknown tool: ${params?.name}` }],
                    isError: true,
                });
                return;
            }
            try {
                const result = tool.handler(params?.arguments ?? {});
                respond(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
            } catch (err) {
                // A tool failure is a RESULT with isError, not a protocol error:
                // the model needs to see the message and correct its call.
                respond(id, {
                    content: [{ type: "text", text: `${tool.name} failed: ${err?.message ?? err}` }],
                    isError: true,
                });
            }
            return;
        }
        case "resources/list":
            respond(id, { resources: [] });
            return;
        case "prompts/list":
            respond(id, { prompts: [] });
            return;
        default:
            if (isNotification) return;
            fail(id, -32601, `Method not found: ${method}`);
    }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line !== "") {
            let message = null;
            try {
                message = JSON.parse(line);
            } catch (err) {
                fail(null, -32700, `Parse error: ${err?.message ?? err}`);
            }
            if (message) {
                try {
                    handle(message);
                } catch (err) {
                    process.stderr.write(`[${SERVER_NAME}] handler crashed: ${err?.stack ?? err}\n`);
                    if (message.id !== undefined && message.id !== null) {
                        fail(message.id, -32603, `Internal error: ${err?.message ?? err}`);
                    }
                }
            }
        }
        newline = buffer.indexOf("\n");
    }
});
process.stdin.on("end", () => process.exit(0));

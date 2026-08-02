/**
 * Editorial Desk worker tools.
 *
 * Contract (see docs/building-agent-packages.md §5): default-export an object
 * with `createTools({ workerNodeId })` returning plain tool objects
 * `{ name, description, parameters, handler }`.
 *
 * Every tool here is deterministic and offline: no network, no bare imports,
 * no `node_modules`. That is deliberate — the package doubles as a smoke test,
 * so the same text must always produce the same numbers, and each result
 * carries `analyzedOn` (the worker node id) to prove the worker really ran it
 * instead of the model hallucinating the answer.
 */

const MAX_TEXT_CHARS = 200_000;
const LONG_SENTENCE_WORDS = 30;
const READING_WORDS_PER_MINUTE = 220;
const DIFF_TOKEN_CAP = 4000;

// ── Rule data ───────────────────────────────────────────────────

const WEASEL_WORDS = [
    "very", "really", "quite", "rather", "somewhat", "fairly", "actually",
    "basically", "simply", "just", "essentially", "literally", "clearly",
    "obviously", "certainly", "arguably", "relatively", "significantly",
    "substantially", "extremely", "incredibly", "surprisingly", "various",
    "several", "numerous", "vast", "huge", "robust", "seamless", "powerful",
];

const HEDGES = [
    "might", "maybe", "perhaps", "possibly", "presumably", "seems", "appears",
    "sort of", "kind of", "we think", "we believe", "it is believed",
    "more or less", "in some sense", "to some extent",
];

const WORDY_PHRASES = [
    ["in order to", "to"],
    ["due to the fact that", "because"],
    ["in spite of the fact that", "although"],
    ["despite the fact that", "although"],
    ["in the event that", "if"],
    ["at this point in time", "now"],
    ["at the present time", "now"],
    ["a large number of", "many"],
    ["a majority of", "most"],
    ["has the ability to", "can"],
    ["is able to", "can"],
    ["make a decision", "decide"],
    ["provide assistance to", "help"],
    ["prior to", "before"],
    ["subsequent to", "after"],
    ["in the process of", "currently"],
    ["it should be noted that", ""],
    ["needless to say", ""],
    ["the fact that", "that"],
    ["utilize", "use"],
    ["utilizes", "uses"],
    ["leverage", "use"],
    ["in terms of", "for"],
];

const CLICHES = [
    "at the end of the day", "low-hanging fruit", "moving forward",
    "circle back", "touch base", "game changer", "best-in-class",
    "think outside the box", "boil the ocean", "north star", "double down",
    "paradigm shift", "synergy", "deep dive",
];

// Irregular past participles that the `-ed`/`-en` heuristic would miss.
const IRREGULAR_PARTICIPLES = [
    "born", "bought", "brought", "built", "caught", "chosen", "dealt", "done",
    "drawn", "driven", "eaten", "fed", "felt", "found", "given", "gone",
    "grown", "held", "kept", "known", "laid", "led", "left", "lost", "made",
    "meant", "met", "paid", "put", "read", "run", "said", "seen", "sent",
    "set", "shown", "sold", "sought", "sung", "spent", "split", "spoken",
    "taken", "taught", "thrown", "told", "understood", "won", "written",
];

// Words that end in "ly" without being adverbs.
const NOT_ADVERBS = new Set([
    "only", "family", "apply", "reply", "supply", "italy", "july", "ally",
    "rely", "holy", "ugly", "silly", "jelly", "belly", "early", "likely",
    "friendly", "lonely", "lovely", "monthly", "weekly", "daily", "costly",
    "deadly", "elderly", "orderly", "timely", "unlikely", "assembly",
    "anomaly", "multiply", "imply", "comply", "poly", "melancholy",
]);

// Spellings only — never case variants, so sentence-initial capitals do not
// register as inconsistencies. The first entry is the house-preferred form.
const COMMON_VARIANT_GROUPS = [
    ["email", "e-mail"],
    ["website", "web site"],
    ["login", "log-in"],
    ["setup", "set-up"],
    ["frontend", "front-end"],
    ["backend", "back-end"],
    ["open source", "opensource"],
    ["runtime", "run-time"],
    ["dataset", "data set"],
    ["realtime", "real-time"],
];

// ── Text helpers ────────────────────────────────────────────────

function requireText(value, field) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`"${field}" is required and must be a non-empty string`);
    }
    if (value.length > MAX_TEXT_CHARS) {
        throw new Error(`"${field}" is ${value.length} characters; the limit is ${MAX_TEXT_CHARS}`);
    }
    return value;
}

/** Split into sentences, keeping the character offset of each one. */
function splitSentences(text) {
    const sentences = [];
    const re = /[^.!?\n]+(?:[.!?]+|\n{2,}|$)/g;
    let match;
    while ((match = re.exec(text)) !== null) {
        const raw = match[0];
        if (raw.trim() === "") continue;
        sentences.push({ text: raw.trim(), start: match.index, index: sentences.length + 1 });
        if (re.lastIndex === match.index) re.lastIndex += 1;
    }
    return sentences;
}

function words(text) {
    return text.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) ?? [];
}

function lineOf(text, offset) {
    let line = 1;
    for (let i = 0; i < offset && i < text.length; i += 1) {
        if (text[i] === "\n") line += 1;
    }
    return line;
}

function snippet(text, start, end, pad = 34) {
    const from = Math.max(0, start - pad);
    const to = Math.min(text.length, end + pad);
    const prefix = from > 0 ? "…" : "";
    const suffix = to < text.length ? "…" : "";
    return `${prefix}${text.slice(from, to).replace(/\s+/g, " ").trim()}${suffix}`;
}

function countSyllables(word) {
    const w = word.toLowerCase().replace(/[^a-z]/g, "");
    if (w.length === 0) return 0;
    if (w.length <= 3) return 1;
    const trimmed = w
        .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "")
        .replace(/^y/, "");
    const groups = trimmed.match(/[aeiouy]{1,2}/g);
    return Math.max(1, groups ? groups.length : 1);
}

function escapeRe(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function round(value, digits = 1) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

// ── prose_lint ──────────────────────────────────────────────────

function collectMatches(text, pattern, build) {
    const findings = [];
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    let match;
    while ((match = re.exec(text)) !== null) {
        findings.push(build(match));
        if (re.lastIndex === match.index) re.lastIndex += 1;
    }
    return findings;
}

function lintProse(text) {
    const findings = [];
    const push = (rule, severity, match, start, suggestion) => {
        findings.push({
            rule,
            severity,
            line: lineOf(text, start),
            match,
            context: snippet(text, start, start + match.length),
            suggestion,
        });
    };

    const participle = `(?:\\w+(?:ed|en)|${IRREGULAR_PARTICIPLES.join("|")})`;
    const passiveRe = new RegExp(`\\b(?:am|is|are|was|were|be|been|being)\\s+(?:\\w+ly\\s+)?${participle}\\b`, "gi");
    for (const m of collectMatches(text, passiveRe, (m) => m)) {
        push("passive-voice", "warning", m[0], m.index, "Name the actor and use an active verb.");
    }

    const weaselRe = new RegExp(`\\b(?:${WEASEL_WORDS.map(escapeRe).join("|")})\\b`, "gi");
    for (const m of collectMatches(text, weaselRe, (m) => m)) {
        push("weasel-word", "info", m[0], m.index, "Delete it or replace it with a measurement.");
    }

    const hedgeRe = new RegExp(`\\b(?:${HEDGES.map(escapeRe).join("|")})\\b`, "gi");
    for (const m of collectMatches(text, hedgeRe, (m) => m)) {
        push("hedge", "info", m[0], m.index, "Commit to the claim, or state what is unknown and why.");
    }

    for (const [phrase, replacement] of WORDY_PHRASES) {
        const re = new RegExp(`\\b${escapeRe(phrase)}\\b`, "gi");
        for (const m of collectMatches(text, re, (m) => m)) {
            push("wordy-phrase", "warning", m[0], m.index,
                replacement ? `Use "${replacement}".` : "Cut the phrase; it carries no information.");
        }
    }

    const clicheRe = new RegExp(`\\b(?:${CLICHES.map(escapeRe).join("|")})\\b`, "gi");
    for (const m of collectMatches(text, clicheRe, (m) => m)) {
        push("cliche", "warning", m[0], m.index, "Say the specific thing this phrase is standing in for.");
    }

    for (const m of collectMatches(text, /\b([A-Za-z']+)\s+\1\b/gi, (m) => m)) {
        push("repeated-word", "error", m[0], m.index, "Remove the duplicated word.");
    }

    for (const m of collectMatches(text, /\b\w+ly\b/gi, (m) => m)) {
        if (NOT_ADVERBS.has(m[0].toLowerCase())) continue;
        push("adverb", "info", m[0], m.index, "Prefer a stronger verb over verb + adverb.");
    }

    for (const m of collectMatches(text, /!{2,}|\?{2,}/g, (m) => m)) {
        push("punctuation-shout", "warning", m[0], m.index, "One terminal mark is enough.");
    }

    for (const sentence of splitSentences(text)) {
        const count = words(sentence.text).length;
        if (count > LONG_SENTENCE_WORDS) {
            findings.push({
                rule: "long-sentence",
                severity: "warning",
                line: lineOf(text, sentence.start),
                match: `${count} words`,
                context: snippet(text, sentence.start, sentence.start + Math.min(120, sentence.text.length)),
                suggestion: `Split it; the house limit is ${LONG_SENTENCE_WORDS} words.`,
            });
        }
    }

    findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
    return findings;
}

// ── readability_score ───────────────────────────────────────────

function readability(text) {
    const sentences = splitSentences(text);
    const allWords = words(text);
    const syllables = allWords.reduce((sum, w) => sum + countSyllables(w), 0);
    const complexWords = allWords.filter((w) => countSyllables(w) >= 3);
    const sentenceCount = Math.max(1, sentences.length);
    const wordCount = Math.max(1, allWords.length);

    const wordsPerSentence = allWords.length / sentenceCount;
    const syllablesPerWord = syllables / wordCount;
    const flesch = 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord;
    const fkGrade = 0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59;
    const fog = 0.4 * (wordsPerSentence + 100 * (complexWords.length / wordCount));

    const bands = [
        [90, "very easy (5th grade)"],
        [80, "easy (6th grade)"],
        [70, "fairly easy (7th grade)"],
        [60, "plain English (8th–9th grade)"],
        [50, "fairly difficult (10th–12th grade)"],
        [30, "difficult (college)"],
        [-Infinity, "very difficult (graduate)"],
    ];
    const band = bands.find(([floor]) => flesch >= floor)[1];

    const longest = sentences
        .map((s) => ({ sentence: s.index, line: lineOf(text, s.start), words: words(s.text).length, text: s.text.replace(/\s+/g, " ") }))
        .sort((a, b) => b.words - a.words)
        .slice(0, 3);

    return {
        counts: {
            characters: text.length,
            words: allWords.length,
            sentences: sentences.length,
            paragraphs: text.split(/\n{2,}/).filter((p) => p.trim() !== "").length,
            syllables,
            complexWords: complexWords.length,
        },
        averages: {
            wordsPerSentence: round(wordsPerSentence),
            syllablesPerWord: round(syllablesPerWord, 2),
        },
        scores: {
            fleschReadingEase: round(flesch),
            fleschKincaidGrade: round(fkGrade),
            gunningFog: round(fog),
            band,
        },
        readingTimeMinutes: round(allWords.length / READING_WORDS_PER_MINUTE),
        longestSentences: longest,
    };
}

// ── text_diff ───────────────────────────────────────────────────

function tokenize(text, granularity) {
    if (granularity === "word") return text.split(/(\s+)/).filter((t) => t !== "");
    return text.split("\n");
}

/** Classic LCS backtrack. Inputs are capped by the caller. */
function lcsDiff(a, b) {
    const n = a.length;
    const m = b.length;
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
            table[i][j] = a[i] === b[j]
                ? table[i + 1][j + 1] + 1
                : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }
    const segments = [];
    const emit = (op, value) => {
        const last = segments[segments.length - 1];
        if (last && last.op === op) last.tokens.push(value);
        else segments.push({ op, tokens: [value] });
    };
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { emit("equal", a[i]); i += 1; j += 1; }
        else if (table[i + 1][j] >= table[i][j + 1]) { emit("delete", a[i]); i += 1; }
        else { emit("insert", b[j]); j += 1; }
    }
    while (i < n) { emit("delete", a[i]); i += 1; }
    while (j < m) { emit("insert", b[j]); j += 1; }
    return segments;
}

function diffTexts(before, after, granularity) {
    const joiner = granularity === "word" ? "" : "\n";
    let a = tokenize(before, granularity);
    let b = tokenize(after, granularity);
    let truncated = false;
    if (a.length > DIFF_TOKEN_CAP || b.length > DIFF_TOKEN_CAP) {
        truncated = true;
        a = a.slice(0, DIFF_TOKEN_CAP);
        b = b.slice(0, DIFF_TOKEN_CAP);
    }

    const segments = lcsDiff(a, b).map((s) => ({ op: s.op, text: s.tokens.join(joiner) }));
    let added = 0;
    let removed = 0;
    let unchanged = 0;
    for (const s of segments) {
        const size = granularity === "word" ? words(s.text).length : s.text.split("\n").length;
        if (s.op === "insert") added += size;
        else if (s.op === "delete") removed += size;
        else unchanged += size;
    }
    const total = added + removed + unchanged;

    const redline = segments
        .filter((s) => s.text.trim() !== "" || s.op !== "equal")
        .map((s) => (s.op === "insert" ? `{+${s.text}+}` : s.op === "delete" ? `[-${s.text}-]` : s.text))
        .join(joiner);

    return {
        granularity,
        stats: {
            added,
            removed,
            unchanged,
            changeRatio: total === 0 ? 0 : round((added + removed) / total, 3),
        },
        truncated,
        redline,
        segments,
    };
}

// ── heading_outline ─────────────────────────────────────────────

function outlineMarkdown(markdown) {
    const lines = markdown.split("\n");
    const headings = [];
    let inFence = false;
    lines.forEach((line, idx) => {
        if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; return; }
        if (inFence) return;
        const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
        if (m) headings.push({ level: m[1].length, title: m[2].trim(), line: idx + 1 });
    });

    const sections = headings.map((h, i) => {
        const from = h.line;
        const to = i + 1 < headings.length ? headings[i + 1].line - 1 : lines.length;
        const body = lines.slice(from, to).join("\n");
        return { ...h, wordCount: words(body).length, sentenceCount: splitSentences(body).length };
    });

    const issues = [];
    const h1s = sections.filter((s) => s.level === 1);
    if (sections.length === 0) issues.push({ code: "no-headings", message: "The document has no headings." });
    if (h1s.length === 0 && sections.length > 0) issues.push({ code: "no-h1", message: "No top-level (#) heading." });
    if (h1s.length > 1) {
        issues.push({ code: "multiple-h1", message: `${h1s.length} top-level headings; use one and demote the rest.`, lines: h1s.map((s) => s.line) });
    }
    for (let i = 1; i < sections.length; i += 1) {
        const jump = sections[i].level - sections[i - 1].level;
        if (jump > 1) {
            issues.push({
                code: "skipped-level",
                message: `"${sections[i].title}" jumps from H${sections[i - 1].level} to H${sections[i].level}.`,
                line: sections[i].line,
            });
        }
    }
    for (const s of sections) {
        if (s.wordCount === 0) issues.push({ code: "empty-section", message: `"${s.title}" has no body text.`, line: s.line });
        else if (s.wordCount > 400) issues.push({ code: "long-section", message: `"${s.title}" runs ${s.wordCount} words; consider splitting.`, line: s.line });
    }
    const seen = new Map();
    for (const s of sections) {
        const key = s.title.toLowerCase();
        if (seen.has(key)) issues.push({ code: "duplicate-heading", message: `"${s.title}" appears at lines ${seen.get(key)} and ${s.line}.`, line: s.line });
        else seen.set(key, s.line);
    }
    for (const [idx, line] of lines.entries()) {
        if (/\b(TODO|TBD|FIXME|XXX)\b/.test(line)) {
            issues.push({ code: "placeholder", message: `Unresolved placeholder: ${line.trim().slice(0, 80)}`, line: idx + 1 });
        }
    }

    return {
        outline: sections.map((s) => ({
            level: s.level,
            title: s.title,
            line: s.line,
            wordCount: s.wordCount,
            sentenceCount: s.sentenceCount,
            path: `${"  ".repeat(s.level - 1)}${"#".repeat(s.level)} ${s.title}`,
        })),
        totals: {
            headings: sections.length,
            maxDepth: sections.reduce((max, s) => Math.max(max, s.level), 0),
            words: words(markdown).length,
        },
        issues,
    };
}

// ── term_consistency ────────────────────────────────────────────

/**
 * Build a pattern that also catches separator drift: "PilotSwarm" matches
 * "Pilot Swarm" and "Pilot-Swarm"; "sub-agent" matches "subagent" and
 * "sub agent". Splits on existing separators and on camelCase boundaries.
 */
function variantPattern(term) {
    const parts = term
        .replace(/([a-z0-9])([A-Z])/g, "$1\u0000$2")
        .split(/[\s_-]+|\u0000/)
        .filter((p) => p !== "");
    return parts.map(escapeRe).join("[\\s_-]?");
}

function termConsistency(text, terms) {
    const findings = [];
    const lines = text.split("\n");
    const locate = (needle) => {
        const hits = [];
        const re = new RegExp(`\\b${variantPattern(needle)}\\b`, "gi");
        lines.forEach((line, idx) => {
            let m;
            while ((m = re.exec(line)) !== null) {
                hits.push({ line: idx + 1, column: m.index, text: m[0] });
                if (re.lastIndex === m.index) re.lastIndex += 1;
            }
        });
        return hits;
    };

    for (const canonical of terms) {
        const hits = locate(canonical);
        if (hits.length === 0) continue;
        const variants = new Map();
        for (const hit of hits) {
            if (hit.text === canonical) continue;
            // Sentence-initial capitalization is not an inconsistency.
            if (hit.text.slice(1) === canonical.slice(1)) continue;
            const entry = variants.get(hit.text) ?? { count: 0, lines: [] };
            entry.count += 1;
            if (entry.lines.length < 10) entry.lines.push(hit.line);
            variants.set(hit.text, entry);
        }
        if (variants.size > 0) {
            findings.push({
                canonical,
                occurrences: hits.length,
                variants: [...variants.entries()]
                    .map(([variant, info]) => ({ variant, ...info }))
                    .sort((a, b) => b.count - a.count),
            });
        }
    }

    // Auto-detected pairs the caller did not ask about.
    const asked = new Set(terms.map((t) => t.toLowerCase().replace(/[\s_-]/g, "")));
    for (const group of COMMON_VARIANT_GROUPS) {
        if (group.some((spelling) => asked.has(spelling.toLowerCase().replace(/[\s_-]/g, "")))) continue;
        const spellings = new Map();
        const seenHits = new Set();
        for (const spelling of group) {
            for (const hit of locate(spelling)) {
                // A group's spellings overlap (the separator is optional), so
                // the same occurrence can be found more than once.
                const key = `${hit.line}:${hit.column}:${hit.text}`;
                if (seenHits.has(key)) continue;
                seenHits.add(key);
                const entry = spellings.get(hit.text) ?? { count: 0, lines: [] };
                entry.count += 1;
                if (entry.lines.length < 10) entry.lines.push(hit.line);
                spellings.set(hit.text, entry);
            }
        }
        const distinct = new Set([...spellings.keys()].map((s) => s.toLowerCase()));
        if (distinct.size > 1) {
            findings.push({
                canonical: group[0],
                detected: true,
                occurrences: [...spellings.values()].reduce((sum, e) => sum + e.count, 0),
                variants: [...spellings.entries()]
                    .map(([variant, info]) => ({ variant, ...info }))
                    .sort((a, b) => b.count - a.count),
            });
        }
    }

    return {
        termsChecked: terms,
        inconsistencies: findings,
        clean: findings.length === 0,
    };
}

// ── Caveman mode ────────────────────────────────────────────────
//
// Adapted from the rules of the MIT-licensed `caveman` project by Julius
// Brussee (https://github.com/juliusbrussee/caveman). The rules are
// reimplemented here; no upstream code is used.
//
// Division of labour, which is the whole point of these two tools: the MODEL
// does the compressing, because judgement is required. Code does the two
// things judgement is bad at — guaranteeing protected regions come through
// byte-identical (`caveman_draft` masks them) and proving afterwards that
// nothing load-bearing was lost (`caveman_check`).

const CAVEMAN_LEVELS = ["lite", "full", "ultra"];

const CAVEMAN_PLEASANTRIES = [
    "i'd be happy to", "i would be happy to", "happy to help", "happy to",
    "i'd recommend", "i would recommend", "i'd suggest", "i would suggest",
    "of course", "certainly", "sure thing", "great question",
    "it should be noted that", "it is worth noting that", "it's worth noting that",
    "please note that", "needless to say", "as you may know", "as we all know",
];

const CAVEMAN_FILLERS = [
    "just", "really", "basically", "actually", "simply", "essentially",
    "generally", "literally", "definitely", "truly", "honestly", "obviously",
    "very", "quite", "rather", "fairly", "somewhat", "pretty much",
];

const CAVEMAN_HEDGES = [
    "it might be worth", "you could consider", "you may want to",
    "it would be good to", "it would be worth", "we think that", "we think",
    "we believe that", "we believe", "perhaps", "maybe", "sort of", "kind of",
    "more or less", "to some extent",
];

const CAVEMAN_CONNECTIVES = [
    "however", "furthermore", "moreover", "additionally", "in addition",
    "that said", "that being said", "on the other hand", "with that in mind",
    "as a result of this", "in other words",
];

const CAVEMAN_SOFTENERS = [
    "you should", "you need to", "you must", "you can", "you may",
    "make sure to", "be sure to", "remember to", "don't forget to",
    "it is important to", "it's important to", "it is recommended that",
];

const CAVEMAN_SYNONYMS = [
    ["utilize", "use"], ["utilizes", "uses"], ["utilized", "used"], ["utilizing", "using"],
    ["implement a solution for", "fix"], ["extensive", "big"],
    ["demonstrate", "show"], ["demonstrates", "shows"], ["additional", "more"],
    ["approximately", "about"], ["sufficient", "enough"], ["terminate", "end"],
    ["initiate", "start"], ["purchase", "buy"], ["attempt", "try"],
    ["require", "need"], ["requires", "needs"], ["obtain", "get"],
    ["provide", "give"], ["provides", "gives"], ["assist", "help"],
    ["modify", "change"], ["indicate", "show"], ["indicates", "shows"],
    ["numerous", "many"], ["subsequently", "then"], ["commence", "start"],
    ["facilitate", "help"], ["endeavour", "try"], ["endeavor", "try"],
];

// Upstream measured these: a tokenizer splits "cfg" the same as "config", so
// the abbreviation saves nothing and costs the reader a decode step. Arrows
// and emoji are their own tokens for the same reason.
const INVENTED_ABBREVIATIONS = [
    "cfg", "impl", "req", "res", "fn", "auth", "cmd", "env", "msg", "usr",
    "val", "obj", "arr", "str", "num", "func", "var", "params", "args",
    "dir", "repo", "deps", "docs", "info", "temp", "prev", "curr",
];

const ARROW_CHARACTERS = /[→⟶⇒➜➡]|-->/g;
const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu;

const MASK_OPEN = "\u0001";
const MASK_CLOSE = "\u0002";

function extractCodeBlocks(text) {
    const fence = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
    const lines = text.split("\n");
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
        const open = fence.exec(lines[i]);
        if (!open) { i += 1; continue; }
        const char = open[2][0];
        const length = open[2].length;
        const buffer = [lines[i]];
        i += 1;
        let closed = false;
        while (i < lines.length) {
            const close = fence.exec(lines[i]);
            if (close && close[2][0] === char && close[2].length >= length && close[3].trim() === "") {
                buffer.push(lines[i]);
                closed = true;
                i += 1;
                break;
            }
            buffer.push(lines[i]);
            i += 1;
        }
        // An unclosed fence is malformed markdown; skipping it avoids
        // swallowing the rest of the document as "code".
        if (closed) blocks.push(buffer.join("\n"));
    }
    return blocks;
}

function stripCodeBlocks(text) {
    let out = text;
    for (const block of extractCodeBlocks(text)) out = out.split(block).join("\n");
    return out;
}

const URL_PATTERN = /https?:\/\/[^\s)<>"']+/g;
const LINK_PATTERN = /\[[^\]\n]*\]\([^)\n]+\)/g;
const INLINE_CODE_PATTERN = /`[^`\n]+`/g;
const ENV_VAR_PATTERN = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g;
const PATH_PATTERN = /(?:\.{1,2}\/|\/)[\w\-./]+|\b[\w\-.]+\/[\w\-./]+/g;
const VERSION_PATTERN = /\bv?\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?\b/g;
const NUMBER_PATTERN = /\b\d[\d,]*(?:\.\d+)?%?\b/g;
const HEADING_PATTERN = /^(#{1,6})\s+(.*\S)\s*$/gm;
const BULLET_PATTERN = /^\s*(?:[-*+]|\d+\.)\s+/gm;

/**
 * Replace every region that must survive verbatim with an opaque sentinel, so
 * no later transformation can reach inside it. Returns the masked text plus
 * the restore function.
 */
function maskProtected(text) {
    const store = [];
    const sentinel = () => `${MASK_OPEN}${store.length - 1}${MASK_CLOSE}`;
    let out = text;

    for (const block of extractCodeBlocks(text)) {
        const at = out.indexOf(block);
        if (at === -1) continue;
        store.push(block);
        out = `${out.slice(0, at)}${sentinel()}${out.slice(at + block.length)}`;
    }
    for (const pattern of [INLINE_CODE_PATTERN, LINK_PATTERN, URL_PATTERN, ENV_VAR_PATTERN, PATH_PATTERN, VERSION_PATTERN]) {
        out = out.replace(new RegExp(pattern.source, pattern.flags), (match) => {
            store.push(match);
            return sentinel();
        });
    }

    const unmask = (value) => {
        let restored = value;
        let previous = null;
        // Sentinels can nest (a link inside a masked code block never happens,
        // but a restored span may itself contain one), so loop to a fixed point.
        while (restored !== previous) {
            previous = restored;
            restored = restored.replace(
                new RegExp(`${MASK_OPEN}(\\d+)${MASK_CLOSE}`, "g"),
                (whole, index) => store[Number(index)] ?? whole,
            );
        }
        return restored;
    };

    return { masked: out, unmask, protectedCount: store.length };
}

function dropPhrases(text, phrases, counter, key) {
    let out = text;
    for (const phrase of phrases) {
        const re = new RegExp(`(^|[^\\w])${escapeRe(phrase)}\\b[ \\t]*,?[ \\t]*`, "gi");
        out = out.replace(re, (whole, lead) => {
            counter[key] = (counter[key] ?? 0) + 1;
            return lead;
        });
    }
    return out;
}

function tidy(text) {
    return text
        .replace(/[ \t]{2,}/g, " ")
        .replace(/[ \t]+([,.;:!?])/g, "$1")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .replace(/[ \t]+$/gm, "")
        .replace(/^[ \t]+(?=[,.;:])/gm, "");
}

function recapitalize(text) {
    return text
        .replace(/(^|[.!?]\s+|\n\s*(?:[-*+]|\d+\.)\s+|\n#{1,6}\s+|\n\n)([a-z])/g,
            (whole, lead, letter) => `${lead}${letter.toUpperCase()}`);
}

function estimateTokens(text) {
    // Deliberately labelled an estimate: a real count needs the model's
    // tokenizer, which a worker tool has no business guessing at.
    return Math.max(0, Math.round(text.length / 4));
}

function compressionStats(before, after) {
    const beforeWords = words(before).length;
    const afterWords = words(after).length;
    const beforeTokens = estimateTokens(before);
    const afterTokens = estimateTokens(after);
    const pct = (from, to) => (from === 0 ? 0 : round(((from - to) / from) * 100));
    return {
        characters: { before: before.length, after: after.length, reductionPct: pct(before.length, after.length) },
        words: { before: beforeWords, after: afterWords, reductionPct: pct(beforeWords, afterWords) },
        estimatedTokens: { before: beforeTokens, after: afterTokens, reductionPct: pct(beforeTokens, afterTokens) },
        note: "Token figures are a chars/4 estimate, not a tokenizer count. Quote them as estimates.",
    };
}

function cavemanDraft(text, level) {
    const { masked, unmask } = maskProtected(text);
    const removed = {};
    let out = masked;

    out = dropPhrases(out, CAVEMAN_PLEASANTRIES, removed, "pleasantries");
    out = dropPhrases(out, CAVEMAN_HEDGES, removed, "hedges");
    out = dropPhrases(out, CAVEMAN_FILLERS, removed, "fillers");

    for (const [phrase, replacement] of WORDY_PHRASES) {
        const re = new RegExp(`\\b${escapeRe(phrase)}\\b`, "gi");
        out = out.replace(re, () => {
            removed.wordyPhrases = (removed.wordyPhrases ?? 0) + 1;
            return replacement;
        });
    }

    if (level === "full" || level === "ultra") {
        out = out.replace(/(^|[^\w])(?:a|an|the)\b[ \t]*/gi, (whole, lead) => {
            removed.articles = (removed.articles ?? 0) + 1;
            return lead;
        });
        for (const [from, to] of CAVEMAN_SYNONYMS) {
            const re = new RegExp(`\\b${escapeRe(from)}\\b`, "gi");
            out = out.replace(re, () => {
                removed.synonymSwaps = (removed.synonymSwaps ?? 0) + 1;
                return to;
            });
        }
    }

    if (level === "ultra") {
        out = dropPhrases(out, CAVEMAN_CONNECTIVES, removed, "connectives");
        out = dropPhrases(out, CAVEMAN_SOFTENERS, removed, "softeners");
    }

    out = recapitalize(tidy(out));
    return { draft: unmask(out), removed };
}

// ── caveman_check ───────────────────────────────────────────────

function extractInlineCode(text) {
    return stripCodeBlocks(text).match(INLINE_CODE_PATTERN) ?? [];
}

function extractAll(text, pattern) {
    return text.match(new RegExp(pattern.source, pattern.flags)) ?? [];
}

function extractHeadings(text) {
    const out = [];
    for (const match of text.matchAll(HEADING_PATTERN)) out.push(`${match[1]} ${match[2]}`);
    return out;
}

function multisetDelta(before, after) {
    const tally = (list) => list.reduce((map, item) => map.set(item, (map.get(item) ?? 0) + 1), new Map());
    const a = tally(before);
    const b = tally(after);
    const lost = [];
    const added = [];
    for (const [item, count] of a) {
        const have = b.get(item) ?? 0;
        if (have < count) lost.push(count - have === count ? item : `${item} (lost ${count - have} of ${count})`);
    }
    for (const [item, count] of b) {
        const had = a.get(item) ?? 0;
        if (count > had) added.push(item);
    }
    return { lost, added };
}

function cavemanCheck(before, after) {
    const errors = [];
    const warnings = [];
    const checks = {};

    const codeBefore = extractCodeBlocks(before);
    const codeAfter = extractCodeBlocks(after);
    checks.codeBlocks = { before: codeBefore.length, after: codeAfter.length };
    if (codeBefore.length !== codeAfter.length || codeBefore.some((block, i) => block !== codeAfter[i])) {
        errors.push({
            code: "code-block-changed",
            message: "Fenced code blocks are not byte-identical. Code is never compressed — restore it exactly.",
        });
    }

    const inlineDelta = multisetDelta(extractInlineCode(before), extractInlineCode(after));
    checks.inlineCode = { before: extractInlineCode(before).length, after: extractInlineCode(after).length };
    if (inlineDelta.lost.length > 0) {
        errors.push({ code: "inline-code-lost", message: `Inline code dropped: ${inlineDelta.lost.join(", ")}`, items: inlineDelta.lost });
    }
    if (inlineDelta.added.length > 0) {
        warnings.push({ code: "inline-code-added", message: `Inline code appeared that was not in the original: ${inlineDelta.added.join(", ")}`, items: inlineDelta.added });
    }

    const urlDelta = multisetDelta(extractAll(before, URL_PATTERN), extractAll(after, URL_PATTERN));
    checks.urls = { before: extractAll(before, URL_PATTERN).length, after: extractAll(after, URL_PATTERN).length };
    if (urlDelta.lost.length > 0 || urlDelta.added.length > 0) {
        errors.push({
            code: "url-changed",
            message: `URLs must survive verbatim. Lost: [${urlDelta.lost.join(", ")}] Added: [${urlDelta.added.join(", ")}]`,
        });
    }

    const numberSource = (value) => {
        const versions = extractAll(value, VERSION_PATTERN);
        // Strip versions before counting bare numbers, or "v2.1.0" also
        // reports as the number "1.0".
        const withoutVersions = value.replace(new RegExp(VERSION_PATTERN.source, VERSION_PATTERN.flags), " ");
        return [...versions, ...extractAll(withoutVersions, NUMBER_PATTERN)];
    };
    const numberDelta = multisetDelta(numberSource(before), numberSource(after));
    if (numberDelta.lost.length > 0) {
        errors.push({
            code: "number-lost",
            message: `Numbers, versions, or dates were dropped: ${numberDelta.lost.join(", ")}. Compression may not remove evidence.`,
            items: numberDelta.lost,
        });
    }

    const headingsBefore = extractHeadings(before);
    const headingsAfter = extractHeadings(after);
    checks.headings = { before: headingsBefore.length, after: headingsAfter.length };
    if (headingsBefore.length !== headingsAfter.length) {
        errors.push({
            code: "heading-count-changed",
            message: `Heading count changed (${headingsBefore.length} → ${headingsAfter.length}). Structure is not caveman mode's to edit.`,
        });
    } else if (headingsBefore.some((h, i) => h !== headingsAfter[i])) {
        warnings.push({ code: "heading-text-changed", message: "Heading text or order changed; confirm that was intended." });
    }

    const bulletsBefore = extractAll(before, BULLET_PATTERN).length;
    const bulletsAfter = extractAll(after, BULLET_PATTERN).length;
    checks.bullets = { before: bulletsBefore, after: bulletsAfter };
    if (bulletsBefore > 0 && Math.abs(bulletsBefore - bulletsAfter) / bulletsBefore > 0.15) {
        warnings.push({ code: "bullet-drift", message: `Bullet count moved ${bulletsBefore} → ${bulletsAfter}; merging bullets loses claims.` });
    }

    // URLs contain slashes, so they must come out before paths are counted.
    const pathSource = (value) => stripCodeBlocks(value)
        .replace(new RegExp(INLINE_CODE_PATTERN.source, INLINE_CODE_PATTERN.flags), " ")
        .replace(new RegExp(URL_PATTERN.source, URL_PATTERN.flags), " ");
    const pathDelta = multisetDelta(extractAll(pathSource(before), PATH_PATTERN), extractAll(pathSource(after), PATH_PATTERN));
    if (pathDelta.lost.length > 0) {
        warnings.push({ code: "path-lost", message: `File paths no longer present: ${pathDelta.lost.join(", ")}`, items: pathDelta.lost });
    }

    // Style violations the upstream project measured as pure loss.
    const prose = stripCodeBlocks(after).replace(INLINE_CODE_PATTERN, "");
    const proseBefore = stripCodeBlocks(before).replace(INLINE_CODE_PATTERN, "");
    const inventedAdded = INVENTED_ABBREVIATIONS.filter((abbr) => {
        const re = new RegExp(`\\b${abbr}\\b`, "i");
        return re.test(prose) && !re.test(proseBefore);
    });
    if (inventedAdded.length > 0) {
        warnings.push({
            code: "invented-abbreviation",
            message: `Abbreviations introduced that were not in the original: ${inventedAdded.join(", ")}. A tokenizer splits these the same as the full word, so they save nothing and cost the reader a decode.`,
            items: inventedAdded,
        });
    }
    const arrowsAdded = extractAll(prose, ARROW_CHARACTERS).length - extractAll(proseBefore, ARROW_CHARACTERS).length;
    if (arrowsAdded > 0) {
        warnings.push({ code: "arrow-added", message: `${arrowsAdded} arrow character(s) added; an arrow is its own token and replaces a word that was already one token.` });
    }
    const emojiAdded = extractAll(prose, EMOJI_PATTERN).length - extractAll(proseBefore, EMOJI_PATTERN).length;
    if (emojiAdded > 0) {
        warnings.push({ code: "emoji-added", message: `${emojiAdded} emoji added; decoration is not compression.` });
    }

    return {
        ok: errors.length === 0,
        errors,
        warnings,
        checks,
        savings: compressionStats(before, after),
    };
}

// ── Tool definitions ────────────────────────────────────────────

export default {
    createTools: ({ workerNodeId }) => [
        {
            name: "prose_lint",
            description:
                "Lint prose for passive voice, weasel words, hedges, wordy phrases, clichés, repeated words, stray adverbs, and over-long sentences. "
                + "Returns every finding with its line number, the matched text, surrounding context, and a concrete fix. Deterministic and offline.",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "The prose to lint (plain text or markdown)." },
                    ignore: {
                        type: "array",
                        items: { type: "string" },
                        description: "Rule ids to suppress: passive-voice, weasel-word, hedge, wordy-phrase, cliche, repeated-word, adverb, punctuation-shout, long-sentence.",
                    },
                    maxFindings: { type: "number", description: "Cap on returned findings (default 120)." },
                },
                required: ["text"],
            },
            handler: async ({ text, ignore = [], maxFindings = 120 } = {}) => {
                const source = requireText(text, "text");
                const suppressed = new Set((Array.isArray(ignore) ? ignore : []).map((r) => String(r)));
                const all = lintProse(source).filter((f) => !suppressed.has(f.rule));
                const limit = Math.max(1, Math.min(1000, Math.floor(maxFindings)));
                const byRule = {};
                for (const f of all) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
                return {
                    summary: {
                        totalFindings: all.length,
                        byRule,
                        wordCount: words(source).length,
                        findingsPerHundredWords: round((all.length / Math.max(1, words(source).length)) * 100),
                    },
                    findings: all.slice(0, limit),
                    truncated: all.length > limit,
                    analyzedOn: workerNodeId,
                };
            },
        },
        {
            name: "readability_score",
            description:
                "Score readability: word/sentence/syllable counts, Flesch Reading Ease, Flesch–Kincaid grade, Gunning Fog, reading time, "
                + "and the three longest sentences. Use it before and after an edit to show the change instead of asserting it.",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "The prose to score." },
                },
                required: ["text"],
            },
            handler: async ({ text } = {}) => ({
                ...readability(requireText(text, "text")),
                analyzedOn: workerNodeId,
            }),
        },
        {
            name: "text_diff",
            description:
                "Diff two versions of a passage and return a redline ({+added+}, [-removed-]), per-segment operations, and change statistics. "
                + "Use it to show the user exactly what an edit changed. Line granularity by default; word granularity for sentence-level rewrites.",
            parameters: {
                type: "object",
                properties: {
                    before: { type: "string", description: "The original text." },
                    after: { type: "string", description: "The edited text." },
                    granularity: { type: "string", enum: ["line", "word"], description: "Diff unit (default line)." },
                },
                required: ["before", "after"],
            },
            handler: async ({ before, after, granularity = "line" } = {}) => {
                const from = requireText(before, "before");
                const to = requireText(after, "after");
                const unit = granularity === "word" ? "word" : "line";
                return { ...diffTexts(from, to, unit), analyzedOn: workerNodeId };
            },
        },
        {
            name: "heading_outline",
            description:
                "Extract a markdown document's heading outline with per-section word counts, and report structural problems: missing or duplicated H1, "
                + "skipped heading levels, empty or over-long sections, and unresolved TODO/TBD/FIXME placeholders. Code fences are ignored.",
            parameters: {
                type: "object",
                properties: {
                    markdown: { type: "string", description: "The markdown document." },
                },
                required: ["markdown"],
            },
            handler: async ({ markdown } = {}) => ({
                ...outlineMarkdown(requireText(markdown, "markdown")),
                analyzedOn: workerNodeId,
            }),
        },
        {
            name: "term_consistency",
            description:
                "Check that product names and technical terms are spelled and capitalized one way throughout. Pass the canonical spellings in `terms`; "
                + "common variant pairs (email/e-mail, website/web site, login/log in, …) are checked automatically.",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "The document to check." },
                    terms: {
                        type: "array",
                        items: { type: "string" },
                        description: 'Canonical spellings, e.g. ["PilotSwarm", "PostgreSQL", "sub-agent"].',
                    },
                },
                required: ["text"],
            },
            handler: async ({ text, terms = [] } = {}) => ({
                ...termConsistency(
                    requireText(text, "text"),
                    (Array.isArray(terms) ? terms : []).map((t) => String(t)).filter((t) => t.trim() !== ""),
                ),
                analyzedOn: workerNodeId,
            }),
        },
        {
            name: "caveman_draft",
            description:
                "OPTIONAL caveman-speak pass. Runs the mechanical half of the compression — drops pleasantries, hedges, fillers, wordy phrases, "
                + "and (at full/ultra) articles, softeners, and connective fluff — while masking code blocks, inline code, URLs, links, file paths, "
                + "environment variables, and version numbers so they come back byte-identical. "
                + "The output is a DRAFT, not an answer: it will read roughly, and you must repair it by judgement before showing anyone. "
                + "Levels: lite (keeps articles and full sentences), full (classic caveman), ultra (maximum terseness). "
                + "Never run this unless the user asked for caveman mode.",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "The prose to compress." },
                    level: { type: "string", enum: ["lite", "full", "ultra"], description: "Intensity (default full)." },
                },
                required: ["text"],
            },
            handler: async ({ text, level = "full" } = {}) => {
                const source = requireText(text, "text");
                const intensity = CAVEMAN_LEVELS.includes(level) ? level : "full";
                const { draft, removed } = cavemanDraft(source, intensity);
                return {
                    level: intensity,
                    draft,
                    removed,
                    savings: compressionStats(source, draft),
                    warning: "Mechanical pass only. Read it, repair the grammar, restore anything that became ambiguous, then verify with caveman_check.",
                    guardrail: "Do not apply this to security warnings, destructive or irreversible steps, legal text, or ordered procedures where dropped articles change the meaning.",
                    analyzedOn: workerNodeId,
                };
            },
        },
        {
            name: "caveman_check",
            description:
                "Verify a caveman-speak (or any compression) conversion. ERRORS on anything load-bearing that was lost: altered code blocks, dropped inline code, "
                + "changed URLs, missing numbers/versions/dates, changed heading count. WARNS on bullet drift, lost paths, and compression anti-patterns — "
                + "invented abbreviations, added arrows, added emoji. Also reports measured character, word, and estimated-token savings. "
                + "A conversion is not finished until this returns ok: true.",
            parameters: {
                type: "object",
                properties: {
                    before: { type: "string", description: "The original text." },
                    after: { type: "string", description: "The compressed text." },
                },
                required: ["before", "after"],
            },
            handler: async ({ before, after } = {}) => ({
                ...cavemanCheck(requireText(before, "before"), requireText(after, "after")),
                analyzedOn: workerNodeId,
            }),
        },
    ],
};

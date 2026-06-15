#!/usr/bin/env node
/**
 * Corpus builder: pulls a REAL pgsql-hackers thread from the public
 * postgresql.org archives and emits pgsql-hackers-real.json for the
 * harvester scenarios (06-provider-test-plan §10).
 *
 * Source thread: "[HACKERS] [PATCH] Generic type subscripting" — the actual
 * patch series that became jsonb subscripting (commit 676887a3). Public
 * mailing-list archive; sender names/addresses are part of the public record.
 *
 * Usage:
 *   node build-pgsql-hackers-real.mjs [--max 60] [--out pgsql-hackers-real.json]
 *
 * No dependencies (Node >= 18, global fetch). Re-runnable: output is
 * deterministic for a fixed archive state except `fetchedAt`.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ENTRY_FLAT_URLS = [
    // One thread, multiple entry points (postgresql.org flat view renders the
    // thread containing the message; the mega-thread spans 2017..2021 and the
    // archive serves it in segments). Order = chronological.
    "https://www.postgresql.org/message-id/flat/CA%2Bq6zcVovR%2BXY4mfk-7oNk-rF91gH0PebnNfuUjuuDsyHjOcVA%40mail.gmail.com", // 2017 start
    "https://www.postgresql.org/message-id/flat/20210102141411.5xa6asqp5arjumeq%40localhost", // 2021 finale segment
];

const UA = "pilotswarm-eval-corpus-builder/0.1 (incubator test corpus; one-shot fetch)";

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const MAX_MESSAGES = parseInt(argVal("max", "60"), 10);
const OUT = argVal("out", join(dirname(fileURLToPath(import.meta.url)), "pgsql-hackers-real.json"));
const MAX_BODY = 2500;

function decodeEntities(s) {
    return s
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

function htmlToText(html) {
    return decodeEntities(
        html
            .replace(/<br\s*\/?>(\n)?/gi, "\n")
            .replace(/<\/p>/gi, "\n")
            .replace(/<[^>]+>/g, ""),
    );
}

/** Strip quoted reply lines + signatures; collapse whitespace; cap length. */
function cleanBody(text, cap = MAX_BODY) {
    const lines = text.split("\n");
    const kept = [];
    for (const raw of lines) {
        const line = raw.replace(/\s+$/, "");
        if (/^\s*>/.test(line)) continue;               // quoted reply
        if (/^\s*On .{10,120} wrote:\s*$/.test(line)) continue; // attribution line
        if (/^--\s*$/.test(line)) break;                 // signature delimiter
        kept.push(line);
    }
    let body = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (body.length > cap) {
        const cut = body.lastIndexOf("\n", cap);
        body = body.slice(0, cut > cap * 0.6 ? cut : cap).trimEnd() + "\n[... truncated for corpus ...]";
    }
    return body;
}

/**
 * Parse a postgresql.org flat-thread page into message records.
 * Resilient to layout drift: locates each message by its header table
 * (From/Date/Subject/Message-ID rows) followed by the message-content div.
 */
function parseFlatPage(html) {
    const messages = [];
    // Each message: <table class="table message-header"> ... </table> followed
    // by <div class="message-content ..."> ... </div>
    const blockRe = /<table[^>]*message-header[^>]*>([\s\S]*?)<\/table>\s*<div[^>]*message-content[^>]*>([\s\S]*?)<\/div>/g;
    let m;
    while ((m = blockRe.exec(html)) !== null) {
        const header = m[1];
        const content = m[2];
        const row = (label) => {
            const r = new RegExp(`<th[^>]*>\\s*${label}:?\\s*<\\/th>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>`, "i").exec(header);
            return r ? htmlToText(r[1]).replace(/\s+/g, " ").trim() : null;
        };
        const from = row("From");
        const date = row("Date");
        const subject = row("Subject");
        let messageId = row("Message-ID") || row("Message-Id");
        if (messageId) messageId = messageId.replace(/^<|>$/g, "").trim();
        const body = cleanBody(htmlToText(content));
        if (from && body) messages.push({ id: messageId, from, subject, date, body });
    }
    return messages;
}

async function fetchPage(url) {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return await res.text();
}

const seen = new Set();
const all = [];
for (const url of ENTRY_FLAT_URLS) {
    if (all.length >= MAX_MESSAGES) break;
    process.stderr.write(`fetching ${url}\n`);
    const html = await fetchPage(url);
    const msgs = parseFlatPage(html);
    process.stderr.write(`  parsed ${msgs.length} messages\n`);
    if (msgs.length === 0) {
        process.stderr.write(`  WARNING: 0 messages parsed — archive layout may have drifted; first 500 chars:\n${html.slice(0, 500)}\n`);
    }
    for (const msg of msgs) {
        const key = msg.id ?? `${msg.from}|${msg.date}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(msg);
        if (all.length >= MAX_MESSAGES) break;
    }
}

if (all.length < 30) {
    process.stderr.write(`ERROR: only ${all.length} messages collected (< 30). Refusing to write a thin corpus.\n`);
    process.exit(1);
}

// Metadata for metadata-derived scenario invariants (06 §10): participants,
// per-author counts, multi-message authors (reinforcement candidates).
const byAuthor = new Map();
for (const msg of all) {
    // Normalize "Name <addr>" → name part for counting; keep raw in messages.
    const name = msg.from.replace(/<[^>]*>/, "").replace(/"|\(.*?\)/g, "").trim() || msg.from;
    byAuthor.set(name, (byAuthor.get(name) ?? 0) + 1);
}
const participants = [...byAuthor.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, messages: count }));

const corpus = {
    scenario: "postgres pgsql-hackers mailing list — Generic type subscripting (REAL archive data)",
    description:
        "Real messages pulled from the public postgresql.org archives for the " +
        "'[HACKERS] [PATCH] Generic type subscripting' thread — the patch series that " +
        "became jsonb subscripting. Bodies have quoted reply lines stripped and are " +
        `capped at ${MAX_BODY} chars. Used by the harvester scenarios ` +
        "(docs/proposals/enhancedfactstore/06-provider-test-plan.md §10); scenario " +
        "invariants are derived from the metadata block below, not hand-authored.",
    source: {
        list: "pgsql-hackers",
        threads: ENTRY_FLAT_URLS,
        fetchedAt: new Date().toISOString(),
        note: "Public mailing-list archive content; regenerate with build-pgsql-hackers-real.mjs",
    },
    metadata: {
        messageCount: all.length,
        participants,
        multiMessageAuthors: participants.filter((p) => p.messages >= 2).map((p) => p.name),
    },
    messages: all,
};

writeFileSync(OUT, JSON.stringify(corpus, null, 2) + "\n");
process.stderr.write(`wrote ${OUT}: ${all.length} messages, ${participants.length} participants\n`);

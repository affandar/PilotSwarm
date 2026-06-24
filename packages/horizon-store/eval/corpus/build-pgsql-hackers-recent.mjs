#!/usr/bin/env node
/**
 * Recent-corpus builder: pulls the LAST 3 MONTHS of pgsql-hackers traffic from
 * the public postgresql.org archives, using each month's listed messages as
 * thread ENTRY POINTS and expanding every one to its FULL flat thread.
 *
 * Distinct from build-pgsql-hackers-real.mjs (which is pinned to one historical
 * thread for deterministic scenario invariants). This emits a SEPARATE file
 * (pgsql-hackers-recent.json) so the frozen scenario corpus is never disturbed.
 *
 * Usage:
 *   node build-pgsql-hackers-recent.mjs [--months 3] [--threads 30] \
 *        [--max 150] [--out pgsql-hackers-recent.json]
 *
 * No dependencies (Node >= 18, global fetch). Polite: serial fetches with a
 * small delay; dedupes threads (once a thread is pulled, its member ids are
 * marked seen so other entry points in the same thread are skipped).
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const UA = "pilotswarm-eval-corpus-builder/0.2 (incubator test corpus; thread expansion)";
const MAX_BODY = 2500;
const FETCH_DELAY_MS = 400;

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const MONTHS = parseInt(argVal("months", "3"), 10);
const MAX_THREADS = parseInt(argVal("threads", "30"), 10);
const MAX_MESSAGES = parseInt(argVal("max", "150"), 10);
// Cap per thread so one mega-thread (some span thousands of messages back
// years) cannot swamp the corpus — we want a rich mix across many threads.
const PER_THREAD = parseInt(argVal("per-thread", "12"), 10);
const OUT = argVal("out", join(dirname(fileURLToPath(import.meta.url)), "pgsql-hackers-recent.json"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        if (/^\s*>/.test(line)) continue;
        if (/^\s*On .{10,120} wrote:\s*$/.test(line)) continue;
        if (/^--\s*$/.test(line)) break;
        kept.push(line);
    }
    let body = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (body.length > cap) {
        const cut = body.lastIndexOf("\n", cap);
        body = body.slice(0, cut > cap * 0.6 ? cut : cap).trimEnd() + "\n[... truncated for corpus ...]";
    }
    return body;
}

/** Parse a postgresql.org flat-thread page into message records. */
function parseFlatPage(html) {
    const messages = [];
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

/** Last `n` months as YYYY-MM strings, most-recent first. */
function recentMonths(n) {
    const out = [];
    const d = new Date();
    for (let i = 0; i < n; i++) {
        out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
        d.setUTCMonth(d.getUTCMonth() - 1);
    }
    return out;
}

/** Ordered, de-duplicated message-id entry points from a month's index page. */
function parseMonthIndex(html) {
    const ids = [];
    const seen = new Set();
    for (const m of html.matchAll(/\/message-id\/([^"#?\s]+)/g)) {
        const id = decodeURIComponent(m[1]);
        if (id === "flat" || id.startsWith("flat/")) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    return ids;
}

// ── crawl ─────────────────────────────────────────────────────────────────────

const months = recentMonths(MONTHS);
process.stderr.write(`months: ${months.join(", ")}\n`);

// 1) gather entry points from each monthly index (most-recent month first).
const entryPoints = [];
for (const ym of months) {
    const url = `https://www.postgresql.org/list/pgsql-hackers/${ym}/`;
    process.stderr.write(`index ${url}\n`);
    try {
        const html = await fetchPage(url);
        const ids = parseMonthIndex(html);
        process.stderr.write(`  ${ids.length} message-id entry points\n`);
        entryPoints.push(...ids);
    } catch (e) {
        process.stderr.write(`  WARNING: ${e.message}\n`);
    }
    await sleep(FETCH_DELAY_MS);
}

// 2) expand entry points to full threads, deduping by thread membership.
const seenMsgIds = new Set();
const messages = [];
let threadCount = 0;
const threadsPulled = [];

for (const entry of entryPoints) {
    if (threadCount >= MAX_THREADS || messages.length >= MAX_MESSAGES) break;
    if (seenMsgIds.has(entry)) continue; // already covered by a pulled thread
    const url = `https://www.postgresql.org/message-id/flat/${encodeURIComponent(entry)}`;
    let thread;
    try {
        thread = parseFlatPage(await fetchPage(url));
    } catch (e) {
        process.stderr.write(`  thread fetch failed (${entry}): ${e.message}\n`);
        await sleep(FETCH_DELAY_MS);
        continue;
    }
    await sleep(FETCH_DELAY_MS);
    if (thread.length === 0) continue;

    threadCount++;
    // Take at most PER_THREAD messages from the thread head — the root +
    // early replies establish the topic, patch, and primary participants best.
    const slice = thread.slice(0, PER_THREAD);
    threadsPulled.push({ entry, subject: thread[0].subject, messages: thread.length, taken: slice.length });
    process.stderr.write(`  thread ${threadCount}: "${(thread[0].subject || "").slice(0, 60)}" (${thread.length} msgs, took ${slice.length})\n`);

    // Mark ALL thread member ids seen (so other entry points in this thread are
    // skipped) even though we only KEEP the head slice.
    for (const msg of thread) if (msg.id) seenMsgIds.add(msg.id);

    for (const msg of slice) {
        if (messages.length >= MAX_MESSAGES) break;
        // global dedupe by id (threads overlap when cross-posted)
        if (msg.id && messages.some((x) => x.id === msg.id)) continue;
        messages.push(msg);
    }
}

if (messages.length < 20) {
    process.stderr.write(`ERROR: only ${messages.length} messages collected (< 20). Refusing to write a thin corpus.\n`);
    process.exit(1);
}

// ── metadata (mirrors build-pgsql-hackers-real.mjs shape) ──────────────────────

const byAuthor = new Map();
for (const msg of messages) {
    const name = msg.from.replace(/<[^>]*>/, "").replace(/"|\(.*?\)/g, "").trim() || msg.from;
    byAuthor.set(name, (byAuthor.get(name) ?? 0) + 1);
}
const participants = [...byAuthor.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, messages: count }));

const corpus = {
    scenario: "postgres pgsql-hackers mailing list — last 3 months, full threads (REAL archive data)",
    description:
        `Real messages pulled from the public postgresql.org archives for the last ${MONTHS} ` +
        "months of pgsql-hackers. Each month's listed messages are used as thread entry points " +
        "and expanded to the full flat thread. Bodies have quoted reply lines stripped and are " +
        `capped at ${MAX_BODY} chars. Caps: ${MAX_THREADS} threads / ${MAX_MESSAGES} messages.`,
    source: {
        list: "pgsql-hackers",
        months,
        threads: threadsPulled,
        fetchedAt: new Date().toISOString(),
        note: "Public mailing-list archive content; regenerate with build-pgsql-hackers-recent.mjs",
    },
    metadata: {
        messageCount: messages.length,
        threadCount,
        participants,
        multiMessageAuthors: participants.filter((p) => p.messages >= 2).map((p) => p.name),
    },
    messages,
};

writeFileSync(OUT, JSON.stringify(corpus, null, 2) + "\n");
process.stderr.write(`wrote ${OUT}: ${messages.length} messages across ${threadCount} threads, ${participants.length} participants\n`);

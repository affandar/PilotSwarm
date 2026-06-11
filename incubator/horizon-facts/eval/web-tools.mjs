// eval/web-tools.mjs — a REAL, dependency-free web tool pair for the eval baseline.
//
// Why this exists: the Copilot SDK's built-in web tools are unusable in this
// embedded harness — `web_fetch` throws `TypeError: Cannot read properties of
// undefined (reading 'trim')` on every URL, and `web_search` isn't wired up at
// all (the model hallucinates it). The user's baseline must genuinely be
// "parametric knowledge + the web", so we give it real, working tools built on
// Node's global fetch. We own both sides of the eval, so this is fair: it makes
// the baseline as strong as the question intends, rather than crippling it with
// a broken built-in.
//
// Reliability notes (verified against the live web from this environment):
//   • Direct fetch of postgresql.org works perfectly (the REPACK thread returns
//     ~196 KB); the monthly archive indexes are static and list every thread.
//   • DuckDuckGo's HTML/lite endpoints rate-limit aggressively (24 KB then empty
//     on the second hit), so web_search tries DDG best-effort but ALWAYS also
//     returns the official pgsql-hackers archive entry points so the model can
//     navigate the authoritative source even when DDG yields nothing.

import { defineTool } from "@github/copilot-sdk";

const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0";
const FETCH_TIMEOUT_MS = 15_000;

async function httpGet(url, { method = "GET", body } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
        const r = await fetch(url, {
            method, body, signal: ac.signal,
            headers: { "user-agent": UA, "accept": "text/html,application/xhtml+xml" },
            redirect: "follow",
        });
        const text = await r.text();
        return { status: r.status, text };
    } finally { clearTimeout(timer); }
}

/** Strip HTML to readable-ish text: drop script/style, unwrap tags, decode the
 * handful of entities that matter, collapse whitespace. Crude but enough for an
 * LLM to read a page. */
function htmlToText(html) {
    let s = String(html);
    s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
    s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
    s = s.replace(/<!--[\s\S]*?-->/g, " ");
    s = s.replace(/<\/(p|div|li|tr|h[1-6]|br|pre|blockquote)>/gi, "\n");
    s = s.replace(/<br\s*\/?>/gi, "\n");
    s = s.replace(/<[^>]+>/g, " ");
    s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
         .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
         .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    s = s.replace(/[ \t\f\v]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").replace(/^\s+|\s+$/gm, "");
    return s.trim();
}

const PG_LIST = "pgsql-hackers";

/** Best-effort DuckDuckGo results (titles + urls + snippets). May be empty when
 * DDG rate-limits — callers must not depend on it alone. */
async function duckduckgo(query) {
    try {
        const { status, text } = await httpGet(
            `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { method: "POST", body: "" });
        if (status !== 200) return [];
        const out = [];
        const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        let m;
        while ((m = re.exec(text)) && out.length < 8) {
            const title = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            let href = m[1];
            const uddg = href.match(/[?&]uddg=([^&]+)/);
            if (uddg) href = decodeURIComponent(uddg[1]);
            if (title) out.push({ title, url: href });
        }
        return out;
    } catch { return []; }
}

/** Parse a postgresql.org monthly archive index into {subject, url} thread links. */
function parseArchiveIndex(html) {
    const out = [];
    const re = /href="(\/message-id\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && out.length < 60) {
        const subject = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        if (subject) out.push({ subject, url: `https://www.postgresql.org${m[1]}` });
    }
    return out;
}

export function buildWebTools({ record } = {}) {
    const rec = (entry) => { record?.push(entry); };

    const webFetch = defineTool("web_fetch", {
        description:
            "Fetch a URL from the public internet and return its readable text content. Use this to read " +
            "postgresql.org documentation and the public pgsql-hackers mailing-list archive. The archive " +
            "lives at https://www.postgresql.org/list/pgsql-hackers/ with monthly indexes at " +
            "https://www.postgresql.org/list/pgsql-hackers/YYYY-MM/ and per-message permalinks at " +
            "https://www.postgresql.org/message-id/<message-id>.",
        parameters: {
            type: "object",
            properties: {
                url: { type: "string", description: "Absolute http(s) URL to fetch." },
                max_length: { type: "number", description: "Max characters of text to return (default 6000)." },
            },
            required: ["url"],
        },
        skipPermission: true,
        // Intentionally replace the SDK's built-in web_fetch, which throws
        // `TypeError: ...reading 'trim'` on every URL in this embedded harness.
        overridesBuiltInTool: true,
        handler: async (a) => {
            const url = String(a?.url || "").trim();
            const max = Math.min(Math.max(Number(a?.max_length) || 6000, 500), 20000);
            const t0 = performance.now();
            const entry = { name: "web_fetch", args: { url }, startedAt: Date.now() };
            try {
                if (!/^https?:\/\//i.test(url)) throw new Error("url must be absolute http(s)");
                const { status, text } = await httpGet(url);
                const body = htmlToText(text).slice(0, max);
                entry.durationMs = +(performance.now() - t0).toFixed(1);
                rec(entry);
                if (status >= 400) return { status, error: `HTTP ${status}`, content: body.slice(0, 1000) };
                return { status, url, content: body, truncated: text.length > max };
            } catch (err) {
                entry.durationMs = +(performance.now() - t0).toFixed(1);
                entry.error = String(err?.message ?? err);
                rec(entry);
                return { error: `fetch failed: ${entry.error}` };
            }
        },
    });

    const webSearch = defineTool("web_search", {
        description:
            "Search the web for a query and return result titles + URLs. Good for finding PostgreSQL docs and " +
            "pgsql-hackers mailing-list threads. Results always include the official pgsql-hackers archive entry " +
            "points so you can browse the authoritative source with web_fetch.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "Search query, e.g. 'REPACK CONCURRENTLY pgsql-hackers'." },
                month: { type: "string", description: "Optional pgsql-hackers archive month 'YYYY-MM' to list threads from." },
            },
            required: ["query"],
        },
        skipPermission: true,
        // Intentionally replace the SDK's built-in web_search, which isn't wired
        // up in this embedded harness (the model otherwise hallucinates it).
        overridesBuiltInTool: true,
        handler: async (a) => {
            const query = String(a?.query || "").trim();
            const month = String(a?.month || "").trim();
            const t0 = performance.now();
            const entry = { name: "web_search", args: { query, month }, startedAt: Date.now() };
            try {
                const web = await duckduckgo(query.includes("pgsql") || query.includes("postgres") ? query : `${query} postgresql pgsql-hackers`);
                // Always offer the authoritative archive as navigable entry points.
                const archive = [
                    { title: "pgsql-hackers archive (browse by month: append YYYY-MM/)", url: `https://www.postgresql.org/list/${PG_LIST}/` },
                    { title: "PostgreSQL documentation (current)", url: "https://www.postgresql.org/docs/current/" },
                ];
                let monthThreads = [];
                if (/^\d{4}-\d{2}$/.test(month)) {
                    const { status, text } = await httpGet(`https://www.postgresql.org/list/${PG_LIST}/${month}/`);
                    if (status === 200) monthThreads = parseArchiveIndex(text).slice(0, 25).map((t) => ({ title: `[${month}] ${t.subject}`, url: t.url }));
                }
                entry.durationMs = +(performance.now() - t0).toFixed(1);
                rec(entry);
                const results = [...web, ...monthThreads, ...archive].slice(0, 20);
                return {
                    query, count: results.length, results,
                    hint: web.length === 0
                        ? "General web search returned nothing (rate-limited). Use web_fetch on the archive entry points; pass month='YYYY-MM' to list that month's threads."
                        : undefined,
                };
            } catch (err) {
                entry.durationMs = +(performance.now() - t0).toFixed(1);
                entry.error = String(err?.message ?? err);
                rec(entry);
                return { error: `search failed: ${entry.error}` };
            }
        },
    });

    return { tools: [webFetch, webSearch], toolNames: ["web_fetch", "web_search"] };
}

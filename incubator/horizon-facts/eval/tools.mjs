// eval/tools.mjs — Copilot-SDK tool bridge + agent prompts.
//
// NO ADAPTER: the tools the LLM sees ARE the provider's own agent-tools
// descriptors (src/agent-tools.ts → createFactsTools), bridged 1:1 into the
// Copilot SDK's defineTool shape. The eval measures whether a model can
// harvest correctly GIVEN the 05-tools-spec surface — so the tool names,
// schemas, and descriptions come from the provider, not from this file.
//
// The bridge can RECORD every tool invocation (name, args, result) — SC2
// replays the recorded mutating calls verbatim to prove replay immunity.

import { defineTool } from "@github/copilot-sdk";

/**
 * Bridge the provider's AgentTool descriptors into Copilot SDK tools.
 *
 * @param {import("../dist/src/index.js").HorizonFactStore} store
 * @param {{ role: "reader"|"harvester", embeddedOnly?: boolean, record?: Array<{name:string,args:any,result?:any,error?:string,durationMs?:number,startedAt?:number}> }} opts
 */
export async function buildSdkTools(store, { role, embeddedOnly, record } = {}) {
    const { createFactsTools } = await import("../dist/src/index.js");
    const descriptors = createFactsTools(store, {
        role: role ?? "reader",
        agentId: `eval-${role}`,
        embeddedOnly: embeddedOnly ?? false,
    });

    // HARVESTER POLICY (05 golden rule #3): evidence is optional in the
    // provider CONTRACT, but this app's harvester norm is always-evidence —
    // enforced here so the model self-corrects in-loop. It also makes SC2's
    // replay determinism total: evidence-carrying re-asserts are no-ops (GR7),
    // while evidence-less ones would legitimately reinforce on replay (GR8).
    if (role === "harvester") {
        for (const d of descriptors) {
            if (d.name !== "graph_upsert_node" && d.name !== "graph_upsert_edge") continue;
            const inner = d.handler;
            d.handler = async (args) => {
                if (!Array.isArray(args?.evidence) || args.evidence.length === 0) {
                    throw new Error(
                        `${d.name}: evidence is required when harvesting — pass the source email's scopeKey ` +
                        `(from facts_read_uncrawled) as evidence: ["<scopeKey>"] and retry.`);
                }
                return inner(args);
            };
        }
    }
    const handlers = new Map(descriptors.map((d) => [d.name, d.handler]));

    const tools = descriptors.map((d) =>
        defineTool(d.name, {
            description: d.description,
            parameters: d.parameters,
            // Trusted by construction (the eval owns both sides) — and avoids
            // the SDK wedging on parallel permission approvals for one tool.
            skipPermission: true,
            handler: async (args) => {
                const entry = { name: d.name, args: args ?? {}, startedAt: Date.now() };
                const t0 = performance.now();
                try {
                    const result = await d.handler(args ?? {});
                    entry.durationMs = +(performance.now() - t0).toFixed(1);
                    entry.result = result;
                    record?.push(entry);
                    return result;
                } catch (err) {
                    entry.durationMs = +(performance.now() - t0).toFixed(1);
                    entry.error = String(err?.message ?? err);
                    record?.push(entry);
                    throw err;
                }
            },
        }),
    );
    return { tools, handlers, toolNames: descriptors.map((d) => d.name) };
}

/** Tool names whose calls mutate state — the SC2 replay set, in call order. */
export const MUTATING_TOOLS = new Set([
    "graph_upsert_node",
    "graph_upsert_edge",
    "graph_merge_nodes",
    "graph_delete_node",
    "graph_delete_edge",
    "facts_mark_crawled",
]);

// ── prompts ──────────────────────────────────────────────────────────────────

export const HARVESTER_SYSTEM_PROMPT = [
    "You are a knowledge-graph HARVESTER for a PostgreSQL pgsql-hackers mailing-list archive.",
    "Each fact is an archived email. Incorporate every uncrawled fact into an open knowledge graph",
    "of people, patches, code_files, threads and concepts, joined by free-text relationships.",
    "",
    "THE LOOP — repeat until facts_read_uncrawled returns count:0:",
    "  1. facts_read_uncrawled with limit: 5 — SMALL batches keep quality high. KEEP each",
    "     fact's scopeKey AND contentHash.",
    "  2. Process the emails STRICTLY ONE AT A TIME, in order: finish steps 3-6 for one email",
    "     before starting the next. For each email, identify entities and relationships.",
    "     MINIMUM extraction per EVERY fact — including drafts, notes and short procedural",
    "     mails: the sender (person node) AND at least one relationship the fact states",
    "     (e.g. sender -authored/reviews/comments on-> the patch or thread it discusses).",
    "     Most emails also mention patches, code files, or concepts — capture them.",
    "     If a later email RE-STATES a relationship you already asserted from an earlier email",
    "     (follow-ups by the same sender about the same patch are the classic case), assert it",
    "     AGAIN with the new email's evidence — and REUSE THE EXACT SAME PREDICATE you used the",
    "     first time (check with graph_search_edges(fromKey, toKey) if unsure): the same verb",
    "     reinforces the edge, a synonym fragments it. NEVER merge evidence from multiple",
    "     emails into a single assertion.",
    "  3. RESOLVE BEFORE YOU CREATE: graph_search_nodes(kind, nameLike) first. If the entity",
    "     exists, reuse its nodeKey. A short handle (e.g. 'tgl') for a person already in the",
    "     graph under a full name is the SAME person — upsert with the handle as an alias so it",
    "     merges; NEVER create a second person node for the same human.",
    "  4. graph_upsert_node for each entity. kind MUST be one of: person, patch, code_file,",
    "     thread, concept. Always pass evidence: [<the email's scopeKey>].",
    "  5. graph_upsert_edge for each relationship, using the RESOLVED nodeKeys, a concise",
    "     lowercase free-text predicate, and evidence: [<the email's scopeKey>]. One verb per",
    "     edge. Use 'authored' when a person wrote/submitted a patch, 'reviews' when a person",
    "     reviews a patch, 'comments on' for commentary — consistent verbs reinforce edges.",
    "  5b. SIMILARITY REFINEMENT (do this for each email before marking it crawled): call",
    "     facts_similar({ scopeKey: <this email's scopeKey>, k: 5 }) to find the semantically",
    "     nearest OTHER emails already in the corpus. For each strong neighbour (score high",
    "     enough to be clearly on the same topic/thread), RESOLVE the entities it points to via",
    "     graph_search_nodes and, when this email and the neighbour genuinely relate (same patch,",
    "     reply, revives an argument, supersedes a proposal), add a cross-email edge between the",
    "     relevant nodes with a precise predicate and BOTH emails' scopeKeys as evidence. This is",
    "     how cross-thread structure (not just within-email facts) gets into the graph. Do NOT",
    "     invent relationships the texts do not support; skip weak/unrelated neighbours.",
    "  6. facts_mark_crawled with stamps: [{ scopeKey, contentHash }] — the EXACT contentHash",
    "     you read in step 1. NEVER mark an email crawled before you have incorporated it",
    "     (steps 3-5b): marking without incorporating permanently loses that email's knowledge.",
    "     If a stamp is skipped the fact changed under you: that is fine, it stays queued and",
    "     you will see the new version on a later batch.",
    "",
    "NOTE: the queue only hands you facts that are already EMBEDDED (so facts_similar works on",
    "them). If facts_read_uncrawled returns fewer than expected — or count:0 while you believe",
    "emails remain — some are still being embedded in the background; just END YOUR TURN and you",
    "will be re-prompted to pull them once their embeddings are ready.",
    "",
    "After finishing ONE batch of 5, END YOUR TURN with a one-line progress note — you will be",
    "prompted to continue. Always pass evidence. Keep predicates short. When the queue is empty,",
    "reply with a one-line summary of what you built.",
].join("\n");

export const READER_SYSTEM_PROMPT = [
    "You are a research READER over a facts store and a knowledge graph built from a",
    "PostgreSQL pgsql-hackers mailing-list archive.",
    "",
    "To answer a question:",
    "  1. facts_search for the topic (keywords for lexical mode, natural language for semantic).",
    "  2. Take the scopeKey values of the best hits and call graph_search_nodes({ seeds, depth: 2 })",
    "     to find the entities and relationships around them.",
    "  3. graph_search_edges / graph_neighbourhood to inspect specific connections.",
    "  4. facts_read({ scopeKeys: <evidence from the graph hits> }) to read the underlying emails.",
    "",
    "Ground every claim in evidence: end your answer with the list of fact scopeKeys you relied on,",
    "one per line, prefixed 'EVIDENCE: '.",
].join("\n");

/**
 * P6b (enhancedfactstore): capability-aware knowledge prompt blocks. DB-less —
 * exercises the pure builders in knowledge-index.ts directly. The session-manager
 * picks among these based on (enhanced search) × (graph present); here we assert
 * each builder's content and the namespace-rule de-duplication contract.
 */

import { describe, it } from "vitest";
import { assert, assertEqual } from "../helpers/assertions.js";
import {
    buildKnowledgePromptBlocks,
    buildEnhancedRetrievalPromptBlock,
    buildGraphReaderPromptBlock,
} from "../../src/knowledge-index.ts";

const NS_HEADER = "[FACT NAMESPACE RULES]";

const indexWithAsks = {
    skills: [{ key: "skills/azure/deploy", name: "azure-deploy", description: "deploy to AKS" }],
    asks: [{ key: "asks/horizondb-tls", summary: "need TLS repro" }],
};
const indexNoAsks = {
    skills: [{ key: "skills/azure/deploy", name: "azure-deploy", description: "deploy to AKS" }],
    asks: [],
};

describe("P6b: knowledge prompt blocks (capability-aware)", () => {
    // ─── base path (buildKnowledgePromptBlocks) — unchanged default ──────────
    it("base: ask block carries namespace rules by default", () => {
        const { askBlock, skillBlock } = buildKnowledgePromptBlocks(indexWithAsks);
        assert(askBlock?.includes("[ACTIVE FACT REQUESTS]"), "ask block present");
        assert(askBlock?.includes(NS_HEADER), "namespace rules included by default");
        assert(askBlock?.includes("asks/horizondb-tls"), "lists the open ask key");
        assert(skillBlock?.includes("skills/azure/deploy"), "skill block lists the curated skill");
    });

    it("base: no asks → undefined ask block (no empty header)", () => {
        const { askBlock, skillBlock } = buildKnowledgePromptBlocks(indexNoAsks);
        assertEqual(askBlock, undefined, "no asks → no ask block");
        assert(skillBlock?.includes("skills/azure/deploy"), "skills still pushed in base mode");
    });

    // ─── enhanced path: namespace rules must NOT duplicate ──────────────────
    it("enhanced: includeNamespaceRules=false strips rules from the ask block", () => {
        const { askBlock } = buildKnowledgePromptBlocks(indexWithAsks, { includeNamespaceRules: false });
        assert(askBlock?.includes("[ACTIVE FACT REQUESTS]"), "ask list still present");
        assert(!askBlock?.includes(NS_HEADER), "namespace rules removed (the enhanced block owns them)");
    });

    it("enhanced retrieval block names the pull tools and owns the namespace rules", () => {
        const block = buildEnhancedRetrievalPromptBlock({ semantic: true });
        assert(block.includes("search_skills"), "names search_skills (per-turn pull)");
        assert(block.includes("facts_search"), "names facts_search");
        assert(block.includes("facts_similar"), "names facts_similar");
        assert(block.includes(NS_HEADER), "enhanced block carries the namespace rules");
        // The capped-50 PUSH must be gone: this block tells the agent to PULL,
        // it must not embed a pre-listed skill catalogue.
        assert(!block.includes("[CURATED SKILLS]"), "no pushed skill list in enhanced mode");
    });

    // MED#2: the semantic wording is gated on an actual embedder. With
    // capabilities.search but NO embedder, hybrid degrades to lexical and an
    // explicit semantic request errors — so the block must not promise semantic.
    it("enhanced block (semantic=true) advertises semantic/hybrid recall", () => {
        const block = buildEnhancedRetrievalPromptBlock({ semantic: true });
        assert(block.includes("semantic search available"), "header advertises semantic");
        assert(block.toLowerCase().includes("semantic"), "body mentions semantic recall");
    });

    it("enhanced block (semantic=false) does NOT promise semantic recall", () => {
        const block = buildEnhancedRetrievalPromptBlock({ semantic: false });
        assert(block.includes("search_skills"), "still names the pull tool");
        assert(block.includes("facts_search"), "still names facts_search");
        assert(!block.includes("semantic search available"), "header does not claim semantic");
        assert(block.toLowerCase().includes("lexical"), "directs the agent to lexical/hybrid");
        assert(block.includes(NS_HEADER), "namespace rules still present");
    });

    // composed enhanced prompt (ask + enhanced) carries rules exactly once
    it("enhanced: composed ask+retrieval carries namespace rules exactly once", () => {
        const { askBlock } = buildKnowledgePromptBlocks(indexWithAsks, { includeNamespaceRules: false });
        const composed = [askBlock, buildEnhancedRetrievalPromptBlock({ semantic: true })].join("\n\n");
        const occurrences = composed.split(NS_HEADER).length - 1;
        assertEqual(occurrences, 1, "namespace rules appear exactly once (no duplication)");
    });

    // ─── graph reader block: seed sentence only when enhanced ───────────────
    it("graph reader (semanticSeed=true) includes the seed-pivot sentence", () => {
        const block = buildGraphReaderPromptBlock({ semanticSeed: true });
        assert(block.includes("graph_search_nodes"), "names graph_search_nodes");
        assert(block.includes("graph_neighbourhood"), "names graph_neighbourhood");
        assert(block.toLowerCase().includes("seed"), "includes the semantic seed-pivot guidance");
    });

    it("graph reader (semanticSeed=false) omits the seed-pivot sentence but keeps the tools", () => {
        const block = buildGraphReaderPromptBlock({ semanticSeed: false });
        const withSeed = buildGraphReaderPromptBlock({ semanticSeed: true });
        assert(block.includes("graph_search_nodes"), "graph read tools still named for base-facts + graph");
        // LOW#1: assert the FULL seed-pivot sentence (present in the enhanced
        // variant) is absent here, not just one substring of it.
        assert(!block.includes("seed graph_search_nodes"), "no semantic seed-pivot sentence without enhanced facts");
        assert(block.length < withSeed.length, "base graph block is shorter (seed sentence dropped)");
        assert(!block.includes("connected entities and relationships"), "full seed-pivot phrasing absent in base variant");
    });
});

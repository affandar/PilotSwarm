/**
 * splashMobile end-to-end (migration 0026).
 *
 * Sessions carry an optional narrow-viewport splash variant: agent frontmatter
 * `splashMobile` → CMS `sessions.splash_mobile` (9-arg cms_create_session
 * overload + jsonb update rule + extended read procs) → session views → the
 * chat renderer, which swaps it in when the main art is wider than the pane.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual, assertIncludes } from "../helpers/assertions.js";
import { PgSessionCatalogProvider, PilotSwarmWorker } from "../../src/index.ts";
import { loadAgentFiles } from "../../src/agent-loader.ts";
import { composeDeclaredSkillsPrompt } from "../../src/skills.ts";
import { createSplashCard } from "../../../app/ui/core/src/history.js";
import { selectChatLines, selectActiveChat } from "../../../app/ui/core/src/selectors.js";
import { appReducer } from "../../../app/ui/core/src/reducer.js";
import { createInitialState } from "../../../app/ui/core/src/state.js";
import { createStore } from "../../../app/ui/core/src/store.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

const WIDE_ART = [
    "+--------------------------------------------------------------------------------+",
    "|  W I D E   D E S K T O P   S P L A S H   A R T   B A N N E R   E X A M P L E  |",
    "+--------------------------------------------------------------------------------+",
].join("\n");
const MOBILE_ART = "== MOBILE SPLASH ==";

async function directQuery(env, sql, params = []) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: env.store });
    try {
        await client.connect();
        return await client.query(sql, params);
    } finally {
        try { await client.end(); } catch {}
    }
}

describe("session splashMobile", () => {
    it("round-trips through create, update, and every read proc", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);

        try {
            await catalog.initialize();
            const sessionId = `splash-mobile-${Date.now()}`;
            await catalog.createSession(sessionId, {
                model: "gpt-5.4",
                splash: WIDE_ART,
                splashMobile: MOBILE_ART,
            });

            const row = await catalog.getSession(sessionId);
            assertEqual(row.splash, WIDE_ART, "getSession returns the main splash");
            assertEqual(row.splashMobile, MOBILE_ART, "getSession returns the mobile splash");

            const listed = (await catalog.listSessions()).find((s) => s.sessionId === sessionId);
            assertEqual(listed?.splashMobile, MOBILE_ART, "cms_list_sessions carries splash_mobile");

            const page = await catalog.listSessionsPage({ limit: 200 });
            const paged = page.find((s) => s.sessionId === sessionId);
            assertEqual(paged?.splashMobile, MOBILE_ART, "cms_list_sessions_page carries splash_mobile");

            // The group list proc SELECT *s over cms_list_sessions — shapes
            // must match or this throws at runtime.
            await catalog.listGroupSessions("no-such-group");

            await catalog.updateSession(sessionId, { splashMobile: "== V2 ==" });
            const updated = await catalog.getSession(sessionId);
            assertEqual(updated.splashMobile, "== V2 ==", "updateSession jsonb rule persists splashMobile");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("falls back to the 8-arg create proc when the DB predates 0026", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);

        try {
            await catalog.initialize();
            // Simulate a DB with no splashMobile-aware create proc: drop BOTH
            // the 0026 9-arg overload AND the 0029 10-arg (visibility) overload
            // — both persist splash_mobile — leaving only the pre-0026 8-arg.
            await directQuery(env, `DROP FUNCTION "${env.cmsSchema}".cms_create_session(TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT, TEXT)`);
            await directQuery(env, `DROP FUNCTION "${env.cmsSchema}".cms_create_session(TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT, TEXT, TEXT)`);

            const freshCatalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
            try {
                const sessionId = `splash-mobile-fallback-${Date.now()}`;
                await freshCatalog.createSession(sessionId, {
                    model: "gpt-5.4",
                    splash: WIDE_ART,
                    splashMobile: MOBILE_ART,
                });
                const row = await freshCatalog.getSession(sessionId);
                assertEqual(row.splash, WIDE_ART, "fallback create persists the main splash");
                assertEqual(row.splashMobile, null, "fallback create drops splashMobile (pre-0026 DB)");
            } finally {
                await freshCatalog.close();
            }
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("parses splashMobile agent frontmatter (block scalar and inline)", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-agents-"));
        try {
            fs.writeFileSync(path.join(dir, "arty.agent.md"), [
                "---",
                "name: arty",
                "schemaVersion: 1",
                "version: 1.0.0",
                "splash: |",
                "  BIG WIDE ART",
                "  SECOND LINE",
                "splashMobile: |",
                "  SMALL ART",
                "---",
                "You are arty.",
            ].join("\n"));
            fs.writeFileSync(path.join(dir, "inline.agent.md"), [
                "---",
                "name: inline",
                "schemaVersion: 1",
                "version: 1.0.0",
                "splashMobile: TINY",
                "---",
                "You are inline.",
            ].join("\n"));

            const agents = loadAgentFiles(dir);
            const arty = agents.find((a) => a.name === "arty");
            assertEqual(arty.splash, "BIG WIDE ART\nSECOND LINE", "block-scalar splash parses");
            assertEqual(arty.splashMobile, "SMALL ART", "block-scalar splashMobile parses");
            const inline = agents.find((a) => a.name === "inline");
            assertEqual(inline.splashMobile, "TINY", "inline splashMobile parses");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("parses agent skill declarations in list and inline forms", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-agent-skills-"));
        try {
            fs.writeFileSync(path.join(dir, "listed.agent.md"), [
                "---",
                "name: listed",
                "schemaVersion: 1",
                "version: 1.0.0",
                "skills:",
                "  - runbook-marshal",
                "  - runbook-child-lifecycle",
                "---",
                "You are listed.",
            ].join("\n"));
            fs.writeFileSync(path.join(dir, "inline.agent.md"), [
                "---",
                "name: inline",
                "schemaVersion: 1",
                "version: 1.0.0",
                "skills: [runbook-authoring, ado-markdowns]",
                "---",
                "You are inline.",
            ].join("\n"));

            const agents = loadAgentFiles(dir);
            assertEqual(
                JSON.stringify(agents.find((agent) => agent.name === "listed")?.skills),
                JSON.stringify(["runbook-marshal", "runbook-child-lifecycle"]),
                "list-form skills parse",
            );
            assertEqual(
                JSON.stringify(agents.find((agent) => agent.name === "inline")?.skills),
                JSON.stringify(["runbook-authoring", "ado-markdowns"]),
                "inline skills parse",
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("injects declared skill bodies and reports missing declarations", () => {
        const result = composeDeclaredSkillsPrompt(
            "You are the runbook marshal.",
            ["runbook-marshal", "runbook-child-lifecycle", "missing-skill", "runbook-marshal"],
            [
                { name: "runbook-marshal", description: "", prompt: "Validate the runbook.", toolNames: [], dir: "/skills/runbook-marshal" },
                { name: "runbook-child-lifecycle", description: "", prompt: "Checkpoint before recycle.", toolNames: [], dir: "/skills/runbook-child-lifecycle" },
            ],
        );

        assertIncludes(result.prompt, "[PRELOADED SKILL: runbook-marshal]", "declared primary skill is injected");
        assertIncludes(result.prompt, "Validate the runbook.", "primary skill body is injected");
        assertIncludes(result.prompt, "[PRELOADED SKILL: runbook-child-lifecycle]", "declared lifecycle skill is injected");
        assertEqual(result.prompt.match(/PRELOADED SKILL: runbook-marshal/g)?.length, 1, "duplicate declarations inject once");
        assertEqual(JSON.stringify(result.missing), JSON.stringify(["missing-skill"]), "missing declarations are reported");
    });

    it("composes declared plugin skills into the worker agent prompt", () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-plugin-skills-"));
        try {
            fs.mkdirSync(path.join(pluginDir, "agents"));
            fs.mkdirSync(path.join(pluginDir, "skills", "runbook-child-lifecycle"), { recursive: true });
            fs.writeFileSync(path.join(pluginDir, "agents", "marshal.agent.md"), [
                "---",
                "name: marshal",
                "schemaVersion: 1",
                "version: 1.0.0",
                "skills:",
                "  - runbook-child-lifecycle",
                "---",
                "Coordinate the runbook.",
            ].join("\n"));
            fs.writeFileSync(path.join(pluginDir, "skills", "runbook-child-lifecycle", "SKILL.md"), [
                "---",
                "name: runbook-child-lifecycle",
                "description: Child lifecycle protocol",
                "---",
                "Checkpoint before recycling a child.",
            ].join("\n"));

            const worker = new PilotSwarmWorker({ pluginDirs: [pluginDir], disableManagementAgents: true });
            const marshal = worker.loadedAgents.find((agent) => agent.name === "marshal");
            assertIncludes(marshal?.prompt ?? "", "Coordinate the runbook.", "agent prompt is preserved");
            assertIncludes(marshal?.prompt ?? "", "[PRELOADED SKILL: runbook-child-lifecycle]", "declared skill marker is composed");
            assertIncludes(marshal?.prompt ?? "", "Checkpoint before recycling a child.", "declared skill body is composed");
        } finally {
            fs.rmSync(pluginDir, { recursive: true, force: true });
        }
    });

    it("renders the mobile variant only when the main art overflows the pane", () => {
        const store = createStore(appReducer, createInitialState({
            mode: "local",
            branding: { title: "Test", splash: WIDE_ART, splashMobile: MOBILE_ART },
        }));
        const state = store.getState();

        const card = createSplashCard(state.branding);
        assertEqual(card.length, 1, "splash card built");
        assert(card[0].text.includes("W I D E"), "card text is the main art");
        assert(card[0].mobileText.includes("MOBILE SPLASH"), "card carries the mobile variant");

        const chat = selectActiveChat(state);
        assert(chat[0]?.splash, "no active session renders the branding splash card");

        const narrowLines = selectChatLines(state, 40);
        const narrowMarkup = narrowLines.find((line) => line?.kind === "markup");
        assert(narrowMarkup?.value.includes("MOBILE SPLASH"), "narrow pane uses the mobile art");
        assert(!narrowMarkup?.value.includes("W I D E"), "narrow pane hides the wide art");

        const wideLines = selectChatLines(state, 200);
        const wideMarkup = wideLines.find((line) => line?.kind === "markup");
        assert(wideMarkup?.value.includes("W I D E"), "wide pane keeps the main art");
    });

    it("session splash never falls back to the branding mobile art", () => {
        const branding = { title: "Test", splash: WIDE_ART, splashMobile: MOBILE_ART };
        const card = createSplashCard(branding, { sessionId: "s1", splash: "SESSION ART", splashMobile: null });
        assertEqual(card.length, 1, "splash card built");
        assert(card[0].text.includes("SESSION ART"), "session splash wins");
        assertEqual(card[0].mobileText, undefined, "no cross-source mobile fallback");
    });
});

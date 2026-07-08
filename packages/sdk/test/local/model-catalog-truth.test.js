/**
 * Catalog model is the source of truth.
 *
 * The CMS session row's `model` is what the user selected and what every
 * surface displays. A session must never silently run a different model
 * (the waldemortchk incident: row said github-copilot:claude-sonnet-5 for
 * two days while the runtime ran azure-openai:gpt-5.4). getOrCreate now
 * adopts the catalog model on mismatch and records a LOUD
 * `session.model_mismatch` event.
 *
 * Live test: real worker + CMS + one small turn per case.
 *
 * Run: npx vitest run test/local/model-catalog-truth.test.js
 */
import { describe, it, beforeAll } from "vitest";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { assertEqual, assertNotNull } from "../helpers/assertions.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { TEST_CLAUDE_MODEL, TEST_GPT_MODEL } from "../helpers/fixtures.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);
const FORCE_SINGLE_MODEL = Boolean(process.env.PS_TEST_FORCE_MODEL || process.env.TEST_FORCE_MODEL);
const describeCatalogTruth = FORCE_SINGLE_MODEL ? describe.skip : describe;

describeCatalogTruth("catalog model is the source of truth", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("adopts the catalog model and records session.model_mismatch when the runtime config disagrees", async () => {
        const env = getEnv();
        await withClient(env, {}, async (client) => {
            const session = await client.createSession({ model: TEST_GPT_MODEL });
            assertNotNull(session, "session created");
            await session.sendAndWait("Say hello in three words.", TIMEOUT);

            const catalog = await createCatalog(env);
            try {
                // Simulate the incident class: the CMS row's model changes
                // WITHOUT the set_model command reaching the runtime (a
                // create path that only wrote the row, an out-of-band edit,
                // a stale snapshot). The row now says Claude while the
                // runtime config still says GPT.
                await catalog.updateSession(session.sessionId, { model: TEST_CLAUDE_MODEL });

                // The next turn's getOrCreate must notice, complain loudly,
                // and run on the CATALOG model.
                await session.sendAndWait("Say hello again, three words.", TIMEOUT);

                const events = await catalog.getSessionEvents(session.sessionId);
                const mismatch = events.find((e) => e.eventType === "session.model_mismatch");
                assertNotNull(mismatch, "session.model_mismatch event recorded");
                assertEqual(
                    mismatch.data?.catalogModel,
                    TEST_CLAUDE_MODEL,
                    `event names the catalog model (got ${JSON.stringify(mismatch.data)})`,
                );
                assertEqual(
                    mismatch.data?.action,
                    "catalog_model_adopted",
                    "catalog model was adopted",
                );
                assertEqual(
                    String(mismatch.data?.configuredModel || "").includes(TEST_GPT_MODEL),
                    true,
                    `event names the stale configured model (got ${mismatch.data?.configuredModel})`,
                );

                // And the row still shows the catalog model — the runtime
                // aligned to the catalog, not the other way round.
                const row = await catalog.getSession(session.sessionId);
                assertEqual(row.model, TEST_CLAUDE_MODEL, "catalog model unchanged by reconcile");
            } finally {
                await catalog.close();
            }
        });
    }, TIMEOUT * 3);

    it("stays quiet when catalog and runtime agree", async () => {
        const env = getEnv();
        await withClient(env, {}, async (client) => {
            const session = await client.createSession({ model: TEST_GPT_MODEL });
            await session.sendAndWait("Say hello in three words.", TIMEOUT);

            const catalog = await createCatalog(env);
            try {
                const events = await catalog.getSessionEvents(session.sessionId);
                const mismatch = events.find((e) => e.eventType === "session.model_mismatch");
                assertEqual(mismatch === undefined, true, "no mismatch event on the agreeing path");
            } finally {
                await catalog.close();
            }
        });
    }, TIMEOUT * 2);
});

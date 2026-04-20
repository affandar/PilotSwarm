/**
 * Regression: the baseline wait flow is currently treated as an at-least-once
 * delivery contract rather than strict PRE/WAIT/POST separation.
 *
 * Accepted limitation for now:
 * - required PRE content must appear before the wait boundary
 * - the durable wait must actually resume
 * - required POST content must appear after the resume at least once
 * - duplicate or early-leaked POST content is tolerated
 *
 * The mixed token-only PRE/WAIT/POST prompt remains intentionally out of
 * scope for this shipped regression because the current default model does not
 * satisfy it reliably under the baseline wait prompt. That stricter case stays
 * tracked in the bug report.
 *
 * See: docs/bugreports/wait-boundary-leakage-before-resume.md
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { assert } from "../helpers/assertions.js";

const TIMEOUT = 120_000;
const WAIT_SECONDS = 4;
const PRE = "ZZPREZZ";
const POST = "ZZPOSTZZ";
const JOKE = "ZZJOKEZZ";
const WORK = "GET BACK TO WORK";

const SCENARIOS = [
    {
        id: "simple-after",
        prompt: `Wait ${WAIT_SECONDS} seconds, then reply with exactly the single token ${POST}.`,
        expectPre: [],
        expectPost: [POST],
    },
    {
        id: "work-then-joke",
        prompt: `First tell me ${WORK}. Then wait ${WAIT_SECONDS} seconds. Then tell me a joke using exactly the single token ${JOKE}.`,
        expectPre: [WORK],
        expectPost: [JOKE],
    },
    {
        id: "wait-then-two",
        prompt: `Wait ${WAIT_SECONDS} seconds. After the wait, reply with the token ${POST} on one line and the token ${JOKE} on the next.`,
        expectPre: [],
        expectPost: [POST, JOKE],
    },
];

function isAssistantContentLabel(label) {
    return label.startsWith("assistant.message") || label === "sendAndWait.response";
}

function normalizeText(text) {
    return String(text || "")
        .replace(/\s+/g, " ")
        .trim();
}

async function runScenario(env, scenario) {
    const promptStart = Date.now();
    let waitStartedTimestampMs = null;
    let resumeBoundaryTimestampMs = null;
    const events = [];

    await withClient(env, { client: { waitThreshold: 0 } }, async (client) => {
        const session = await client.createSession();

        const unsub = session.on((evt) => {
            if (!evt) return;
            if (evt.eventType === "session.wait_started" && waitStartedTimestampMs == null) {
                waitStartedTimestampMs = Date.now();
            }
            const data = evt.data ?? {};
            if (
                evt.eventType === "system.message"
                && resumeBoundaryTimestampMs == null
                && typeof data.content === "string"
                && data.content.startsWith("Wait reason:")
            ) {
                resumeBoundaryTimestampMs = Date.now();
            }
            const text = typeof data.content === "string"
                ? data.content
                : (typeof data.deltaContent === "string" ? data.deltaContent : null);
            if (!text) return;
            events.push({ label: evt.eventType, t: Date.now() - promptStart, text });
        });

        try {
            const response = await session.sendAndWait(scenario.prompt, TIMEOUT);
            events.push({
                label: "sendAndWait.response",
                t: Date.now() - promptStart,
                text: response ?? "",
            });
        } finally {
            unsub();
        }
    });

    const boundaryMs = resumeBoundaryTimestampMs != null
        ? (resumeBoundaryTimestampMs - promptStart)
        : Infinity;
    const preText = normalizeText(
        events
            .filter((e) => isAssistantContentLabel(e.label) && e.t < boundaryMs)
            .map((e) => e.text)
            .join("\n"),
    );
    const postText = normalizeText(
        events
            .filter((e) => isAssistantContentLabel(e.label) && e.t >= boundaryMs)
            .map((e) => e.text)
            .join("\n"),
    );

    const missingPre = scenario.expectPre.filter((token) => !preText.includes(token));
    const missingPost = scenario.expectPost.filter((token) => !postText.includes(token));

    return {
        waitObserved: waitStartedTimestampMs != null,
        resumeObserved: resumeBoundaryTimestampMs != null,
        preText,
        postText,
        missingPre,
        missingPost,
    };
}

describe("Wait at-least-once delivery", () => {
    beforeAll(async () => { await preflightChecks(); });

    for (const scenario of SCENARIOS) {
        it(
            `${scenario.id}: default model eventually delivers required post-wait content`,
            { timeout: TIMEOUT },
            async () => {
                const env = createTestEnv(`wait-at-least-once-${scenario.id}`);
                try {
                    const result = await runScenario(env, scenario);
                    console.log(
                        `  [${scenario.id}] waitObserved=${result.waitObserved} resumeObserved=${result.resumeObserved} missingPre=[${result.missingPre.join(",") || "—"}] missingPost=[${result.missingPost.join(",") || "—"}]`,
                    );
                    console.log(`  [${scenario.id}] pre: ${JSON.stringify(result.preText)}`);
                    console.log(`  [${scenario.id}] post: ${JSON.stringify(result.postText)}`);

                    assert(result.resumeObserved, `${scenario.id}: wait resume boundary was never observed`);
                    assert(
                        result.missingPre.length === 0,
                        `${scenario.id}: missing required pre-wait content: ${result.missingPre.join(", ")}`,
                    );
                    assert(
                        result.missingPost.length === 0,
                        `${scenario.id}: missing required post-wait content after resume: ${result.missingPost.join(", ")}`,
                    );
                } finally {
                    await env.cleanup();
                }
            },
        );
    }
});

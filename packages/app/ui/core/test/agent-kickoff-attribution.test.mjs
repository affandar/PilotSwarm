/**
 * An agent's opening instruction must not be attributed to the reader.
 *
 * A packaged agent can carry an `initialPrompt` — the instruction that starts
 * its first turn ("Introduce yourself in one line as Dobby, the R2D train
 * poller…"). It reaches the orchestration as a USER-role prompt, because that
 * is how a turn starts. Nothing marked it as machine-authored, and an
 * unstamped user-role message is rendered from the current viewer's
 * perspective — so every packaged agent's transcript opened with a wall of
 * instructions labelled "You:", which the reader had never written.
 *
 * Two halves, and both are needed:
 *   - client.ts stamps the kickoff with a `kind: "system"` sender. Everything a
 *     person actually sends carries a `kind: "user"` sender stamped at the API
 *     edge from the validated auth context (runtime.js `_buildSender`).
 *   - the chat selector collapses it to one openable line instead of printing
 *     it as a message.
 *
 * Run: node --test test/agent-kickoff-attribution.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { isAgentKickoffMessage } from "../src/selectors.js";

const clientTs = readFileSync(
    fileURLToPath(new URL("../../../../sdk/src/client.ts", import.meta.url)),
    "utf8",
);

const KICKOFF = "Introduce yourself in one line as Dobby, the R2D train poller.";

test("a system-stamped user prompt is recognised as a kickoff", () => {
    assert.equal(
        isAgentKickoffMessage({ role: "user", text: KICKOFF, sender: { kind: "system", display: "dobby kickoff" } }),
        true,
    );
});

test("a message a person actually sent is never a kickoff", () => {
    // The shape runtime.js _buildSender stamps.
    const fromPerson = {
        role: "user",
        text: "what is the train status?",
        sender: { kind: "user", provider: "entra", subject: "abc", display: "Affan Dar", relation: "owner", origin: "portal" },
    };
    assert.equal(isAgentKickoffMessage(fromPerson), false);

    // A sender-less user message is the viewer's own — an older session, or a
    // deployment that stamps nothing. Treating those as kickoffs would hide
    // real messages, which is far worse than the bug being fixed.
    assert.equal(isAgentKickoffMessage({ role: "user", text: "hello" }), false);
    assert.equal(isAgentKickoffMessage({ role: "user", text: "hello", sender: null }), false);
});

test("agent and assistant messages are not kickoffs either", () => {
    assert.equal(isAgentKickoffMessage({ role: "assistant", text: "Hi, I am Dobby." }), false);
    assert.equal(isAgentKickoffMessage({ role: "system", text: "notice", sender: { kind: "system" } }), false);
    // A message from ANOTHER agent is attribution, not a kickoff.
    assert.equal(isAgentKickoffMessage({ role: "user", text: "do this", sender: { kind: "agent", sessionId: "s1" } }), false);
    assert.equal(isAgentKickoffMessage(null), false);
    assert.equal(isAgentKickoffMessage(undefined), false);
});

test("an opening message from a MANAGER agent is attributed to that agent", () => {
    // create_agent_session lets a manager supply the opening line itself. That
    // is authored by the manager, not by the agent definition and not by the
    // reader — so it is stamped kind:"agent" and is deliberately NOT collapsed
    // as a kickoff; it is a real message from a real sender.
    const fromManager = {
        role: "user",
        text: "Start polling train M66.",
        sender: { kind: "agent", sessionId: "mgr-1", display: "agent-manager · opening message" },
    };
    assert.equal(isAgentKickoffMessage(fromManager), false);
});

test("every bootstrap send in the SDK stamps a sender", () => {
    // Four sites enqueue a bootstrap prompt, and each one starts a session
    // whose transcript somebody reads. An unstamped one renders as that
    // reader's own "You:" — the bug this fixes. Derived rather than listed so
    // a fifth site cannot be added unstamped.
    const proxy = readFileSync(
        fileURLToPath(new URL("../../../../sdk/src/session-proxy.ts", import.meta.url)),
        "utf8",
    );
    const unstamped = [];
    for (const source of [["client.ts", clientTs], ["session-proxy.ts", proxy]]) {
        for (const m of source[1].matchAll(/\.send\(([^;]*?)\{[^;]*?bootstrap:\s*true[^;]*?\}/gs)) {
            if (!/sender:/.test(m[0])) unstamped.push(`${source[0]}: ${m[0].slice(0, 70).replace(/\s+/g, " ")}`);
        }
    }
    assert.deepEqual(unstamped, [], `these bootstrap sends carry no sender:\n  ${unstamped.join("\n  ")}`);
});

test("the SDK stamps the kickoff so the UI has something to recognise", () => {
    // Without the stamp the selector can never fire — the two halves have to
    // stay together, and they live in different packages.
    const start = clientTs.indexOf("if (opts?.initialPrompt) {");
    assert.notEqual(start, -1, "the initialPrompt send site moved — renamed?");
    const block = clientTs.slice(start, start + 600);
    assert.match(block, /sender:\s*\{\s*kind:\s*"system"/, "the kickoff send must carry a system sender");
    assert.match(block, /bootstrap:\s*true/, "and must still be a bootstrap prompt");
});

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
import ts from "typescript";

import { isAgentKickoffMessage } from "../src/selectors.js";

const clientTs = readFileSync(
    fileURLToPath(new URL("../../../../sdk/src/client.ts", import.meta.url)),
    "utf8",
);

const KICKOFF = "Introduce yourself in one line as Dobby, the R2D train poller.";

function property(object, name) {
    return object.properties.find(node => ts.isPropertyAssignment(node)
        && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === name);
}

function bootstrapSends(source, filename = "fixture.ts") {
    const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
    const calls = [];
    const visit = node => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
            && ["send", "_startTurn"].includes(node.expression.name.text)) {
            const options = node.arguments.find(arg => ts.isObjectLiteralExpression(arg)
                && property(arg, "bootstrap")?.initializer.kind === ts.SyntaxKind.TrueKeyword);
            if (options) calls.push({ options, prompt: node.arguments[0]?.getText(tree), text: node.getText(tree) });
        }
        ts.forEachChild(node, visit);
    };
    visit(tree);
    return calls;
}

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
    // a sixth site cannot be added unstamped.
    const proxy = readFileSync(
        fileURLToPath(new URL("../../../../sdk/src/session-proxy.ts", import.meta.url)),
        "utf8",
    );
    const unstamped = [];
    for (const source of [["client.ts", clientTs], ["session-proxy.ts", proxy]]) {
        for (const call of bootstrapSends(source[1], source[0])) {
            if (!property(call.options, "sender")) unstamped.push(`${source[0]}: ${call.text.slice(0, 70).replace(/\s+/g, " ")}`);
        }
    }
    assert.deepEqual(unstamped, [], `these bootstrap sends carry no sender:\n  ${unstamped.join("\n  ")}`);
});

test("the SDK stamps the kickoff so the UI has something to recognise", () => {
    // Without the stamp the selector can never fire — the two halves have to
    // stay together, and they live in different packages.
    const sends = bootstrapSends(clientTs, "client.ts").filter(call => call.prompt === "opts.initialPrompt");
    assert.equal(sends.length, 1, "the initialPrompt bootstrap send site moved — renamed?");
    const sender = property(sends[0].options, "sender")?.initializer;
    assert.ok(sender && ts.isObjectLiteralExpression(sender), "the kickoff must carry a sender");
    const kind = property(sender, "kind")?.initializer;
    assert.ok(kind && ts.isStringLiteral(kind) && kind.text === "system", "the kickoff sender must be system");
});

test("bootstrap source guard handles nested options without borrowing another send's sender", () => {
    const sends = bootstrapSends(`
        session.send(prompt, { bootstrap: true, ...(key ? { clientMessageIds: [key] } : {}), sender: { kind: "system" } });
        session._startTurn(prompt, { bootstrap: true, nested: { sender: { kind: "system" } } });
        session.send(prompt, { sender: { kind: "user" } });
    `);
    assert.equal(sends.length, 2);
    assert.ok(property(sends[0].options, "sender"));
    assert.equal(property(sends[1].options, "sender"), undefined);
});

// ── the system prompt stays OUT of the chat pane ────────────────────────────

test("the per-turn system prompt notice is activity only, never a chat row", async () => {
    const { buildHistoryModel, appendEventToHistory } = await import("../src/history.js");

    // What the SDK actually writes, once per TURN (session-proxy.ts
    // summarises the prompt rather than putting 170k chars in CMS). 0.5.47
    // gave each one a collapsed chat row — a row per prompt, and opening it
    // showed the 120-char snippet, not the prompt. The user does not want it
    // in the conversation at all.
    const systemPrompt = (seq) => ({
        seq,
        eventType: "system.message",
        timestamp: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
        data: {
            role: "system",
            content: "[SYSTEM: Copilot SDK rebuilt the full system prompt for model input. "
                + "Full content omitted from CMS (170900 chars). Snippet: You are the GitHub Copilot CLI...]",
        },
    });
    const user = (seq, content) => ({
        seq, eventType: "user.message",
        timestamp: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
        data: { role: "user", content },
    });
    const isPromptRow = (m) => /rebuilt the full system prompt/i.test(m?.text || "");

    // Bulk load: two turns, two echoes.
    const bulk = buildHistoryModel([user(1, "ping"), systemPrompt(2), user(3, "ping again"), systemPrompt(4)]);
    assert.equal(bulk.chat.filter(isPromptRow).length, 0, "no chat row for the prompt echo");
    assert.equal(bulk.chat.filter((m) => m.role === "user").length, 2, "the person's messages still land");
    assert.ok(
        bulk.activity.some((item) => /rebuilt the full system prompt/i.test(JSON.stringify(item))),
        "the echo still reaches the activity feed",
    );

    // Live append: same rule on the incremental path.
    const appended = appendEventToHistory(bulk, systemPrompt(5));
    assert.equal(appended.chat.filter(isPromptRow).length, 0, "no chat row on the live path either");
});

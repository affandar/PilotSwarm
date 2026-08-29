/**
 * Two session-pane changes: the foldable detail box, and one-axis touch panning.
 *
 * ── the fold ──
 * The detail box is ten rows of reference detail pinned under a list you are
 * trying to read. It now starts folded to a one-line summary and remembers
 * whether you opened it.
 *
 * The trap that guards is a PERSISTENCE one, and it is silent. A setting has to
 * be wired in four separate places — normalize, write, read-back merge, and the
 * save effect's hand-maintained dependency array. Miss any one and the toggle
 * works perfectly until you reload, then reverts, with nothing logged. The
 * stylesheet's own comment records this happening once already to `touchScale`
 * (written but never merged); building this feature hit it again, on the
 * dependency array. So the last test below derives the requirement instead of
 * listing it: every field the save path reads must appear in the deps.
 *
 * ── the axis lock ──
 * A touch drag scrolls the session list up/down OR left/right, never both.
 * `commitPanAxis` is the whole rule, extracted so it can be tested as
 * arithmetic rather than as a browser gesture. The defect it replaces is a
 * gesture near 45° that matched neither branch: it committed to vertical, the
 * code stepped aside for the browser, and the browser then declined to pan it
 * — so the list did not move at all.
 *
 * Run: node --test test/session-detail-and-pan.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { selectSessionStatusSummary } from "../src/selectors.js";
import {
    clampWaitReason,
    commitPanAxis,
    visibleWaitReason,
    waitReasonLabel,
    WAIT_REASON_MAX_CHARS,
    WAIT_REASON_MAX_WORDS,
} from "../../react/src/web-app.js";

const webApp = readFileSync(
    fileURLToPath(new URL("../../react/src/web-app.js", import.meta.url)),
    "utf8",
);

// ── the fold: state and reducer ─────────────────────────────────────────────

test("the detail box starts folded", () => {
    const state = createInitialState({ mode: "web" });
    assert.equal(state.ui.sessionDetailCollapsed, true);
});

test("the fold toggles, and an unchanged toggle keeps the same object", () => {
    const state = createInitialState({ mode: "web" });
    const opened = appReducer(state, { type: "ui/sessionDetailCollapsed", collapsed: false });
    assert.equal(opened.ui.sessionDetailCollapsed, false);

    const refolded = appReducer(opened, { type: "ui/sessionDetailCollapsed", collapsed: true });
    assert.equal(refolded.ui.sessionDetailCollapsed, true);

    // Identity, not just equality: a no-op dispatch that returned a new object
    // would re-render every subscriber on each poll.
    const again = appReducer(refolded, { type: "ui/sessionDetailCollapsed", collapsed: true });
    assert.equal(again, refolded);
});

test("a stored profile restores the fold, and an absent one does not clobber it", () => {
    const open = appReducer(
        createInitialState({ mode: "web" }),
        { type: "ui/sessionDetailCollapsed", collapsed: false },
    );

    const applied = appReducer(open, {
        type: "profileSettings/apply",
        settings: { sessionDetailCollapsed: true },
    });
    assert.equal(applied.ui.sessionDetailCollapsed, true);

    // A poll that carries no opinion must leave a fresh local toggle alone —
    // the same no-defaults rule the merge path documents for touchScale.
    const untouched = appReducer(open, { type: "profileSettings/apply", settings: {} });
    assert.equal(untouched.ui.sessionDetailCollapsed, false);
});

// ── the fold: the four wiring points ────────────────────────────────────────

test("the fold is wired through every place a persisted setting has to be", () => {
    const missing = [];
    if (!/candidate\.sessionDetailCollapsed === "boolean"/.test(webApp)) missing.push("normalizeProfileSettings");
    if (!/sessionDetailCollapsed: state\.sessionDetailCollapsed/.test(webApp)) missing.push("profileSettingsFromViewState (write)");
    if (!/hasOwn\(normalizedRemote, "sessionDetailCollapsed"\)/.test(webApp)) missing.push("remote merge (read back)");
    assert.deepEqual(missing, [], `a persisted setting must be wired in all of these: ${missing.join(", ")}`);
});

test("every field the save path reads is in the save effect's dependency array", () => {
    // The deps are hand-maintained, and omitting one does not break the toggle
    // — it breaks only the SAVE, silently, until a reload reveals it. Derive
    // the expected set from what the writer actually reads so a new setting
    // cannot be added to one and forgotten in the other.
    const writerStart = webApp.indexOf("function profileSettingsFromViewState(");
    assert.notEqual(writerStart, -1, "profileSettingsFromViewState not found — renamed?");
    const writerEnd = webApp.indexOf("\n}", writerStart);
    const writer = webApp.slice(writerStart, writerEnd);

    // `state.x` reads inside the writer, minus the ones reached dynamically.
    const read = new Set([...writer.matchAll(/\bstate\.([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]));
    // touchScale is written through a computed key, `[touchScaleKey()]`, so it
    // never appears as a plain `state.touchScale` read here.
    read.delete("touchScale");

    const effectStart = webApp.indexOf("const settings = profileSettingsFromViewState(state, otherTouchScaleRef.current");
    assert.notEqual(effectStart, -1, "the save effect not found — renamed?");
    const depsMatch = webApp.slice(effectStart).match(/\}, \[([^\]]*)\]\);/);
    assert.ok(depsMatch, "could not read the save effect's dependency array");
    const deps = new Set(
        [...depsMatch[1].matchAll(/\bstate\.([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]),
    );

    const undeclared = [...read].filter((key) => !deps.has(key)).sort();
    assert.deepEqual(
        undeclared,
        [],
        "these persisted settings are written but are NOT in the save effect's deps, " +
            `so changing them never triggers a save: ${undeclared.join(", ")}`,
    );
});

// ── the axis lock ───────────────────────────────────────────────────────────

const SLOP = 10; // PAN_COMMIT_PX

test("a drag inside the slop radius owns no axis yet", () => {
    assert.equal(commitPanAxis(0, 0), null);
    assert.equal(commitPanAxis(9, 9), null);
    assert.equal(commitPanAxis(-9, 9), null);
});

test("past the threshold every gesture owns exactly one axis — no dead zone", () => {
    // The whole circle, every 5°, at a radius well past the slop. Each one has
    // to land on an axis: the defect this replaces was an angle that committed
    // to vertical and then moved nothing.
    const unowned = [];
    for (let deg = 0; deg < 360; deg += 5) {
        const rad = (deg * Math.PI) / 180;
        const dx = Math.cos(rad) * 60;
        const dy = Math.sin(rad) * 60;
        const axis = commitPanAxis(dx, dy);
        if (axis !== "x" && axis !== "y") unowned.push(deg);
    }
    assert.deepEqual(unowned, [], `these angles commit to no axis: ${unowned.join(", ")}`);
});

test("vertical is the default: a 45° drag goes down, not sideways", () => {
    assert.equal(commitPanAxis(50, 50), "y");
    assert.equal(commitPanAxis(-50, 50), "y");
    // Beating vertical by a little is still not enough — sideways is deliberate.
    assert.equal(commitPanAxis(60, 50), "y");
});

test("a clearly sideways drag goes sideways, either direction", () => {
    assert.equal(commitPanAxis(90, 50), "x");
    assert.equal(commitPanAxis(-90, 50), "x");
    assert.equal(commitPanAxis(60, 0), "x");
});

test("a barely-moving cross-axis cannot flip the commit", () => {
    // Pure vertical with a hand tremor is still vertical.
    assert.equal(commitPanAxis(3, SLOP * 5), "y");
    // ...and the mirror case.
    assert.equal(commitPanAxis(SLOP * 5, 3), "x");
});

test("the handler drives BOTH axes and blocks the browser on both", () => {
    // The old handler returned early once the gesture was vertical, leaving
    // that axis to the browser — which is what made the guarantee depend on
    // touch-action, and on which engine was reading it.
    //
    // Scope, honestly: this reads source, so it catches the literal early
    // return coming back and not every way one could be spelled. It is a
    // backstop. The load-bearing checks are commitPanAxis above (real
    // arithmetic, every angle) and the browser pass in
    // scratchpad/smoke/detail-and-axis.mjs, which drives actual touch events
    // and asserts no gesture moves two axes.
    const start = webApp.indexOf("const onTouchMove = (event) => {\n            if (axis === \"done\"");
    assert.notEqual(start, -1, "the axis-locked touchmove handler not found — renamed?");
    const handler = webApp.slice(start, webApp.indexOf("\n        };", start));

    assert.match(handler, /el\.scrollLeft -= stepX/, "horizontal must be driven here");
    assert.match(handler, /el\.scrollTop -= stepY/, "vertical must be driven here too");
    assert.match(handler, /event\.preventDefault\(\)/, "the browser must not also scroll");
    assert.doesNotMatch(
        handler,
        /if \(axis === "y"\) return;/,
        "handing the vertical case back to the browser is exactly the bug",
    );
});

// ── the detail box's two halves must agree ──────────────────────────────────

test("the WAITING block does not blink while the status holds steady", () => {
    // The reported flicker: the box showed "(running)" and a WAITING row
    // appeared for a few milliseconds on every poll, then vanished.
    //
    // Cause: the two halves ran on different clocks. The Updated row reads the
    // DEBOUNCED status (a change is held 5s, because the 4s catalog poll and
    // the post-event detail sync disagree mid-turn) while waitReason was read
    // raw. So the CMS row clearing wait_reason — client.ts does exactly that
    // when a session goes running — toggled the block under a status that was
    // deliberately not moving.
    const PARENT = "flicker-1";
    const REASON = "Supervise five RCAKit PG Flex incident investigations";
    const row = (extra) => ({
        sessionId: PARENT,
        title: "RCAKit PG Flex",
        updatedAt: Date.now(),
        status: "running",
        orchestrationStatus: "Running",
        ...extra,
    });

    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "sessions/loaded", sessions: [row({ waitReason: REASON })] });
    state = appReducer(state, { type: "sessions/selected", sessionId: PARENT });

    const seen = [];
    const sample = () => {
        const session = state.sessions.byId[PARENT];
        const status = selectSessionStatusSummary(session)?.status;
        seen.push(`${status}/${visibleWaitReason(session, status) ? "WAITING" : "-"}`);
    };
    sample();

    for (let i = 0; i < 5; i += 1) {
        // live detail sync: still carries the sentence
        state = appReducer(state, {
            type: "sessions/merged",
            session: { sessionId: PARENT, status: "running", orchestrationStatus: "Running", waitReason: REASON },
        });
        sample();
        // catalog poll: the CMS row has had wait_reason cleared
        state = appReducer(state, { type: "sessions/loaded", sessions: [row({ waitReason: null })] });
        sample();
    }

    assert.deepEqual(
        [...new Set(seen)],
        ["running/-"],
        `the box flickered across polls: ${seen.join(" → ")}`,
    );
});

test("a genuinely waiting session still shows its reason", () => {
    // The gate must not swallow the sentence when it is the whole point of the
    // block — this is the case the flicker fix could easily over-correct.
    const session = { sessionId: "s", waitReason: "Waiting for the 09:00 window" };
    assert.equal(visibleWaitReason(session, "waiting"), "Waiting for the 09:00 window");
    assert.equal(visibleWaitReason(session, "waiting on 7"), "Waiting for the 09:00 window");
    assert.equal(visibleWaitReason(session, "waiting on children"), "Waiting for the 09:00 window");
    assert.equal(visibleWaitReason(session, "input_required"), "Waiting for the 09:00 window");
    // ...and must stay quiet when the box is saying the session is active.
    assert.equal(visibleWaitReason(session, "running"), null);
    assert.equal(visibleWaitReason(session, "idle"), null);
    assert.equal(visibleWaitReason(session, "completed"), null);
    // No sentence is no block, whatever the status says.
    assert.equal(visibleWaitReason({ sessionId: "s", waitReason: "  " }, "waiting"), null);
    assert.equal(visibleWaitReason({ sessionId: "s" }, "waiting"), null);
});

// ── the wait reason is one line, and a cron's is not a "reason" ───────

// A real cron wake-up instruction: this is what `cron` asks the model for
// ("What to do on each wake-up"), and it is replayed on every fire.
const CRON_INSTRUCTION = `Poll the pg-flex repairer sub-agent
(session-df588c0b-d8cc-4b9b-a23f-1b9923a1712a, final cycle 3 of 3) for run
pgflex-20260829-040000 via check_agents. When it returns its
pg-flex-output-repair-plan.v1 JSON: save it as artifact
pgflex-repair-plan-cycle3.json, then apply it locally with
apply-output-repair.mjs against the sealed concurrent sidecar.`;

test("a wait reason is clipped to a glance, however long the stored text is", () => {
    const shown = visibleWaitReason({ sessionId: "s", waitReason: CRON_INSTRUCTION }, "waiting");
    assert.ok(shown.split(" ").length <= WAIT_REASON_MAX_WORDS, "within the word budget");
    assert.ok(shown.endsWith("…"), "and says it was clipped");
    assert.ok(!shown.includes("\n"), "newlines are flattened, not carried into the box");
    // The word budget alone is not a length: these instructions carry session
    // UUIDs, and ten words of those ran to 100 characters.
    assert.ok(shown.length <= WAIT_REASON_MAX_CHARS + 1, `one line, got ${shown.length} chars`);
    assert.equal(shown, "Poll the pg-flex repairer sub-agent…");
});

test("a sentence that already fits is left exactly as it is", () => {
    // The common `wait` case. Clipping must not put an ellipsis on text that
    // was never too long, or every ordinary wait looks truncated.
    for (const text of ["Waiting for the 09:00 window", "Sleeping 30s before the next poll"]) {
        assert.equal(clampWaitReason(text), text);
    }
    assert.equal(clampWaitReason(""), "");
    assert.equal(clampWaitReason(null), "");
});

test("clipping does not leave a comma sitting before the ellipsis", () => {
    const clipped = clampWaitReason("one two three four five six seven eight nine ten, eleven");
    assert.equal(clipped, "one two three four five six seven eight nine ten…");
});

test("a cron session's text is labelled as an instruction, not as a reason", () => {
    // It is not waiting BECAUSE of this text; it is waiting for the next tick,
    // and this is what it will then do.
    assert.equal(waitReasonLabel({ cronActive: true }), "On wake");
    assert.equal(waitReasonLabel({ cronActive: false }), "Waiting");
    assert.equal(waitReasonLabel({}), "Waiting");
    assert.equal(waitReasonLabel(null), "Waiting");
});

test("a long single token is cut rather than allowed to wrap the box", () => {
    // No space to fall back to, so the cut lands mid-token. A clipped UUID
    // beats a box three lines tall.
    const clipped = clampWaitReason(`session-${"d".repeat(120)}`);
    assert.ok(clipped.length <= WAIT_REASON_MAX_CHARS + 1, `got ${clipped.length}`);
    assert.ok(clipped.endsWith("…"));
});

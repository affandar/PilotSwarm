import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProbe } from "../fixtures/native-filesystem-probe.mjs";

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ps-file-sharing-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}
test("disk-only challenge travels durable -> native -> native -> durable", t => {
    const dir = fixture(t);
    for (const phase of ["prepare", "native-one", "native-two", "verify"]) assert.equal(runProbe(dir, phase).status, "ok");
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "verified.json"))).finalHash.length, 64);
});
test("verification cannot pass before native writes", t => {
    const dir = fixture(t);
    runProbe(dir, "prepare");
    assert.throws(() => runProbe(dir, "verify"));
    assert.throws(() => runProbe(dir, "native-two"));
    assert.equal(fs.existsSync(path.join(dir, "verified.json")), false);
});
test("different cwd or duplicate preparation cannot pass", t => {
    const dir = fixture(t);
    runProbe(dir, "prepare");
    assert.throws(() => runProbe(dir, "native-one", dir), /Working directory differs/);
    assert.throws(() => runProbe(dir, "prepare"), /EEXIST/);
});
test("a changed parent file invalidates native receipts", t => {
    const dir = fixture(t);
    for (const phase of ["prepare", "native-one", "native-two"]) runProbe(dir, phase);
    const file = path.join(dir, "shared.json"), state = JSON.parse(fs.readFileSync(file));
    fs.writeFileSync(file, JSON.stringify({ ...state, seed: "substituted" }));
    assert.throws(() => runProbe(dir, "verify"), /cannot verify/);
});

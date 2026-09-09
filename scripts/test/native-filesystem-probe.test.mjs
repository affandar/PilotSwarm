import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProbe, verifyDiskProof } from "../fixtures/native-filesystem-probe.mjs";

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ps-file-sharing-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}
test("disk-only challenge travels durable -> native -> native -> durable", t => {
    const dir = fixture(t);
    for (const phase of ["prepare", "native-one", "native-two", "verify"]) assert.equal(runProbe(dir, phase).status, "ok");
    const recorded = JSON.parse(fs.readFileSync(path.join(dir, "verified.json")));
    assert.equal(recorded.finalHash.length, 64);
    assert.deepEqual(verifyDiskProof(dir), recorded);
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

test("a fabricated verification file without receipts cannot prove sharing", t => {
    const dir = fixture(t);
    fs.writeFileSync(path.join(dir, "verified.json"), JSON.stringify({ status: "ok", phase: "verify", finalHash: "a".repeat(64) }));
    assert.throws(() => verifyDiskProof(dir), /ENOENT/);
});

for (const [name, file, mutate] of [
    ["parent challenge", "shared.json", value => ({ ...value, seed: "a".repeat(64) })],
    ["final stage", "shared.json", value => ({ ...value, stage: "prepared" })],
    ["first shared write", "shared.json", value => ({ ...value, one: "b".repeat(64) })],
    ["second shared write", "shared.json", value => ({ ...value, two: "c".repeat(64) })],
    ["first receipt parent hash", "native-one.json", value => ({ ...value, parentHash: "d".repeat(64) })],
    ["first receipt nonce", "native-one.json", value => ({ ...value, nonce: "e".repeat(64) })],
    ["second receipt observed hash", "native-two.json", value => ({ ...value, observedHash: "f".repeat(64) })],
    ["second receipt nonce", "native-two.json", value => ({ ...value, nonce: "invalid" })],
    ["receipt cwd", "native-two.json", value => ({ ...value, cwd: "/another-worker" })],
    ["recorded final hash", "verified.json", value => ({ ...value, finalHash: "0".repeat(64) })],
    ["recorded cwd", "verified.json", value => ({ ...value, cwd: "/another-worker" })],
    ["recorded stages", "verified.json", value => ({ ...value, stages: ["prepare", "verify"] })],
]) test(`independent disk verification rejects tampered ${name}`, t => {
    const dir = fixture(t);
    for (const phase of ["prepare", "native-one", "native-two", "verify"]) runProbe(dir, phase);
    assert.equal(verifyDiskProof(dir).status, "ok");
    const target = path.join(dir, file);
    fs.writeFileSync(target, JSON.stringify(mutate(JSON.parse(fs.readFileSync(target, "utf8")))));
    assert.throws(() => verifyDiskProof(dir), /cannot verify|does not match/);
});

test("independent verification requires every receipt and valid JSON", t => {
    const dir = fixture(t);
    for (const phase of ["prepare", "native-one", "native-two", "verify"]) runProbe(dir, phase);
    const target = path.join(dir, "native-one.json");
    fs.writeFileSync(target, "not-json");
    assert.throws(() => verifyDiskProof(dir), SyntaxError);
    fs.unlinkSync(target);
    assert.throws(() => verifyDiskProof(dir), /ENOENT/);
});

test("phases cannot be repeated to overwrite an established proof", t => {
    const dir = fixture(t);
    for (const phase of ["prepare", "native-one", "native-two", "verify"]) runProbe(dir, phase);
    const before = verifyDiskProof(dir);
    for (const phase of ["prepare", "native-one", "native-two", "verify"]) assert.throws(() => runProbe(dir, phase));
    assert.deepEqual(verifyDiskProof(dir), before);
});

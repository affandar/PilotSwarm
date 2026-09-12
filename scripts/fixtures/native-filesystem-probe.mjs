// Used by the live smoke test. Each phase runs in a real agent's shell.
import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const digest = value => createHash("sha256").update(value).digest("hex");
function receiptProof(directory, cwd) {
    const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
    const state = read("shared.json"), one = read("native-one.json"), two = read("native-two.json");
    if (state.stage !== "native-two" || !/^[a-f0-9]{64}$/.test(state.seed || "")
        || !/^[a-f0-9]{64}$/.test(one.nonce || "") || !/^[a-f0-9]{64}$/.test(two.nonce || "")
        || one.parentHash !== digest(state.seed) || state.one !== one.nonce
        || two.observedHash !== digest(state.seed + state.one) || state.two !== two.nonce
        || one.cwd !== state.cwd || two.cwd !== state.cwd || (cwd && fs.realpathSync(cwd) !== state.cwd)) {
        throw new Error("Durable child cannot verify the native writes");
    }
    return { phase: "verify", status: "ok", cwd: state.cwd, stages: ["prepare", "native-one", "native-two", "verify"], finalHash: digest(JSON.stringify(state)) };
}

/** The runner independently re-reads all receipts and recomputes the final hash. */
export function verifyDiskProof(directory) {
    const expected = receiptProof(directory);
    const recorded = JSON.parse(fs.readFileSync(path.join(directory, "verified.json"), "utf8"));
    if (JSON.stringify(recorded) !== JSON.stringify(expected)) throw new Error("Recorded verification does not match the actual files");
    return expected;
}

export function runProbe(directory, phase, cwd = process.cwd()) {
    const file = name => path.join(directory, name);
    const write = (name, value) => fs.writeFileSync(file(name), JSON.stringify(value, null, 2), { flag: "wx" });
    const read = name => JSON.parse(fs.readFileSync(file(name), "utf8"));
    if (phase === "prepare") {
        // The challenge exists only on disk; neither model is given its value.
        const state = { cwd: fs.realpathSync(cwd), seed: randomBytes(32).toString("hex"), stage: "prepared" };
        write("shared.json", state);
        return { phase, status: "ok", cwd: state.cwd };
    }
    const state = read("shared.json");
    if (fs.realpathSync(cwd) !== state.cwd) throw new Error("Working directory differs from the durable child's directory");
    if (phase === "native-one") {
        if (state.stage !== "prepared") throw new Error("Native one must read the durable child's original file");
        const receipt = { parentHash: digest(state.seed), nonce: randomBytes(32).toString("hex"), cwd: state.cwd };
        write("native-one.json", receipt);
        fs.writeFileSync(file("shared.json"), JSON.stringify({ ...state, stage: "native-one", one: receipt.nonce }));
    } else if (phase === "native-two") {
        const one = read("native-one.json");
        if (state.stage !== "native-one" || one.parentHash !== digest(state.seed) || one.nonce !== state.one) throw new Error("Native two did not see native one's changes");
        const receipt = { observedHash: digest(state.seed + state.one), nonce: randomBytes(32).toString("hex"), cwd: state.cwd };
        write("native-two.json", receipt);
        fs.writeFileSync(file("shared.json"), JSON.stringify({ ...state, stage: "native-two", two: receipt.nonce }));
    } else if (phase === "verify") {
        const result = receiptProof(directory, cwd);
        write("verified.json", result);
        return result;
    } else throw new Error(`Unknown phase: ${phase}`);
    return { phase, status: "ok", cwd: state.cwd };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [, , directory, phase] = process.argv;
    console.log(JSON.stringify(runProbe(directory, phase)));
}

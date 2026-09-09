import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { extractAgentPackageTarGz } from "../../dist/agent-package-format.js";

// Exercise the shipped tar.gz extractor. ZIP import was retired; a clean
// build must not depend on its obsolete agent-package-fetchers.js output.
function archive(entries, level = 9) {
    const chunks = [];
    for (const { name, body = "", type = "0" } of entries) {
        const data = Buffer.from(body), header = Buffer.alloc(512);
        header.write(name, 0, "ascii");
        header.write(data.length.toString(8).padStart(11, "0"), 124, "ascii");
        header.write(type, 156, "ascii");
        header.write("ustar", 257, "ascii");
        header.fill(32, 148, 156);
        const checksum = header.reduce((sum, byte) => sum + byte, 0);
        header.write(checksum.toString(8).padStart(6, "0"), 148, "ascii");
        header[154] = 0;
        chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
    }
    return zlib.gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]), { level });
}
function destination(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-extraction-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test("package extraction roundtrips stored and compressed gzip entries", t => {
    for (const level of [0, 9]) {
        const dest = destination(t);
        extractAgentPackageTarGz(archive([
            { name: "plugin.json", body: '{"name":"z"}' },
            { name: "agents/", type: "5" },
            { name: "agents/a.agent.md", body: "Agent body" },
        ], level), dest);
        assert.equal(fs.readFileSync(path.join(dest, "plugin.json"), "utf8"), '{"name":"z"}');
        assert.equal(fs.readFileSync(path.join(dest, "agents/a.agent.md"), "utf8"), "Agent body");
    }
});

test("package extraction rejects traversal and absolute paths before writing", t => {
    for (const name of ["../evil.txt", "/etc/passwd", "a/../../evil", "C:/evil"]) {
        const dest = destination(t);
        assert.throws(() => extractAgentPackageTarGz(archive([{ name, body: "x" }]), dest), /non-relative path|escapes/);
        assert.deepEqual(fs.readdirSync(dest), []);
    }
});

test("package extraction rejects link entries and obsolete ZIP input", t => {
    for (const type of ["1", "2"]) {
        assert.throws(() => extractAgentPackageTarGz(archive([{ name: "link", type }]), destination(t)), /type not allowed/);
    }
    assert.throws(() => extractAgentPackageTarGz(Buffer.from("PK\x03\x04not-a-gzip-package"), destination(t)), /header|gzip|data/i);
});

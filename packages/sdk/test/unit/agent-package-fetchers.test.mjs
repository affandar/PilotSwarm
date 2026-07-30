import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { extractZipArchive } from "../../dist/agent-package-fetchers.js";

function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "agent-zip-test-"));
}

/** Minimal zip writer (stored + deflate) matching the reader's subset. */
function buildZip(entries) {
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const { name, body, deflate } of entries) {
        const nameBuf = Buffer.from(name, "utf8");
        const data = deflate ? zlib.deflateRawSync(body) : body;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(deflate ? 8 : 0, 8);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(body.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        chunks.push(local, nameBuf, data);

        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(deflate ? 8 : 0, 10);
        cd.writeUInt32LE(data.length, 20);
        cd.writeUInt32LE(body.length, 24);
        cd.writeUInt16LE(nameBuf.length, 28);
        cd.writeUInt32LE(offset, 42);
        central.push(Buffer.concat([cd, nameBuf]));
        offset += local.length + nameBuf.length + data.length;
    }
    const cdStart = offset;
    const cdBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(cdStart, 16);
    return Buffer.concat([...chunks, cdBuf, eocd]);
}

test("zip extraction roundtrips stored and deflated entries", () => {
    const zip = buildZip([
        { name: "plugin.json", body: Buffer.from('{"name":"z"}'), deflate: false },
        { name: "agents/", body: Buffer.alloc(0), deflate: false },
        { name: "agents/a.agent.md", body: Buffer.from("---\nname: a\n---\nBody"), deflate: true },
    ]);
    const dest = tmpdir();
    extractZipArchive(zip, dest);
    assert.equal(fs.readFileSync(path.join(dest, "plugin.json"), "utf8"), '{"name":"z"}');
    assert.equal(fs.readFileSync(path.join(dest, "agents", "a.agent.md"), "utf8"), "---\nname: a\n---\nBody");
});

test("zip extraction rejects traversal and absolute paths", () => {
    for (const evil of ["../evil.txt", "/etc/passwd", "a/../../evil"]) {
        const zip = buildZip([{ name: evil, body: Buffer.from("x"), deflate: false }]);
        assert.throws(() => extractZipArchive(zip, tmpdir()), /non-relative path|escapes/);
    }
});

test("zip extraction rejects unsupported compression methods", () => {
    const zip = buildZip([{ name: "f.bin", body: Buffer.from("x"), deflate: false }]);
    // Flip the central-directory method field to 99 (bzip2-ish).
    const cdOffset = zip.readUInt32LE(zip.length - 22 + 16);
    zip.writeUInt16LE(99, cdOffset + 10);
    assert.throws(() => extractZipArchive(zip, tmpdir()), /unsupported compression method/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import ts from "typescript";

test("the published API declaration supports typed live subscriptions and reads", () => {
    const file = fileURLToPath(new URL("../fixtures/live-api-consumer.mts", import.meta.url));
    const program = ts.createProgram([file], {
        noEmit: true, strict: true, skipLibCheck: true,
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(diagnostics.length, 0, diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
});

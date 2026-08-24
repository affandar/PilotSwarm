import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { OPERATIONS } from "../../api/src/protocol.js";
import {
    NON_MANAGEMENT_OPERATION_OWNERS,
    WEB_MODE_UNSUPPORTED_OPERATION_METHODS,
    operationRequiresManagementMethod,
} from "../../api/src/surface-contract.js";

const root = fileURLToPath(new URL("../../../..", import.meta.url));

function classMethods(relativePath, className, scriptKind = ts.ScriptKind.TS) {
    const file = `${root}/${relativePath}`;
    const source = readFileSync(file, "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
    const methods = new Set();
    const visit = (node) => {
        if (ts.isClassDeclaration(node) && node.name?.text === className) {
            for (const member of node.members) {
                if (!ts.isMethodDeclaration(member)) continue;
                methods.add(member.name.getText(tree).replace(/["']/g, ""));
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(tree);
    return methods;
}

const direct = classMethods("packages/sdk/src/management-client.ts", "PilotSwarmManagementClient");
const web = classMethods("packages/sdk/src/web/web-management-client.ts", "WebPilotSwarmManagementClient");

test("every Web operation has an owning public abstraction", () => {
    const operationNames = new Set(OPERATIONS.map((operation) => operation.name));
    for (const [name, contract] of Object.entries(NON_MANAGEMENT_OPERATION_OWNERS)) {
        assert.ok(operationNames.has(name), `non-management exception ${name} is not a protocol operation`);
        assert.ok(contract.owner?.trim(), `${name} exception must name its owner`);
        assert.ok(contract.reason?.trim(), `${name} exception must explain why`);
        assert.ok(contract.file?.trim() && contract.className?.trim() && contract.method?.trim(),
            `${name} exception must identify a concrete class method`);
        const methods = classMethods(contract.file, contract.className,
            contract.file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
        assert.equal(methods.has(contract.method), true,
            `${name} owner ${contract.className}.${contract.method} does not exist in ${contract.file}`);
    }

    const missing = [];
    for (const operation of OPERATIONS) {
        if (!operationRequiresManagementMethod(operation.name)) continue;
        if (!direct.has(operation.name)) missing.push(`direct:${operation.name}`);
        if (!web.has(operation.name)) missing.push(`web:${operation.name}`);
    }
    assert.deepEqual(missing, [], `operations missing ergonomic management methods: ${missing.join(", ")}`);

    const webSource = readFileSync(`${root}/packages/sdk/src/web/web-management-client.ts`, "utf8");
    const unsupported = [...webSource.matchAll(/webModeUnsupported\("([^"]+)"/g)]
        .map((match) => match[1])
        .filter((name) => operationNames.has(name))
        .sort();
    assert.deepEqual(
        unsupported,
        Object.keys(WEB_MODE_UNSUPPORTED_OPERATION_METHODS).sort(),
        "Web operation methods that throw must be explicitly declared with an async alternative",
    );
    for (const [name, contract] of Object.entries(WEB_MODE_UNSUPPORTED_OPERATION_METHODS)) {
        assert.ok(contract.alternative?.trim(), `${name} unsupported contract must name its alternative`);
        assert.ok(contract.reason?.trim(), `${name} unsupported contract must explain why`);
    }
});

test("agent-package and worker operations stay behind management clients", () => {
    const names = [
        "listAgentPackages", "uploadAgentPackage", "listAgentWorkerState", "listWorkers",
        "getAgentPackage", "getAgentPackageTree", "getAgentPackageFile",
        "downloadAgentPackage",
        "setAgentPackageScope", "setAgentPackageEnabled", "pinAgentPackageVersion",
        "deleteAgentPackage", "republishAgentPackageVersion",
    ];
    for (const name of names) {
        assert.equal(operationRequiresManagementMethod(name), true, `${name} must not become an exception`);
        assert.equal(direct.has(name), true, `direct management missing ${name}`);
        assert.equal(web.has(name), true, `web management missing ${name}`);
    }

    const cli = readFileSync(`${root}/packages/app/tui/src/agents-cli.js`, "utf8");
    const transport = readFileSync(`${root}/packages/app/tui/src/node-sdk-transport.js`, "utf8");
    const mcp = readFileSync(`${root}/packages/app/mcp/src/tools/agent-packages.ts`, "utf8");
    const httpTransport = classMethods(
        "packages/sdk/api/src/http-api-transport.js", "HttpApiTransport", ts.ScriptKind.JS,
    );
    assert.equal(direct.has("downloadAgentPackage"), true, "direct management missing package download");
    assert.equal(web.has("downloadAgentPackage"), true, "web management missing package download");
    assert.equal(httpTransport.has("downloadAgentPackage"), true, "HTTP transport missing package download");
    for (const [surface, source] of [["agents CLI", cli], ["TUI transport", transport]]) {
        assert.doesNotMatch(source, /PgSessionCatalog/, `${surface} must not construct the catalog`);
        assert.doesNotMatch(source, /\.ops\.(?:listAgentPackages|uploadAgentPackage|getAgentPackage|setAgentPackage|pinAgentPackage|deleteAgentPackage|republishAgentPackage)/,
            `${surface} must use management methods, not generated ops`);
    }
    assert.doesNotMatch(mcp, /\b(?:ctx\.web|web)\.ops\.(?:listAgentPackages|uploadAgentPackage|getAgentPackage|setAgentPackage|pinAgentPackage|deleteAgentPackage|republishAgentPackage)/,
        "MCP package tools must use management methods");
});

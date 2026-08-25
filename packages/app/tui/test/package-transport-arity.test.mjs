import test from "node:test";
import assert from "node:assert/strict";
import { NodeSdkTransport } from "../src/node-sdk-transport.js";

function fakeTransport() {
    const calls = [];
    const track = (name) => async (...args) => { calls.push([name, ...args]); return name === "listAgentPackages" ? [] : {}; };
    const transport = {
        currentUser: { provider: "test", subject: "local-user" },
        mgmt: {
            listAgentPackages: track("listAgentPackages"),
            getAgentPackage: track("getAgentPackage"),
            getAgentPackageTree: track("getAgentPackageTree"),
            getAgentPackageFile: track("getAgentPackageFile"),
            setAgentPackageScope: track("setAgentPackageScope"),
            setAgentPackageEnabled: track("setAgentPackageEnabled"),
            pinAgentPackageVersion: track("pinAgentPackageVersion"),
            deleteAgentPackage: track("deleteAgentPackage"),
            republishAgentPackageVersion: track("republishAgentPackageVersion"),
            uploadAgentPackage: track("uploadAgentPackage"),
            grantAgentPackageEditor: track("grantAgentPackageEditor"),
            revokeAgentPackageEditor: track("revokeAgentPackageEditor"),
            listAgentPackageEditors: track("listAgentPackageEditors"),
        },
        _reservedAgentNames: () => ["sweeper"],
        _reservedMcpServerNames: () => ["icm-mcp-rw"],
    };
    for (const name of Object.keys(transport.mgmt)) transport[name] = NodeSdkTransport.prototype[name];
    return { transport, calls };
}

test("shared UI package signatures resolve the native principal internally", async () => {
    const { transport, calls } = fakeTransport();
    const selector = { scope: "user" };
    await transport.listAgentPackages();
    await transport.getAgentPackage("pkg", selector);
    await transport.getAgentPackageTree("pkg", null, selector);
    await transport.getAgentPackageFile("pkg", null, "plugin.json", selector);
    await transport.setAgentPackageScope("pkg", "shared", selector);
    await transport.setAgentPackageEnabled("pkg", true, selector);
    await transport.pinAgentPackageVersion("pkg", "1.0.0", selector);
    await transport.deleteAgentPackage("pkg", selector);
    await transport.republishAgentPackageVersion("pkg", "1.0.0", "shared");
    await transport.uploadAgentPackage([], "user");
    const grantee = { provider: "test", subject: "alice" };
    await transport.grantAgentPackageEditor("pkg", grantee);
    await transport.revokeAgentPackageEditor("pkg", grantee);
    await transport.listAgentPackageEditors("pkg");

    for (const call of calls) {
        const name = call[0];
        const args = call.slice(1);
        if (name === "listAgentPackages") {
            assert.deepEqual(args, [transport.currentUser, true]);
            continue;
        }
        if (name === "republishAgentPackageVersion") {
            assert.equal(args[3], transport.currentUser);
            assert.equal(args[4], true);
            continue;
        }
        if (name === "uploadAgentPackage") {
            assert.equal(args[2], transport.currentUser);
            assert.equal(args[3], true);
            assert.deepEqual(args[4].reservedAgentNames, ["sweeper"]);
            assert.deepEqual(args[4].reservedMcpServerNames, ["icm-mcp-rw"], "publish refuses deployment-restricted MCP names");
            continue;
        }
        // Editors live on the shared copy: no selector, but the native
        // principal and admin authority still ride along on mutations.
        if (name === "grantAgentPackageEditor" || name === "revokeAgentPackageEditor") {
            assert.deepEqual(args, ["pkg", grantee, transport.currentUser, true]);
            continue;
        }
        if (name === "listAgentPackageEditors") {
            assert.deepEqual(args, ["pkg"]);
            continue;
        }
        assert.ok(args.includes(transport.currentUser), `${name} carries the native principal`);
        assert.ok(args.includes(true), `${name} carries direct admin authority`);
        assert.deepEqual(args.at(-1), selector, `${name} preserves the selected package copy`);
    }
});

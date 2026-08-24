import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const appPath = fileURLToPath(new URL("../src/app.js", import.meta.url));
const source = readFileSync(appPath, "utf8");

test("Admin Model Providers keeps distinct My and Shared shortcuts", () => {
    assert.match(source, /input === "m"[\s\S]*setAdminModelProviderPage\("mine"\)/);
    assert.match(source, /input === "M"[\s\S]*setAdminModelProviderPage\("shared"\)/);
    assert.match(source, /providerPage === "mine"[\s\S]*beginAdminCreateGithubProvider/);
    assert.match(source, /providerPage === "shared"[\s\S]*beginAdminCreateProvider\(\{ shared: true \}\)/);
});

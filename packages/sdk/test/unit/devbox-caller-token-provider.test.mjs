import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    createAzureCliCacheCallerTokenProvider,
    createRefreshingCallerTokenProvider,
} from "../../dist/devbox-caller-token-provider.js";
import {
    CallerAuthConfigurationError,
    CallerReauthRequiredError,
} from "../../dist/caller-auth-errors.js";

const required = {
    appIdUri: "api://example",
    scope: "api://example/.default",
};

test("reuses a cached token until it enters the refresh window", async () => {
    let now = 1_000;
    let acquisitions = 0;
    const provider = createRefreshingCallerTokenProvider(async () => {
        acquisitions++;
        return {
            token: `token-${acquisitions}`,
            expiresOnTimestamp: now + 10_000,
        };
    }, {
        now: () => now,
        refreshSkewMs: 1_000,
    });

    assert.equal(await provider(required), "token-1");
    assert.equal(await provider(required), "token-1");
    assert.equal(acquisitions, 1);

    now = 10_001;
    assert.equal(await provider(required), "token-2");
    assert.equal(acquisitions, 2);
});

test("coalesces concurrent refreshes for the same scope", async () => {
    let release;
    let acquisitions = 0;
    const gate = new Promise((resolve) => { release = resolve; });
    const provider = createRefreshingCallerTokenProvider(async () => {
        acquisitions++;
        await gate;
        return {
            token: "shared-token",
            expiresOnTimestamp: Date.now() + 60_000,
        };
    });

    const first = provider(required);
    const second = provider(required);
    release();

    assert.deepEqual(await Promise.all([first, second]), [
        "shared-token",
        "shared-token",
    ]);
    assert.equal(acquisitions, 1);
});

test("does not cache an audience that is unavailable to the caller", async () => {
    let acquisitions = 0;
    const provider = createRefreshingCallerTokenProvider(async () => {
        acquisitions++;
        return null;
    });

    assert.equal(await provider(required), null);
    assert.equal(await provider(required), null);
    assert.equal(acquisitions, 2);
});

test("preserves configuration errors instead of turning them into re-auth", async () => {
    const expected = new CallerAuthConfigurationError("select an account");
    const provider = createRefreshingCallerTokenProvider(async () => {
        throw expected;
    });

    await assert.rejects(provider(required), (error) => error === expected);
});

test("a synchronous acquisition failure does not poison later retries", async () => {
    let acquisitions = 0;
    const provider = createRefreshingCallerTokenProvider(() => {
        acquisitions++;
        if (acquisitions === 1) {
            throw new CallerReauthRequiredError("sign in");
        }
        return Promise.resolve({
            token: "recovered-token",
            expiresOnTimestamp: Date.now() + 60_000,
        });
    });

    await assert.rejects(provider(required), CallerReauthRequiredError);
    assert.equal(await provider(required), "recovered-token");
    assert.equal(acquisitions, 2);
});

test("reports a typed re-auth error when the portable cache has no refresh token", async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "pilotswarm-msal-"));
    try {
        await fs.writeFile(
            path.join(configDir, "msal_token_cache.json"),
            JSON.stringify({ AccessToken: {} }),
            "utf8",
        );
        const provider = createAzureCliCacheCallerTokenProvider({ configDir });
        await assert.rejects(
            provider(required),
            (error) => {
                assert.ok(error instanceof CallerReauthRequiredError);
                assert.match(error.message, /no refresh token/i);
                return true;
            },
        );
    } finally {
        await fs.rm(configDir, { recursive: true, force: true });
    }
});

/**
 * Unit tests for the pg-pool factory feature switch (Chunk C).
 *
 * Pure logic — no live database needed. Imports the compiled SDK so this
 * runs from the same vitest setup as the rest of the local suites.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
    buildPgPoolConfig,
    readManagedIdentityFlag,
    _setPgAadCredentialForTests,
} from "../../dist/pg-pool-factory.js";

afterEach(() => {
    _setPgAadCredentialForTests(null);
});

describe("buildPgPoolConfig", () => {
    it("legacy: returns connectionString + ssl when sslmode=require", () => {
        const cfg = buildPgPoolConfig({
            connectionString: "postgresql://u:p@h:5432/db?sslmode=require",
        });
        expect(cfg.connectionString).toBeDefined();
        expect(cfg.connectionString).not.toMatch(/sslmode/i);
        expect(cfg.connectionString).toMatch(/^postgresql:\/\/u:p@h:5432\/db/);
        expect(cfg.ssl).toEqual({ rejectUnauthorized: false });
        expect(cfg.max).toBe(3);
        expect(cfg.password).toBeUndefined();
    });

    it("legacy: omits ssl when sslmode is absent", () => {
        const cfg = buildPgPoolConfig({
            connectionString: "postgresql://u:p@h:5432/db",
        });
        expect(cfg.ssl).toBeUndefined();
    });

    it("MI: strips password and installs token callback", async () => {
        const fakeCredential = {
            getToken: async () => ({ token: "fake-aad-token", expiresOnTimestamp: Date.now() + 3600_000 }),
        };
        _setPgAadCredentialForTests(fakeCredential);

        const cfg = buildPgPoolConfig({
            connectionString: "postgresql://ignored-user:ignored-pwd@h:5432/db?sslmode=require",
            useManagedIdentity: true,
            aadUser: "uami-display-name",
        });

        expect(cfg.connectionString).toBeUndefined();
        expect(cfg.host).toBe("h");
        expect(cfg.port).toBe(5432);
        expect(cfg.database).toBe("db");
        expect(cfg.user).toBe("uami-display-name");
        expect(cfg.ssl).toEqual({ rejectUnauthorized: false });

        expect(typeof cfg.password).toBe("function");
        const token = await cfg.password();
        expect(token).toBe("fake-aad-token");
    });

    it("MI: defaults user to URL `user@` when aadUser is not provided", () => {
        const fakeCredential = {
            getToken: async () => ({ token: "t", expiresOnTimestamp: Date.now() + 60_000 }),
        };
        _setPgAadCredentialForTests(fakeCredential);

        const cfg = buildPgPoolConfig({
            connectionString: "postgresql://uami-name@h:5432/db?sslmode=require",
            useManagedIdentity: true,
        });
        expect(cfg.user).toBe("uami-name");
    });

    it("MI: throws when no user is available", () => {
        _setPgAadCredentialForTests({
            getToken: async () => ({ token: "t", expiresOnTimestamp: Date.now() + 60_000 }),
        });
        expect(() =>
            buildPgPoolConfig({
                connectionString: "postgresql://h:5432/db",
                useManagedIdentity: true,
            }),
        ).toThrow(/managed-identity mode requires a Postgres user/);
    });

    it("MI: callback throws when credential returns no token", async () => {
        _setPgAadCredentialForTests({
            getToken: async () => null,
        });
        const cfg = buildPgPoolConfig({
            connectionString: "postgresql://u@h:5432/db?sslmode=require",
            useManagedIdentity: true,
        });
        await expect(cfg.password()).rejects.toThrow(/Failed to acquire AAD token/);
    });
});

describe("readManagedIdentityFlag", () => {
    const cases = [
        ["1", true],
        ["true", true],
        ["TRUE", true],
        ["yes", true],
        ["on", true],
        ["", false],
        [undefined, false],
        ["0", false],
        ["false", false],
        ["no", false],
    ];
    for (const [input, expected] of cases) {
        it(`flag=${JSON.stringify(input)} -> ${expected}`, () => {
            expect(readManagedIdentityFlag({ PILOTSWARM_USE_MANAGED_IDENTITY: input })).toBe(expected);
        });
    }
});

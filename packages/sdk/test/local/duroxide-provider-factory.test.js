/**
 * Unit tests for the duroxide orchestration-store provider factory.
 *
 * Pure logic — no live database needed. Mocks the duroxide
 * `PostgresProvider` shape so the test stays in sync with whatever
 * arguments worker.ts passes through.
 */
import { describe, it, expect } from "vitest";
import { createDuroxidePostgresProvider } from "../../src/duroxide-provider-factory.ts";

function makeMockProvider() {
    const calls = { connectWithSchema: [], connectWithSchemaAndEntra: [] };
    return {
        calls,
        connectWithSchema: async (...args) => {
            calls.connectWithSchema.push(args);
            return { _kind: "legacy" };
        },
        connectWithSchemaAndEntra: async (...args) => {
            calls.connectWithSchemaAndEntra.push(args);
            return { _kind: "entra" };
        },
    };
}

describe("createDuroxidePostgresProvider", () => {
    it("legacy: routes to connectWithSchema with the original store URL", async () => {
        const mock = makeMockProvider();
        const result = await createDuroxidePostgresProvider(
            mock,
            "postgresql://u:p@h:5432/db?sslmode=require",
            "duroxide",
        );
        expect(result).toEqual({ _kind: "legacy" });
        expect(mock.calls.connectWithSchemaAndEntra).toHaveLength(0);
        expect(mock.calls.connectWithSchema).toEqual([
            ["postgresql://u:p@h:5432/db?sslmode=require", "duroxide"],
        ]);
    });

    it("legacy: explicit useManagedIdentity:false also takes the password path", async () => {
        const mock = makeMockProvider();
        await createDuroxidePostgresProvider(
            mock,
            "postgres://u:p@h/db",
            "duroxide",
            { useManagedIdentity: false, aadUser: "ignored" },
        );
        expect(mock.calls.connectWithSchema).toHaveLength(1);
        expect(mock.calls.connectWithSchemaAndEntra).toHaveLength(0);
    });

    it("MI: routes to connectWithSchemaAndEntra with parsed host/port/database and aadUser", async () => {
        const mock = makeMockProvider();
        const result = await createDuroxidePostgresProvider(
            mock,
            "postgresql://ignored-user:ignored-pwd@my-pg.postgres.database.azure.com:5432/pilotswarm?sslmode=require",
            "duroxide",
            { useManagedIdentity: true, aadUser: "uami-display-name" },
        );
        expect(result).toEqual({ _kind: "entra" });
        expect(mock.calls.connectWithSchema).toHaveLength(0);
        expect(mock.calls.connectWithSchemaAndEntra).toEqual([
            [
                "my-pg.postgres.database.azure.com",
                5432,
                "pilotswarm",
                "uami-display-name",
                "duroxide",
            ],
        ]);
    });

    it("MI: falls back to the URL user@ segment when aadUser is omitted", async () => {
        const mock = makeMockProvider();
        await createDuroxidePostgresProvider(
            mock,
            "postgresql://uami-from-url@h:5432/db?sslmode=require",
            "duroxide",
            { useManagedIdentity: true },
        );
        expect(mock.calls.connectWithSchemaAndEntra[0][3]).toBe("uami-from-url");
    });

    it("MI: defaults port to 5432 and database to 'postgres' when URL omits them", async () => {
        const mock = makeMockProvider();
        await createDuroxidePostgresProvider(
            mock,
            "postgresql://uami@h",
            "duroxide",
            { useManagedIdentity: true },
        );
        const [host, port, database, user, schema] = mock.calls.connectWithSchemaAndEntra[0];
        expect(host).toBe("h");
        expect(port).toBe(5432);
        expect(database).toBe("postgres");
        expect(user).toBe("uami");
        expect(schema).toBe("duroxide");
    });

    it("MI: throws when neither aadUser nor URL user is provided", async () => {
        const mock = makeMockProvider();
        await expect(
            createDuroxidePostgresProvider(
                mock,
                "postgresql://h:5432/db",
                "duroxide",
                { useManagedIdentity: true },
            ),
        ).rejects.toThrow(/managed-identity mode requires a Postgres user/);
        expect(mock.calls.connectWithSchemaAndEntra).toHaveLength(0);
        expect(mock.calls.connectWithSchema).toHaveLength(0);
    });
});

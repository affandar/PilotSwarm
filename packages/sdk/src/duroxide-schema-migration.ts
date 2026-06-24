export interface DuroxideSchemaMigrationOptions {
    legacySchema?: string;
    targetSchema?: string;
    installCreateSchemaGuard?: boolean;
    requireCreateSchemaGuard?: boolean;
    blockedRole?: string;
    guardName?: string;
    lockKey?: number;
}

export interface DuroxideSchemaMigrationResult {
    migrated: boolean;
    skippedReason?: "legacy-missing" | "already-migrated";
    legacySchema: string;
    targetSchema: string;
    guardInstalled: boolean;
    guardError?: string;
}

const DEFAULT_LOCK_KEY = 0x50534458; // P S D X

function quoteIdent(identifier: string): string {
    return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function assertSafeSchemaName(name: string, label: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`${label} must be a simple PostgreSQL identifier, got ${JSON.stringify(name)}`);
    }
}

async function schemaExists(client: any, schema: string): Promise<boolean> {
    const { rows } = await client.query(
        "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS exists",
        [schema],
    );
    return Boolean(rows[0]?.exists);
}

async function installLegacySchemaGuard(client: any, opts: {
    legacySchema: string;
    targetSchema: string;
    guardName: string;
    blockedRole?: string;
}): Promise<void> {
    const target = quoteIdent(opts.targetSchema);
    const guardFunction = quoteIdent(`${opts.guardName}_fn`);
    const guardName = quoteIdent(opts.guardName);
    const blockedRole = opts.blockedRole;
    if (!blockedRole) {
        throw new Error("Cannot install legacy schema guard without blockedRole (PilotSwarm runtime DB role)");
    }
    const blockedRoleClause = `AND current_user = ${quoteLiteral(blockedRole)}`;

    await client.query(`
CREATE OR REPLACE FUNCTION ${target}.${guardFunction}()
RETURNS event_trigger
LANGUAGE plpgsql
AS $$
DECLARE
    cmd record;
BEGIN
    FOR cmd IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
        IF cmd.command_tag = 'CREATE SCHEMA'
           AND cmd.object_type = 'schema'
           AND cmd.object_identity = ${quoteLiteral(opts.legacySchema)}
           ${blockedRoleClause}
        THEN
            RAISE EXCEPTION 'PilotSwarm legacy duroxide schema % is blocked; use ${opts.targetSchema}', cmd.object_identity;
        END IF;
    END LOOP;
END;
$$;
`);
    await client.query(`DROP EVENT TRIGGER IF EXISTS ${guardName}`);
    await client.query(`
CREATE EVENT TRIGGER ${guardName}
ON ddl_command_end
WHEN TAG IN ('CREATE SCHEMA')
EXECUTE FUNCTION ${target}.${guardFunction}();
`);
}

export async function migrateLegacyDuroxideSchema(pool: any, options: DuroxideSchemaMigrationOptions = {}): Promise<DuroxideSchemaMigrationResult> {
    const legacySchema = options.legacySchema ?? "duroxide";
    const targetSchema = options.targetSchema ?? "ps_duroxide";
    const guardName = options.guardName ?? "pilotswarm_block_legacy_duroxide_schema";
    const lockKey = options.lockKey ?? DEFAULT_LOCK_KEY;

    assertSafeSchemaName(legacySchema, "legacySchema");
    assertSafeSchemaName(targetSchema, "targetSchema");
    assertSafeSchemaName(guardName, "guardName");
    if (legacySchema === targetSchema) {
        throw new Error("legacySchema and targetSchema must differ");
    }

    const client = await pool.connect();
    let shouldInstallGuard = false;
    let result: DuroxideSchemaMigrationResult | undefined;
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1)", [lockKey]);

        const legacyExists = await schemaExists(client, legacySchema);
        const targetExists = await schemaExists(client, targetSchema);

        if (!legacyExists && targetExists) {
            await client.query("COMMIT");
            shouldInstallGuard = Boolean(options.installCreateSchemaGuard);
            result = { migrated: false, skippedReason: "already-migrated", legacySchema, targetSchema, guardInstalled: false };
            return await maybeInstallGuard(client, result, shouldInstallGuard, options, guardName);
        }
        if (!legacyExists) {
            await client.query("COMMIT");
            return { migrated: false, skippedReason: "legacy-missing", legacySchema, targetSchema, guardInstalled: false };
        }
        if (targetExists) {
            throw new Error(`Cannot migrate ${legacySchema} to ${targetSchema}: target schema already exists`);
        }

        await client.query(`ALTER SCHEMA ${quoteIdent(legacySchema)} RENAME TO ${quoteIdent(targetSchema)}`);

        await client.query("COMMIT");
        shouldInstallGuard = Boolean(options.installCreateSchemaGuard);
        result = { migrated: true, legacySchema, targetSchema, guardInstalled: false };
        return await maybeInstallGuard(client, result, shouldInstallGuard, options, guardName);
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function maybeInstallGuard(
    client: any,
    result: DuroxideSchemaMigrationResult,
    shouldInstallGuard: boolean,
    options: DuroxideSchemaMigrationOptions,
    guardName: string,
): Promise<DuroxideSchemaMigrationResult> {
    if (!shouldInstallGuard || result.skippedReason === "legacy-missing") return result;
    try {
        await client.query("BEGIN");
        await installLegacySchemaGuard(client, {
            legacySchema: result.legacySchema,
            targetSchema: result.targetSchema,
            guardName,
            blockedRole: options.blockedRole,
        });
        await client.query("COMMIT");
        return { ...result, guardInstalled: true };
    } catch (err: any) {
        await client.query("ROLLBACK").catch(() => {});
        if (options.requireCreateSchemaGuard) {
            throw new Error(
                `Duroxide schema migration completed but legacy schema guard installation failed: ${err?.message ?? String(err)}`,
            );
        }
        return { ...result, guardInstalled: false, guardError: err?.message ?? String(err) };
    }
}

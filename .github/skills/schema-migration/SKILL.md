---
name: schema-migration
description: Add or modify a PostgreSQL schema migration for the CMS or Facts store. Covers creating migration functions, stored procedure changes, diff file generation, and TypeScript caller updates.
---

# Schema Migration

The CMS and Facts stores use versioned SQL migrations with advisory-lock serialization. All Postgres data access goes through stored procedures created by these migrations. Schema changes follow the same pattern as duroxide-pg: ordered migration functions, idempotent DDL, and a required companion diff file for code review.

## Architecture

```
pg-migrator.ts          — shared advisory-lock migration runner
cms-migrator.ts         — thin CMS wrapper (lock seed 0x636D73)
facts-migrator.ts       — thin Facts wrapper (lock seed 0x666163)
cms-migrations.ts       — ordered CMS migration list
facts-migrations.ts     — ordered Facts migration list
```

Each system maintains its own `schema_migrations` table within its Postgres schema (`copilot_sessions` for CMS, `pilotswarm_facts` for Facts). Migrations are applied automatically on `initialize()`.

## Adding a New Migration

### 1. Write the migration function

Add a new entry to `CMS_MIGRATIONS()` in `cms-migrations.ts` or `FACTS_MIGRATIONS()` in `facts-migrations.ts`:

```typescript
{
    version: "NNNN",
    name: "descriptive_name",
    sql: migration_NNNN_descriptive_name(schema),
},
```

Then define the function:

```typescript
function migration_NNNN_descriptive_name(schema: string): string {
    const s = `"${schema}"`;
    return `
-- NNNN_descriptive_name: what this migration does.

-- DDL changes (idempotent)
CREATE TABLE IF NOT EXISTS ${s}.new_table (...);
ALTER TABLE ${s}.existing_table ADD COLUMN IF NOT EXISTS new_col TEXT;

-- Stored procedure changes
CREATE OR REPLACE FUNCTION ${s}.my_proc(...) RETURNS ... AS $$
BEGIN
    ...
END;
$$ LANGUAGE plpgsql;
`;
}
```

### 2. Key rules for migration SQL

- **Idempotent**: Use `IF NOT EXISTS`, `IF EXISTS`, `CREATE OR REPLACE` so re-running is safe.
- **Schema-parameterized**: The `schema` argument is interpolated into all qualified names. Never hard-code a schema name.
- **Stored procedures**: All new data-access queries must be stored procedures (`CREATE OR REPLACE FUNCTION`). No inline SQL in TypeScript.
- **Transactional**: Each migration runs inside its own `BEGIN`/`COMMIT` block (handled by the migrator).
- **Version numbering**: Use sequential 4-digit zero-padded versions (`0001`, `0002`, ...). Check the current highest version in the migrations list.

### 3. Generate the diff file (REQUIRED)

Every migration that modifies schema or stored procedures **must** have a companion diff markdown file. This is required because git diffs for SQL-in-TypeScript migrations only show the new code, not the delta from the previous version.

Create the diff file at `packages/sdk/src/migrations/NNNN_diff.md` (CMS) or `packages/sdk/src/migrations/NNNN_facts_diff.md` (Facts).

#### Diff format

```markdown
# Diff for migration NNNN

Migration file: `cms-migrations.ts` — `migration_NNNN_name`

## Table Changes

### `table_name` — new table
(full DDL in a ```sql block)

### `table_name` — modified
(mark new columns with `+` in a ```diff block)

## New Indexes

(full DDL in ```sql blocks, or "None.")

## Function Changes

### `func_name` — new
(signature in a ```diff block with `+` markers, prose description)

### `func_name` — body modified (baseline: NNNN)
(unified diff in a ```diff block showing changed lines with +/- markers)
```

#### How to produce diffs for modified stored procedures

1. **Find the baseline**: Identify the most recent migration that contains `CREATE OR REPLACE FUNCTION ... func_name`. That is the baseline version.
2. **Extract both bodies**: Copy the function body from the baseline migration and the new migration.
3. **Normalize**: Replace schema placeholders with `SCHEMA.` for consistent diffing.
4. **Diff**: Run `diff -u baseline.sql new.sql` to get unified diff output.
5. **Include**: Place the diff hunks in a ` ```diff ` code block under a heading that notes the baseline migration number.

See existing examples:
- `packages/sdk/src/migrations/0004_diff.md` (all-new CMS stored procedures)
- `packages/sdk/src/migrations/0002_facts_diff.md` (all-new Facts stored procedures)

### 4. Update TypeScript callers

After adding or modifying a stored procedure:

1. **Update `sqlForSchema()`** — add the new function name to the `fn` map in `cms.ts` or `facts-store.ts`:
   ```typescript
   fn: {
       myNewProc: `${s}.cms_my_new_proc`,
   }
   ```

2. **Update the provider method** — call the stored proc instead of inline SQL:
   ```typescript
   async myMethod(args: MyArgs): Promise<MyResult> {
       const { rows } = await this.pool.query(
           `SELECT * FROM ${this.sql.fn.myNewProc}($1, $2)`,
           [args.foo, args.bar],
       );
       return rows.map(rowToMyResult);
   }
   ```

3. **Row mappers stay in TypeScript** — `rowToSessionRow()`, `rowToSessionEvent()`, etc. still handle PG snake_case → TS camelCase conversion.

### 5. Build and test

```bash
cd packages/sdk
npm run build                    # TypeScript compilation
npx vitest run test/local/       # integration tests
```

Migrations are applied automatically when `initialize()` is called. Existing deployments will pick up new migrations on next startup.

## Modifying an Existing Stored Procedure

Never edit a previous migration. Instead:

1. Add a new migration with `CREATE OR REPLACE FUNCTION` for the modified procedure.
2. Generate a diff file showing the delta from the baseline version.
3. Update the TypeScript caller if the function signature changed.

## Migration System Internals

- **Advisory locks**: Each system uses a unique lock seed hashed with the schema name to prevent concurrent workers from double-applying migrations.
- **Tracking table**: `{schema}.schema_migrations` with columns `(version TEXT PK, name TEXT, applied_at TIMESTAMPTZ)`.
- **Ordering**: Migrations are applied in array order. The version string is compared against the tracking table.
- **Error handling**: Failed migrations trigger `ROLLBACK` and re-throw. The migration is not recorded as applied.

## Key files

- [packages/sdk/src/pg-migrator.ts](../../../packages/sdk/src/pg-migrator.ts) — shared migration runner
- [packages/sdk/src/cms-migrations.ts](../../../packages/sdk/src/cms-migrations.ts) — CMS migration definitions
- [packages/sdk/src/facts-migrations.ts](../../../packages/sdk/src/facts-migrations.ts) — Facts migration definitions
- [packages/sdk/src/cms-migrator.ts](../../../packages/sdk/src/cms-migrator.ts) — CMS migrator wrapper
- [packages/sdk/src/facts-migrator.ts](../../../packages/sdk/src/facts-migrator.ts) — Facts migrator wrapper
- [packages/sdk/src/cms.ts](../../../packages/sdk/src/cms.ts) — CMS provider (stored proc callers)
- [packages/sdk/src/facts-store.ts](../../../packages/sdk/src/facts-store.ts) — Facts provider (stored proc callers)
- [packages/sdk/src/migrations/](../../../packages/sdk/src/migrations/) — diff files for code review

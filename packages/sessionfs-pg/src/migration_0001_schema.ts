/**
 * Postgres-backed Copilot SessionFs store.
 *
 * Migration 0001: schema (tables, enum, indexes).
 *
 * Conventions:
 *   - All identifiers live in the caller-supplied schema; the migration runner
 *     creates the schema if missing.
 *   - Path canonicalization is the provider's responsibility; the SQL trusts
 *     that `path` is already a normalized POSIX path with `/` root.
 *   - Content is stored as `text` because the SDK's SessionFsProvider API is
 *     string-typed end-to-end (see node_modules/@github/copilot-sdk/dist/sessionFsProvider.d.ts).
 *
 * @internal
 */
export function migration_0001_schema(schema: string): string {
    const s = `"${schema}"`;
    return `
        DO $do$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_type t
                JOIN pg_namespace n ON n.oid = t.typnamespace
                WHERE t.typname = 'sessionfs_node_type'
                  AND n.nspname = '${schema}'
            ) THEN
                CREATE TYPE ${s}.sessionfs_node_type AS ENUM ('file', 'directory');
            END IF;
        END
        $do$;

        CREATE TABLE IF NOT EXISTS ${s}.sessionfs_sessions (
            session_id        TEXT PRIMARY KEY,
            created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at        TIMESTAMPTZ,
            lease_owner       TEXT,
            lease_expires_at  TIMESTAMPTZ,
            version           BIGINT NOT NULL DEFAULT 0,
            workspace_yaml    TEXT
        );

        CREATE TABLE IF NOT EXISTS ${s}.sessionfs_nodes (
            session_id            TEXT NOT NULL
                REFERENCES ${s}.sessionfs_sessions(session_id) ON DELETE CASCADE,
            path                  TEXT NOT NULL,
            parent_path           TEXT NOT NULL,
            name                  TEXT NOT NULL,
            node_type             ${s}.sessionfs_node_type NOT NULL,
            content               TEXT,
            mode                  INTEGER,
            size_bytes            BIGINT NOT NULL DEFAULT 0,
            pending_segment_bytes BIGINT NOT NULL DEFAULT 0,
            created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (session_id, path),
            CONSTRAINT sessionfs_file_has_content CHECK (
                (node_type = 'directory' AND content IS NULL)
                OR node_type = 'file'
            )
        );

        CREATE INDEX IF NOT EXISTS idx_${schema}_sessionfs_nodes_parent
            ON ${s}.sessionfs_nodes(session_id, parent_path);

        CREATE TABLE IF NOT EXISTS ${s}.sessionfs_append_segments (
            session_id  TEXT NOT NULL
                REFERENCES ${s}.sessionfs_sessions(session_id) ON DELETE CASCADE,
            path        TEXT NOT NULL,
            segment_no  BIGSERIAL PRIMARY KEY,
            content     TEXT NOT NULL,
            size_bytes  BIGINT NOT NULL,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            fs_version  BIGINT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_${schema}_sessionfs_segments_path
            ON ${s}.sessionfs_append_segments(session_id, path, segment_no);

        -- Insert root directory automatically for every new session row.
        CREATE OR REPLACE FUNCTION ${s}.sessionfs_create_root() RETURNS TRIGGER AS $trg$
        BEGIN
            INSERT INTO ${s}.sessionfs_nodes
                (session_id, path, parent_path, name, node_type, content)
            VALUES
                (NEW.session_id, '/', '', '', 'directory', NULL)
            ON CONFLICT (session_id, path) DO NOTHING;
            RETURN NEW;
        END
        $trg$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS sessionfs_session_root_trg ON ${s}.sessionfs_sessions;
        CREATE TRIGGER sessionfs_session_root_trg
            AFTER INSERT ON ${s}.sessionfs_sessions
            FOR EACH ROW
            EXECUTE FUNCTION ${s}.sessionfs_create_root();
    `;
}

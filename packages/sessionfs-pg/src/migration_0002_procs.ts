/**
 * Postgres-backed Copilot SessionFs store.
 *
 * Migration 0002: stored procedures for every read/write operation.
 *
 * Design notes:
 *   - The provider only ever calls SELECT <schema>.fs_*; no inline DML in TS.
 *   - Helpers `_fs_*` are not part of the public proc surface but live in the
 *     same schema for locality.
 *   - Path arguments must already be canonicalized POSIX paths (root '/').
 *   - Errors are raised with SQLSTATE 'P0002' (no_data_found) for missing
 *     paths so the TS provider can map them to ENOENT cleanly. All other
 *     errors propagate naturally and become UNKNOWN at the SDK boundary.
 *
 * @internal
 */
export function migration_0002_procs(schema: string): string {
    const s = `"${schema}"`;
    return `
        -- ────────────────────────────────────────────────────────────────────
        -- Helpers
        -- ────────────────────────────────────────────────────────────────────

        CREATE OR REPLACE FUNCTION ${s}._fs_bump_version(p_session_id TEXT)
        RETURNS BIGINT AS $$
            UPDATE ${s}.sessionfs_sessions
                SET version = version + 1, updated_at = now()
                WHERE session_id = p_session_id
                RETURNING version;
        $$ LANGUAGE sql;

        CREATE OR REPLACE FUNCTION ${s}._fs_parent_of(p_path TEXT)
        RETURNS TEXT AS $$
        DECLARE
            idx INT;
        BEGIN
            IF p_path = '/' THEN
                RETURN '';
            END IF;
            idx := length(p_path) - position('/' IN reverse(p_path)) + 1;
            IF idx <= 1 THEN
                RETURN '/';
            END IF;
            RETURN substring(p_path FROM 1 FOR idx - 1);
        END
        $$ LANGUAGE plpgsql IMMUTABLE;

        CREATE OR REPLACE FUNCTION ${s}._fs_basename(p_path TEXT)
        RETURNS TEXT AS $$
        BEGIN
            IF p_path = '/' THEN
                RETURN '';
            END IF;
            RETURN substring(p_path FROM length(p_path) - position('/' IN reverse(p_path)) + 2);
        END
        $$ LANGUAGE plpgsql IMMUTABLE;

        -- Ensure every parent directory of p_path exists. Idempotent.
        CREATE OR REPLACE FUNCTION ${s}._fs_ensure_parents(p_session_id TEXT, p_path TEXT)
        RETURNS VOID AS $$
        DECLARE
            parts TEXT[];
            cur TEXT := '';
            piece TEXT;
        BEGIN
            IF p_path = '/' THEN RETURN; END IF;
            parts := string_to_array(trim(both '/' from p_path), '/');
            -- Walk every prefix EXCEPT the leaf itself.
            FOR i IN 1..array_length(parts, 1) - 1 LOOP
                piece := parts[i];
                cur := cur || '/' || piece;
                INSERT INTO ${s}.sessionfs_nodes
                    (session_id, path, parent_path, name, node_type)
                VALUES
                    (p_session_id, cur, ${s}._fs_parent_of(cur), piece, 'directory')
                ON CONFLICT (session_id, path) DO NOTHING;
            END LOOP;
        END
        $$ LANGUAGE plpgsql;

        -- ────────────────────────────────────────────────────────────────────
        -- Session lifecycle
        -- ────────────────────────────────────────────────────────────────────

        CREATE OR REPLACE FUNCTION ${s}.fs_ensure_session(p_session_id TEXT)
        RETURNS BIGINT AS $$
            INSERT INTO ${s}.sessionfs_sessions(session_id) VALUES (p_session_id)
                ON CONFLICT (session_id) DO UPDATE SET updated_at = now()
                RETURNING version;
        $$ LANGUAGE sql;

        CREATE OR REPLACE FUNCTION ${s}.fs_drop_session(p_session_id TEXT)
        RETURNS VOID AS $$
            DELETE FROM ${s}.sessionfs_sessions WHERE session_id = p_session_id;
        $$ LANGUAGE sql;

        -- ────────────────────────────────────────────────────────────────────
        -- Reads
        -- ────────────────────────────────────────────────────────────────────

        CREATE OR REPLACE FUNCTION ${s}.fs_read_file(
            p_session_id TEXT,
            p_path       TEXT
        ) RETURNS TEXT AS $$
        DECLARE
            base   TEXT;
            ntype  ${s}.sessionfs_node_type;
            extra  TEXT;
        BEGIN
            SELECT content, node_type INTO base, ntype
                FROM ${s}.sessionfs_nodes
                WHERE session_id = p_session_id AND path = p_path;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'ENOENT: %', p_path USING ERRCODE = 'P0002';
            END IF;
            IF ntype <> 'file' THEN
                RAISE EXCEPTION 'EISDIR: %', p_path USING ERRCODE = 'P0002';
            END IF;

            SELECT string_agg(content, '' ORDER BY segment_no)
                INTO extra
                FROM ${s}.sessionfs_append_segments
                WHERE session_id = p_session_id AND path = p_path;

            RETURN COALESCE(base, '') || COALESCE(extra, '');
        END
        $$ LANGUAGE plpgsql;

        CREATE OR REPLACE FUNCTION ${s}.fs_exists(
            p_session_id TEXT,
            p_path       TEXT
        ) RETURNS BOOLEAN AS $$
            SELECT EXISTS (
                SELECT 1 FROM ${s}.sessionfs_nodes
                    WHERE session_id = p_session_id AND path = p_path
            );
        $$ LANGUAGE sql;

        CREATE OR REPLACE FUNCTION ${s}.fs_stat(
            p_session_id TEXT,
            p_path       TEXT,
            OUT is_file      BOOLEAN,
            OUT is_directory BOOLEAN,
            OUT size         BIGINT,
            OUT mtime        TIMESTAMPTZ,
            OUT birthtime    TIMESTAMPTZ
        ) AS $$
        DECLARE
            n RECORD;
        BEGIN
            SELECT node_type, size_bytes, pending_segment_bytes, created_at, updated_at
                INTO n
                FROM ${s}.sessionfs_nodes
                WHERE session_id = p_session_id AND path = p_path;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'ENOENT: %', p_path USING ERRCODE = 'P0002';
            END IF;
            is_file      := (n.node_type = 'file');
            is_directory := (n.node_type = 'directory');
            size         := n.size_bytes + n.pending_segment_bytes;
            mtime        := n.updated_at;
            birthtime    := n.created_at;
        END
        $$ LANGUAGE plpgsql;

        CREATE OR REPLACE FUNCTION ${s}.fs_readdir(
            p_session_id TEXT,
            p_path       TEXT
        ) RETURNS TABLE(name TEXT) AS $$
        BEGIN
            -- Verify the dir exists and is a directory.
            PERFORM 1 FROM ${s}.sessionfs_nodes
                WHERE session_id = p_session_id AND path = p_path AND node_type = 'directory';
            IF NOT FOUND THEN
                RAISE EXCEPTION 'ENOENT: %', p_path USING ERRCODE = 'P0002';
            END IF;
            RETURN QUERY
                SELECT n.name FROM ${s}.sessionfs_nodes n
                    WHERE n.session_id = p_session_id
                      AND n.parent_path = p_path
                      AND n.path <> '/';
        END
        $$ LANGUAGE plpgsql;

        CREATE OR REPLACE FUNCTION ${s}.fs_readdir_with_types(
            p_session_id TEXT,
            p_path       TEXT
        ) RETURNS TABLE(name TEXT, kind TEXT) AS $$
        BEGIN
            PERFORM 1 FROM ${s}.sessionfs_nodes
                WHERE session_id = p_session_id AND path = p_path AND node_type = 'directory';
            IF NOT FOUND THEN
                RAISE EXCEPTION 'ENOENT: %', p_path USING ERRCODE = 'P0002';
            END IF;
            RETURN QUERY
                SELECT n.name, n.node_type::TEXT FROM ${s}.sessionfs_nodes n
                    WHERE n.session_id = p_session_id
                      AND n.parent_path = p_path
                      AND n.path <> '/';
        END
        $$ LANGUAGE plpgsql;

        -- ────────────────────────────────────────────────────────────────────
        -- Writes
        -- ────────────────────────────────────────────────────────────────────

        CREATE OR REPLACE FUNCTION ${s}.fs_mkdir(
            p_session_id TEXT,
            p_path       TEXT,
            p_recursive  BOOLEAN,
            p_mode       INTEGER
        ) RETURNS BIGINT AS $$
        DECLARE
            existing ${s}.sessionfs_node_type;
            parent   TEXT;
        BEGIN
            PERFORM ${s}.fs_ensure_session(p_session_id);

            SELECT node_type INTO existing FROM ${s}.sessionfs_nodes
                WHERE session_id = p_session_id AND path = p_path;
            IF FOUND THEN
                IF existing = 'directory' THEN
                    RETURN (SELECT version FROM ${s}.sessionfs_sessions WHERE session_id = p_session_id);
                END IF;
                RAISE EXCEPTION 'EEXIST file at %', p_path;
            END IF;

            IF p_recursive THEN
                PERFORM ${s}._fs_ensure_parents(p_session_id, p_path);
            ELSE
                parent := ${s}._fs_parent_of(p_path);
                PERFORM 1 FROM ${s}.sessionfs_nodes
                    WHERE session_id = p_session_id AND path = parent AND node_type = 'directory';
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'ENOENT parent %', parent USING ERRCODE = 'P0002';
                END IF;
            END IF;

            INSERT INTO ${s}.sessionfs_nodes
                (session_id, path, parent_path, name, node_type, mode)
            VALUES
                (p_session_id, p_path, ${s}._fs_parent_of(p_path), ${s}._fs_basename(p_path), 'directory', p_mode);

            RETURN ${s}._fs_bump_version(p_session_id);
        END
        $$ LANGUAGE plpgsql;

        CREATE OR REPLACE FUNCTION ${s}.fs_write_file(
            p_session_id TEXT,
            p_path       TEXT,
            p_content    TEXT,
            p_mode       INTEGER
        ) RETURNS BIGINT AS $$
        DECLARE
            existing ${s}.sessionfs_node_type;
        BEGIN
            PERFORM ${s}.fs_ensure_session(p_session_id);

            SELECT node_type INTO existing FROM ${s}.sessionfs_nodes
                WHERE session_id = p_session_id AND path = p_path;
            IF FOUND AND existing <> 'file' THEN
                RAISE EXCEPTION 'EISDIR: %', p_path;
            END IF;

            -- Auto-create parent directories (matches Node fs / SDK semantics).
            PERFORM ${s}._fs_ensure_parents(p_session_id, p_path);

            INSERT INTO ${s}.sessionfs_nodes
                (session_id, path, parent_path, name, node_type, content, mode,
                 size_bytes, pending_segment_bytes, updated_at)
            VALUES
                (p_session_id, p_path, ${s}._fs_parent_of(p_path), ${s}._fs_basename(p_path),
                 'file', p_content, p_mode, octet_length(p_content), 0, now())
            ON CONFLICT (session_id, path) DO UPDATE
                SET content = EXCLUDED.content,
                    mode = COALESCE(EXCLUDED.mode, ${s}.sessionfs_nodes.mode),
                    size_bytes = octet_length(EXCLUDED.content),
                    pending_segment_bytes = 0,
                    updated_at = now();

            -- writeFile truncates: drop any pending append segments.
            DELETE FROM ${s}.sessionfs_append_segments
                WHERE session_id = p_session_id AND path = p_path;

            RETURN ${s}._fs_bump_version(p_session_id);
        END
        $$ LANGUAGE plpgsql;

        CREATE OR REPLACE FUNCTION ${s}.fs_append_file(
            p_session_id TEXT,
            p_path       TEXT,
            p_content    TEXT,
            p_mode       INTEGER
        ) RETURNS BIGINT AS $$
        DECLARE
            existing  ${s}.sessionfs_node_type;
            new_ver   BIGINT;
        BEGIN
            PERFORM ${s}.fs_ensure_session(p_session_id);

            SELECT node_type INTO existing FROM ${s}.sessionfs_nodes
                WHERE session_id = p_session_id AND path = p_path;
            IF FOUND AND existing <> 'file' THEN
                RAISE EXCEPTION 'EISDIR: %', p_path;
            END IF;

            PERFORM ${s}._fs_ensure_parents(p_session_id, p_path);

            -- Ensure the file row exists so segments can refer to it logically.
            INSERT INTO ${s}.sessionfs_nodes
                (session_id, path, parent_path, name, node_type, content, mode)
            VALUES
                (p_session_id, p_path, ${s}._fs_parent_of(p_path), ${s}._fs_basename(p_path),
                 'file', '', p_mode)
            ON CONFLICT (session_id, path) DO UPDATE
                SET mode = COALESCE(EXCLUDED.mode, ${s}.sessionfs_nodes.mode);

            new_ver := ${s}._fs_bump_version(p_session_id);

            INSERT INTO ${s}.sessionfs_append_segments
                (session_id, path, content, size_bytes, fs_version)
            VALUES
                (p_session_id, p_path, p_content, octet_length(p_content), new_ver);

            UPDATE ${s}.sessionfs_nodes
                SET pending_segment_bytes = pending_segment_bytes + octet_length(p_content),
                    updated_at = now()
                WHERE session_id = p_session_id AND path = p_path;

            RETURN new_ver;
        END
        $$ LANGUAGE plpgsql;

        CREATE OR REPLACE FUNCTION ${s}.fs_coalesce_segments(
            p_session_id TEXT,
            p_path       TEXT
        ) RETURNS BIGINT AS $$
        DECLARE
            merged TEXT;
        BEGIN
            SELECT string_agg(content, '' ORDER BY segment_no) INTO merged
                FROM ${s}.sessionfs_append_segments
                WHERE session_id = p_session_id AND path = p_path;

            IF merged IS NULL THEN
                RETURN (SELECT version FROM ${s}.sessionfs_sessions WHERE session_id = p_session_id);
            END IF;

            UPDATE ${s}.sessionfs_nodes
                SET content = COALESCE(content, '') || merged,
                    size_bytes = size_bytes + octet_length(merged),
                    pending_segment_bytes = 0,
                    updated_at = now()
                WHERE session_id = p_session_id AND path = p_path;

            DELETE FROM ${s}.sessionfs_append_segments
                WHERE session_id = p_session_id AND path = p_path;

            RETURN ${s}._fs_bump_version(p_session_id);
        END
        $$ LANGUAGE plpgsql;

        CREATE OR REPLACE FUNCTION ${s}.fs_rm(
            p_session_id TEXT,
            p_path       TEXT,
            p_recursive  BOOLEAN,
            p_force      BOOLEAN
        ) RETURNS BIGINT AS $$
        DECLARE
            ntype ${s}.sessionfs_node_type;
            child_count INT;
        BEGIN
            IF p_path = '/' THEN
                RAISE EXCEPTION 'EBUSY: cannot remove root';
            END IF;

            SELECT node_type INTO ntype FROM ${s}.sessionfs_nodes
                WHERE session_id = p_session_id AND path = p_path;
            IF NOT FOUND THEN
                IF p_force THEN
                    RETURN (SELECT version FROM ${s}.sessionfs_sessions WHERE session_id = p_session_id);
                END IF;
                RAISE EXCEPTION 'ENOENT: %', p_path USING ERRCODE = 'P0002';
            END IF;

            IF ntype = 'directory' THEN
                SELECT count(*) INTO child_count FROM ${s}.sessionfs_nodes
                    WHERE session_id = p_session_id AND parent_path = p_path;
                IF child_count > 0 AND NOT p_recursive THEN
                    RAISE EXCEPTION 'ENOTEMPTY: %', p_path;
                END IF;
                DELETE FROM ${s}.sessionfs_append_segments
                    WHERE session_id = p_session_id
                      AND (path = p_path OR path LIKE p_path || '/%');
                DELETE FROM ${s}.sessionfs_nodes
                    WHERE session_id = p_session_id
                      AND (path = p_path OR path LIKE p_path || '/%');
            ELSE
                DELETE FROM ${s}.sessionfs_append_segments
                    WHERE session_id = p_session_id AND path = p_path;
                DELETE FROM ${s}.sessionfs_nodes
                    WHERE session_id = p_session_id AND path = p_path;
            END IF;

            RETURN ${s}._fs_bump_version(p_session_id);
        END
        $$ LANGUAGE plpgsql;

        CREATE OR REPLACE FUNCTION ${s}.fs_rename(
            p_session_id TEXT,
            p_src        TEXT,
            p_dest       TEXT
        ) RETURNS BIGINT AS $$
        DECLARE
            ntype       ${s}.sessionfs_node_type;
            dest_parent TEXT;
        BEGIN
            IF p_src = '/' OR p_dest = '/' THEN
                RAISE EXCEPTION 'EINVAL: cannot rename root';
            END IF;
            IF p_src = p_dest THEN
                RETURN (SELECT version FROM ${s}.sessionfs_sessions WHERE session_id = p_session_id);
            END IF;

            SELECT node_type INTO ntype FROM ${s}.sessionfs_nodes
                WHERE session_id = p_session_id AND path = p_src;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'ENOENT: %', p_src USING ERRCODE = 'P0002';
            END IF;

            -- Destination parent must exist as a directory.
            dest_parent := ${s}._fs_parent_of(p_dest);
            PERFORM 1 FROM ${s}.sessionfs_nodes
                WHERE session_id = p_session_id AND path = dest_parent AND node_type = 'directory';
            IF NOT FOUND THEN
                RAISE EXCEPTION 'ENOENT parent %', dest_parent USING ERRCODE = 'P0002';
            END IF;

            -- Reject if destination already exists.
            PERFORM 1 FROM ${s}.sessionfs_nodes
                WHERE session_id = p_session_id AND path = p_dest;
            IF FOUND THEN
                RAISE EXCEPTION 'EEXIST: %', p_dest;
            END IF;

            IF ntype = 'file' THEN
                UPDATE ${s}.sessionfs_nodes
                    SET path = p_dest,
                        parent_path = dest_parent,
                        name = ${s}._fs_basename(p_dest),
                        updated_at = now()
                    WHERE session_id = p_session_id AND path = p_src;
                UPDATE ${s}.sessionfs_append_segments
                    SET path = p_dest
                    WHERE session_id = p_session_id AND path = p_src;
            ELSE
                -- Move the directory itself.
                UPDATE ${s}.sessionfs_nodes
                    SET path = p_dest,
                        parent_path = dest_parent,
                        name = ${s}._fs_basename(p_dest),
                        updated_at = now()
                    WHERE session_id = p_session_id AND path = p_src;
                -- Rewrite all descendants' paths.
                UPDATE ${s}.sessionfs_nodes
                    SET path = p_dest || substring(path FROM length(p_src) + 1),
                        parent_path = CASE
                            WHEN parent_path = p_src THEN p_dest
                            ELSE p_dest || substring(parent_path FROM length(p_src) + 1)
                        END,
                        updated_at = now()
                    WHERE session_id = p_session_id
                      AND path LIKE p_src || '/%';
                UPDATE ${s}.sessionfs_append_segments
                    SET path = p_dest || substring(path FROM length(p_src) + 1)
                    WHERE session_id = p_session_id
                      AND (path = p_src OR path LIKE p_src || '/%');
            END IF;

            RETURN ${s}._fs_bump_version(p_session_id);
        END
        $$ LANGUAGE plpgsql;
    `;
}

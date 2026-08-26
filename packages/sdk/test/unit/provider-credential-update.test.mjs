/**
 * What an in-place credential update must and must not change.
 *
 * The feature replaces the key on a personal provider and keeps everything
 * else — that is the whole reason it exists, instead of delete-and-recreate.
 * Two things it did not keep:
 *
 *   apiVersion  The update replaced the whole secret_ref blob with what the
 *               caller sent. The caller is a credential form, so it sends one
 *               field, and normalizeCallerSecret only keeps apiVersion if it
 *               is handed one. A personal azure-openai provider pinned to a
 *               non-default version silently moved to the type default the
 *               first time its owner rotated the key — provider-catalog reads
 *               secret_ref.apiVersion and otherwise falls back. Nothing in the
 *               UI, the response or the audit row said so. Create never had
 *               this problem: it carries the whole credentials object.
 *
 *   updated_at  Never set, so a rotation left created_at == updated_at and no
 *               trace of the change on the row.
 *
 * Migration 0066 fixes both. 0065 is left alone: editing an applied migration
 * is a silent no-op for anyone who already ran it.
 *
 * Run: node --test test/unit/provider-credential-update.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../src");
const migrations = readFileSync(join(SRC, "cms-migrations.ts"), "utf8");

function migrationBody(name) {
    const start = migrations.indexOf(`function ${name}(schema: string): string {`);
    assert.notEqual(start, -1, `${name} not found — renamed?`);
    const end = migrations.indexOf("\n}", migrations.indexOf("$$ LANGUAGE", start));
    return migrations.slice(start, end);
}

test("0066 is registered, and 0065 is left as it shipped", () => {
    assert.match(
        migrations,
        /version: "0066",\s*\n\s*name: "personal_credential_update_preserves_api_version",/,
        "the new migration must be registered or it never runs",
    );
    // Editing an already-applied migration is a silent no-op for every
    // deployment that ran it — the fix has to be a NEW version.
    const v65 = migrationBody("migration_0065_personal_provider_credential_update");
    assert.doesNotMatch(v65, /apiVersion/, "0065 must not be edited in place");
    assert.doesNotMatch(v65, /updated_at/, "0065 must not be edited in place");
});

test("0066 carries a pinned apiVersion forward when the caller does not send one", () => {
    const body = migrationBody("migration_0066_personal_credential_update_preserves_api_version");
    assert.match(
        body,
        /WHEN pi\.secret_ref \? 'apiVersion'/,
        "it has to look at what is already stored",
    );
    assert.match(
        body,
        /p_secret \|\| jsonb_build_object\('apiVersion', pi\.secret_ref -> 'apiVersion'\)/,
        "and merge it into the incoming blob",
    );
});

test("a caller who states an apiVersion still wins — that is how you change it", () => {
    const body = migrationBody("migration_0066_personal_credential_update_preserves_api_version");
    const caseStart = body.indexOf("SET secret_ref = CASE");
    const firstBranch = body.slice(caseStart, body.indexOf("WHEN pi.secret_ref", caseStart));
    assert.match(
        firstBranch,
        /WHEN p_secret \? 'apiVersion' THEN p_secret/,
        "the caller's own version must be checked FIRST, or it could never be changed",
    );
});

test("0066 stamps updated_at", () => {
    assert.match(
        migrationBody("migration_0066_personal_credential_update_preserves_api_version"),
        /updated_at = now\(\)/,
    );
});

test("0066 keeps the owner-only boundary and the single not-found answer", () => {
    // The rewrite must not weaken what 0065 got right. Absent, shared and
    // foreign-owned all have to keep landing in one indistinguishable branch,
    // and isAdmin must stay absent so an admin gets the same 404.
    const body = migrationBody("migration_0066_personal_credential_update_preserves_api_version");
    assert.match(body, /AND pi\.class = 'personal'/);
    assert.match(body, /AND pi\.owner_user_id = p_actor/);
    assert.match(body, /IF p_actor IS NULL THEN\s*\n\s*RAISE EXCEPTION 'PROVIDER_FORBIDDEN/);
    assert.match(body, /PROVIDER_NOT_FOUND: there is no provider named "%"/);
    assert.doesNotMatch(body, /p_is_admin|isAdmin/, "an admin must not get a way in");
});

test("the store still normalizes the caller's secret on the update path", () => {
    // The credential-pointer escalation (an `env:`-style ref pointing at the
    // deployment's own secrets) is closed by normalizeCallerSecret. 0066
    // changes the SQL, not this, and it must stay.
    const store = readFileSync(join(SRC, "provider-store.ts"), "utf8");
    const start = store.indexOf("async updatePersonalCredential(");
    assert.notEqual(start, -1, "updatePersonalCredential not found — renamed?");
    // Bounded by the NEXT method, not the first brace: the signature itself
    // contains braces (Record<string, unknown>), which truncated this to
    // nothing and made it pass for the wrong reason.
    const fn = store.slice(start, store.indexOf("\n    async ", start + 10));
    assert.match(fn, /JSON\.stringify\(normalizeCallerSecret\(secretRef\)\)/);
});

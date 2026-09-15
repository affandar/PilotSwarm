// workload-group stage for the OSS Node deploy orchestrator.
//
// Joins the stamp's shared workload managed identity (the `csiIdentity` UAMI
// that worker + portal pods federate against) to a durable Entra ID security
// group that acts as the cross-cluster authorization anchor. You allow-list
// that ONE group to the resources the workload needs (Key Vault, Postgres,
// ACR, plus out-of-band grants like Azure DevOps and Kusto), then every stamp
// you stand up simply adds its UAMI to the group — cluster/subscription churn
// never requires re-allow-listing.
//
// Runs after `bicep` (the UAMI must already exist) and before `seed-secrets`.
// Controlled entirely by env, so it is a no-op for stamps that don't opt in
// (OSS default) and carries no org-specific value in shared files:
//
//   WORKLOAD_MI_GROUP_MODE       skip | join | create   (default: skip)
//   WORKLOAD_MI_GROUP_OBJECT_ID  <group objectId>       (required for join)
//   WORKLOAD_MI_GROUP_NAME       <group displayName>    (required for create)
//
//   • skip   — do nothing. The stamp's UAMI is granted resource RBAC directly
//              by bicep (the classic per-principal model). This is the default.
//   • join   — add the UAMI to an EXISTING group identified by objectId. Needs
//              only Group.ReadWrite on that one group (or group ownership).
//   • create — look the group up by displayName; reuse it if exactly one
//              cloud-native match exists, otherwise create a cloud-native
//              security group and use it. Then add the UAMI. Creating a group
//              needs tenant self-service security-group creation (interactive
//              user deploys) or Group.ReadWrite.All (service-principal / CI
//              deploys). Idempotent: re-runs reuse the same group.
//
// The identity's principalId comes from the base-infra bicep output
// `csiIdentityPrincipalId`, aliased to WORKLOAD_IDENTITY_PRINCIPAL_ID by the
// FR-022 OUTPUT_ALIAS map in ./deploy-bicep.mjs (loaded into the env map from
// the bicep-outputs cache at orchestrator startup).

import { log, run, runJson } from "./common.mjs";

// Derive a valid mailNickname from a group display name: lowercase, collapse
// non-alphanumerics to single hyphens, trim leading/trailing hyphens, cap at
// 60 chars (Entra mailNickname constraint).
function mailNicknameFor(displayName) {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Resolve WORKLOAD_MI_GROUP_NAME to a group objectId, reusing an existing
// cloud-native group if one matches by displayName, else creating one. Throws
// on ambiguous (>1) matches and on on-prem-synced matches (which cannot hold
// managed identities).
function ensureGroupByName(displayName) {
  const matches = runJson("az", [
    "ad", "group", "list",
    "--filter", `displayName eq '${displayName.replace(/'/g, "''")}'`,
    "--query", "[].{id:id,onPremisesSyncEnabled:onPremisesSyncEnabled}",
    "-o", "json",
  ]);

  if (Array.isArray(matches) && matches.length > 1) {
    throw new Error(
      `workload-group: ${matches.length} Entra groups are named '${displayName}'. ` +
      "displayName is not unique in Entra, so create-by-name is ambiguous. " +
      "Switch to WORKLOAD_MI_GROUP_MODE=join and set WORKLOAD_MI_GROUP_OBJECT_ID " +
      "to the exact group you want.",
    );
  }

  if (Array.isArray(matches) && matches.length === 1) {
    const g = matches[0];
    if (g.onPremisesSyncEnabled) {
      throw new Error(
        `workload-group: existing group '${displayName}' (${g.id}) is on-prem synced ` +
        "(onPremisesSyncEnabled=true). On-prem/domain-backed groups are membership-" +
        "read-only in Entra and cannot hold cloud managed identities. Create a " +
        "cloud-native security group (az ad group create) and use its objectId with " +
        "WORKLOAD_MI_GROUP_MODE=join instead.",
      );
    }
    log("ok", `workload-group: reusing existing cloud-native group '${displayName}' (${g.id}).`);
    return g.id;
  }

  // No match — create a cloud-native security group.
  const nickname = mailNicknameFor(displayName);
  log("info", `workload-group: creating cloud-native security group '${displayName}' (mailNickname=${nickname})...`);
  let created;
  try {
    created = runJson("az", [
      "ad", "group", "create",
      "--display-name", displayName,
      "--mail-nickname", nickname,
      "--query", "{id:id}",
      "-o", "json",
    ]);
  } catch (e) {
    throw new Error(
      `workload-group: failed to create Entra group '${displayName}'.\n` +
      `Underlying error: ${e.message.split("\n").slice(0, 3).join("\n")}\n` +
      "Creating a security group requires tenant self-service security-group " +
      "creation (interactive user deploys) or the Group.ReadWrite.All application " +
      "permission (service-principal / CI deploys). Either grant that, or create " +
      "the group once out of band and switch to WORKLOAD_MI_GROUP_MODE=join with " +
      "WORKLOAD_MI_GROUP_OBJECT_ID set. See deploy/scripts/README.md → " +
      "'Workload identity authorization group'.",
    );
  }
  log("ok", `workload-group: created cloud-native group '${displayName}' (${created.id}).`);
  return created.id;
}

/**
 * Join the stamp's workload UAMI to the shared Entra authorization group.
 *
 * @param {{ envName: string, env: Record<string,string> }} ctx
 */
export async function ensureWorkloadGroupMembership({ envName, env }) {
  const mode = (env.WORKLOAD_MI_GROUP_MODE || "skip").trim().toLowerCase();

  if (mode === "" || mode === "skip") {
    log("info", "workload-group: WORKLOAD_MI_GROUP_MODE=skip — not joining any Entra group (per-principal RBAC via bicep).");
    return;
  }
  if (mode !== "join" && mode !== "create") {
    throw new Error(
      `workload-group: unknown WORKLOAD_MI_GROUP_MODE='${mode}' for env '${envName}' ` +
      "(expected 'skip', 'join', or 'create').",
    );
  }

  const principalId = (env.WORKLOAD_IDENTITY_PRINCIPAL_ID || "").trim();
  if (!principalId) {
    throw new Error(
      "workload-group: WORKLOAD_IDENTITY_PRINCIPAL_ID is not set in the env map. " +
      "It comes from the base-infra bicep output `csiIdentityPrincipalId`. " +
      `Run \`npm run deploy -- base-infra ${envName} --steps bicep\` first to populate ` +
      "the BaseInfra outputs cache.",
    );
  }

  let groupId;
  if (mode === "join") {
    groupId = (env.WORKLOAD_MI_GROUP_OBJECT_ID || "").trim();
    if (!groupId) {
      throw new Error(
        "workload-group: WORKLOAD_MI_GROUP_MODE=join requires WORKLOAD_MI_GROUP_OBJECT_ID " +
        "(the objectId of the existing Entra authorization group). Set it in " +
        `deploy/envs/local/${envName}/.env, or switch to mode=create with ` +
        "WORKLOAD_MI_GROUP_NAME.",
      );
    }
  } else {
    // create
    const name = (env.WORKLOAD_MI_GROUP_NAME || "").trim();
    if (!name) {
      throw new Error(
        "workload-group: WORKLOAD_MI_GROUP_MODE=create requires WORKLOAD_MI_GROUP_NAME " +
        `(the displayName for the Entra authorization group). Set it in ` +
        `deploy/envs/local/${envName}/.env.`,
      );
    }
    groupId = ensureGroupByName(name);
  }

  // Idempotent add: check first so re-runs don't error on "already a member".
  const already = runJson("az", [
    "ad", "group", "member", "check",
    "--group", groupId,
    "--member-id", principalId,
    "--query", "value",
    "-o", "json",
  ]);
  if (already === true) {
    log("ok", `workload-group: UAMI ${principalId} is already a member of group ${groupId}.`);
    return;
  }

  log("info", `workload-group: az ad group member add --group ${groupId} --member-id ${principalId}`);
  try {
    run("az", [
      "ad", "group", "member", "add",
      "--group", groupId,
      "--member-id", principalId,
      "--output", "none",
    ]);
  } catch (e) {
    throw new Error(
      `workload-group: failed to add UAMI ${principalId} to group ${groupId}.\n` +
      `Underlying error: ${e.message.split("\n").slice(0, 3).join("\n")}\n` +
      "Adding a member requires Group.ReadWrite on the target group (e.g. group " +
      "ownership, or the Group.ReadWrite.All application permission for a " +
      "service-principal / CI deploy). Grant the deploy identity write access to " +
      "the group and re-run `--steps workload-group`.",
    );
  }
  log("ok", `workload-group: added UAMI ${principalId} to group ${groupId}.`);
}

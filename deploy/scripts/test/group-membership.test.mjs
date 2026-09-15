// Tests for the `workload-group` deploy step (lib/group-membership.mjs):
// join/create/skip modes, idempotent membership add, reuse-by-name, and the
// safety refusals (ambiguous name, on-prem-synced group). Mocks `run`/`runJson`
// from common.mjs via node:test mock.module, mirroring publish-manifests.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";

// Install a mock common.mjs. `listResponse` drives `az ad group list`,
// `checkResponse` drives `az ad group member check`, `createdId` drives
// `az ad group create`. Records every call for assertions. `failOn` injects a
// throw for a subcommand shape (e.g. "member add", "group create").
function installMock(t, { listResponse = [], checkResponse = false, createdId = "created-000", failOn = null } = {}) {
  const calls = [];
  const shapeOf = (args) => {
    if (args[0] === "ad" && args[1] === "group") {
      if (args[2] === "member") return `member ${args[3]}`;
      return `group ${args[2]}`;
    }
    return args.slice(0, 2).join(" ");
  };
  t.mock.module("../lib/common.mjs", {
    namedExports: {
      log: () => {},
      run: (cmd, args) => {
        const shape = shapeOf(args);
        calls.push({ fn: "run", cmd, shape, args: [...args] });
        if (failOn === shape) throw new Error(`mock failure: ${shape}`);
        return { stdout: "", stderr: "", status: 0 };
      },
      runJson: (cmd, args) => {
        const shape = shapeOf(args);
        calls.push({ fn: "runJson", cmd, shape, args: [...args] });
        if (failOn === shape) throw new Error(`mock failure: ${shape}`);
        if (shape === "group list") return listResponse;
        if (shape === "group create") return { id: createdId };
        if (shape === "member check") return checkResponse;
        return null;
      },
      REPO_ROOT: process.cwd(),
    },
  });
  return calls;
}

async function load() {
  return import("../lib/group-membership.mjs?t=" + Date.now() + Math.random());
}

const PRINCIPAL = "fdf3955f-2920-46e1-9365-c9104e54ac91";
const GROUP_ID = "8fa6f120-2789-41d8-b614-326c5ec6fdd1";

test("skip mode makes no az calls", async (t) => {
  const calls = installMock(t);
  const { ensureWorkloadGroupMembership } = await load();
  await ensureWorkloadGroupMembership({ envName: "demo", env: { WORKLOAD_MI_GROUP_MODE: "skip" } });
  assert.equal(calls.length, 0);
});

test("empty mode defaults to skip", async (t) => {
  const calls = installMock(t);
  const { ensureWorkloadGroupMembership } = await load();
  await ensureWorkloadGroupMembership({ envName: "demo", env: {} });
  assert.equal(calls.length, 0);
});

test("unknown mode throws before any az call", async (t) => {
  const calls = installMock(t);
  const { ensureWorkloadGroupMembership } = await load();
  await assert.rejects(
    () => ensureWorkloadGroupMembership({ envName: "demo", env: { WORKLOAD_MI_GROUP_MODE: "bogus" } }),
    /unknown WORKLOAD_MI_GROUP_MODE='bogus'/,
  );
  assert.equal(calls.length, 0);
});

test("join without principalId throws", async (t) => {
  installMock(t);
  const { ensureWorkloadGroupMembership } = await load();
  await assert.rejects(
    () => ensureWorkloadGroupMembership({ envName: "demo", env: { WORKLOAD_MI_GROUP_MODE: "join", WORKLOAD_MI_GROUP_OBJECT_ID: GROUP_ID } }),
    /WORKLOAD_IDENTITY_PRINCIPAL_ID is not set/,
  );
});

test("join without objectId throws", async (t) => {
  installMock(t);
  const { ensureWorkloadGroupMembership } = await load();
  await assert.rejects(
    () => ensureWorkloadGroupMembership({ envName: "demo", env: { WORKLOAD_MI_GROUP_MODE: "join", WORKLOAD_IDENTITY_PRINCIPAL_ID: PRINCIPAL } }),
    /requires WORKLOAD_MI_GROUP_OBJECT_ID/,
  );
});

test("join adds member when not already present", async (t) => {
  const calls = installMock(t, { checkResponse: false });
  const { ensureWorkloadGroupMembership } = await load();
  await ensureWorkloadGroupMembership({
    envName: "demo",
    env: { WORKLOAD_MI_GROUP_MODE: "join", WORKLOAD_MI_GROUP_OBJECT_ID: GROUP_ID, WORKLOAD_IDENTITY_PRINCIPAL_ID: PRINCIPAL },
  });
  assert.deepEqual(calls.map((c) => c.shape), ["member check", "member add"]);
  const add = calls.find((c) => c.shape === "member add");
  assert.ok(add.args.includes(GROUP_ID) && add.args.includes(PRINCIPAL));
});

test("join is idempotent — no add when already a member", async (t) => {
  const calls = installMock(t, { checkResponse: true });
  const { ensureWorkloadGroupMembership } = await load();
  await ensureWorkloadGroupMembership({
    envName: "demo",
    env: { WORKLOAD_MI_GROUP_MODE: "join", WORKLOAD_MI_GROUP_OBJECT_ID: GROUP_ID, WORKLOAD_IDENTITY_PRINCIPAL_ID: PRINCIPAL },
  });
  assert.deepEqual(calls.map((c) => c.shape), ["member check"]);
  assert.ok(!calls.some((c) => c.shape === "member add"));
});

test("create reuses an existing single cloud-native match (no create)", async (t) => {
  const calls = installMock(t, {
    listResponse: [{ id: GROUP_ID, onPremisesSyncEnabled: null }],
    checkResponse: false,
  });
  const { ensureWorkloadGroupMembership } = await load();
  await ensureWorkloadGroupMembership({
    envName: "demo",
    env: { WORKLOAD_MI_GROUP_MODE: "create", WORKLOAD_MI_GROUP_NAME: "SG-Demo", WORKLOAD_IDENTITY_PRINCIPAL_ID: PRINCIPAL },
  });
  assert.deepEqual(calls.map((c) => c.shape), ["group list", "member check", "member add"]);
  assert.ok(!calls.some((c) => c.shape === "group create"));
  const add = calls.find((c) => c.shape === "member add");
  assert.ok(add.args.includes(GROUP_ID));
});

test("create makes a new cloud-native group when none match", async (t) => {
  const calls = installMock(t, { listResponse: [], createdId: "new-group-999", checkResponse: false });
  const { ensureWorkloadGroupMembership } = await load();
  await ensureWorkloadGroupMembership({
    envName: "demo",
    env: { WORKLOAD_MI_GROUP_MODE: "create", WORKLOAD_MI_GROUP_NAME: "SG-Demo Cluster", WORKLOAD_IDENTITY_PRINCIPAL_ID: PRINCIPAL },
  });
  assert.deepEqual(calls.map((c) => c.shape), ["group list", "group create", "member check", "member add"]);
  const create = calls.find((c) => c.shape === "group create");
  // mailNickname is derived: lowercased, non-alnum collapsed to hyphens.
  const nickIdx = create.args.indexOf("--mail-nickname");
  assert.equal(create.args[nickIdx + 1], "sg-demo-cluster");
  const add = calls.find((c) => c.shape === "member add");
  assert.ok(add.args.includes("new-group-999"));
});

test("create refuses an on-prem-synced match", async (t) => {
  installMock(t, { listResponse: [{ id: GROUP_ID, onPremisesSyncEnabled: true }] });
  const { ensureWorkloadGroupMembership } = await load();
  await assert.rejects(
    () => ensureWorkloadGroupMembership({
      envName: "demo",
      env: { WORKLOAD_MI_GROUP_MODE: "create", WORKLOAD_MI_GROUP_NAME: "SG-Demo", WORKLOAD_IDENTITY_PRINCIPAL_ID: PRINCIPAL },
    }),
    /on-prem synced/,
  );
});

test("create refuses an ambiguous (>1) name match", async (t) => {
  installMock(t, {
    listResponse: [
      { id: "id-1", onPremisesSyncEnabled: null },
      { id: "id-2", onPremisesSyncEnabled: null },
    ],
  });
  const { ensureWorkloadGroupMembership } = await load();
  await assert.rejects(
    () => ensureWorkloadGroupMembership({
      envName: "demo",
      env: { WORKLOAD_MI_GROUP_MODE: "create", WORKLOAD_MI_GROUP_NAME: "SG-Demo", WORKLOAD_IDENTITY_PRINCIPAL_ID: PRINCIPAL },
    }),
    /displayName is not unique/,
  );
});

test("create without name throws", async (t) => {
  installMock(t);
  const { ensureWorkloadGroupMembership } = await load();
  await assert.rejects(
    () => ensureWorkloadGroupMembership({
      envName: "demo",
      env: { WORKLOAD_MI_GROUP_MODE: "create", WORKLOAD_IDENTITY_PRINCIPAL_ID: PRINCIPAL },
    }),
    /requires WORKLOAD_MI_GROUP_NAME/,
  );
});

test("member add failure surfaces an actionable permission hint", async (t) => {
  installMock(t, { checkResponse: false, failOn: "member add" });
  const { ensureWorkloadGroupMembership } = await load();
  await assert.rejects(
    () => ensureWorkloadGroupMembership({
      envName: "demo",
      env: { WORKLOAD_MI_GROUP_MODE: "join", WORKLOAD_MI_GROUP_OBJECT_ID: GROUP_ID, WORKLOAD_IDENTITY_PRINCIPAL_ID: PRINCIPAL },
    }),
    /Group\.ReadWrite/,
  );
});

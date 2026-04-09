import { describe, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertIncludes } from "../helpers/assertions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

function readRepoFile(relPath) {
    return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

describe("portal log tail contracts", () => {
    it("supports in-cluster Kubernetes log streaming without kubectl", () => {
        const transport = readRepoFile("packages/cli/src/node-sdk-transport.js");

        assertIncludes(transport, 'const K8S_SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";', "transport should know the in-cluster service-account path");
        assertIncludes(transport, "process.env.KUBERNETES_SERVICE_HOST", "transport should detect in-cluster Kubernetes access");
        assertIncludes(transport, "https.request({", "transport should use the Kubernetes HTTPS API for in-cluster log tailing");
        assertIncludes(transport, '/pods/${encodeURIComponent(podName)}/log?', "transport should stream pod logs from the Kubernetes API");
        assertIncludes(transport, 'Accept: "*/*"', "in-cluster pod log streaming should negotiate with the Kubernetes API without forcing text/plain");
        assertIncludes(transport, "if (hasInClusterK8sAccess()) {", "transport should prefer in-cluster log streaming when available");
        assertIncludes(transport, 'Log tailing disabled: kubectl is not installed in this environment.', "transport should explain missing kubectl outside the cluster");
        assertIncludes(transport, "const sessionIdMatch = rawLine.match(/\\b(?:sessionId|session|durableSessionId)=([0-9a-f-]{8,})\\b/i);", "transport should parse explicit durable session ids from worker log lines");
        assertIncludes(transport, "const orchId = parsedOrchId || (sessionId ? `session-${sessionId}` : null);", "transport should map explicit session ids back to orchestration ids for current-session log filtering");
    });

    it("deploys the portal with the RBAC needed to read worker pod logs", () => {
        const manifest = readRepoFile("deploy/k8s/portal-deployment.yaml");

        assertIncludes(manifest, "kind: ServiceAccount", "portal manifest should define a dedicated service account");
        assertIncludes(manifest, "name: pilotswarm-portal", "portal manifest should name the dedicated service account");
        assertIncludes(manifest, "kind: Role", "portal manifest should define a namespace role");
        assertIncludes(manifest, "- pods/log", "portal role should allow pod log reads");
        assertIncludes(manifest, "kind: RoleBinding", "portal manifest should bind the log reader role");
        assertIncludes(manifest, "serviceAccountName: pilotswarm-portal", "portal deployment should use the dedicated service account");
        assertIncludes(manifest, 'value: "remote"', "portal deployment should run in remote mode on AKS");
    });

    it("defaults the portal to remote mode when running in-cluster", () => {
        const server = readRepoFile("packages/portal/server.js");

        assertIncludes(server, "process.env.KUBERNETES_SERVICE_HOST ? \"remote\" : \"local\"", "portal should default to remote mode when running inside Kubernetes");
    });

    it("renders a short session id badge in the inspector log pane", () => {
        const selectors = readRepoFile("packages/ui-core/src/selectors.js");

        assertIncludes(selectors, "entry?.sessionId", "log pane should read parsed session ids from log entries");
        assertIncludes(selectors, "shortSessionId(sessionId)", "log pane should show a short session id badge for matching logs");
    });
});

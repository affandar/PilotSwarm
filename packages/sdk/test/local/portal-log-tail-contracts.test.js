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
        assertIncludes(transport, "if (hasInClusterK8sAccess()) {", "transport should prefer in-cluster log streaming when available");
        assertIncludes(transport, 'Log tailing disabled: kubectl is not installed in this environment.', "transport should explain missing kubectl outside the cluster");
    });

    it("deploys the portal with the RBAC needed to read worker pod logs", () => {
        const manifest = readRepoFile("deploy/k8s/portal-deployment.yaml");

        assertIncludes(manifest, "kind: ServiceAccount", "portal manifest should define a dedicated service account");
        assertIncludes(manifest, "name: pilotswarm-portal", "portal manifest should name the dedicated service account");
        assertIncludes(manifest, "kind: Role", "portal manifest should define a namespace role");
        assertIncludes(manifest, "- pods/log", "portal role should allow pod log reads");
        assertIncludes(manifest, "kind: RoleBinding", "portal manifest should bind the log reader role");
        assertIncludes(manifest, "serviceAccountName: pilotswarm-portal", "portal deployment should use the dedicated service account");
    });
});

# Bug: Logs tab hard-codes worker pod selector instead of letting apps configure it

**Status:** Open
**Filed:** 2026-04-20
**Component:** `@pilotswarm/cli` remote log tailing / Kubernetes worker discovery
**Affected versions:** current `packages/cli` behavior in PilotSwarm as vendored by a downstream app on 2026-04-20
**Severity:** Medium — remote Logs tab can fail completely for apps whose worker pods do not use PilotSwarm's default AKS labels

## Summary

PilotSwarm's remote Logs tab assumes worker pods are labeled with:

```text
app.kubernetes.io/component=worker
```

when neither a `--label` flag nor `K8S_POD_LABEL` environment variable is set.

That default is valid for PilotSwarm's own shipped AKS manifests, but it is currently **hard-coded in the CLI transport layer** and cannot be overridden from app/plugin metadata.

As a result, a plugin-driven app that deploys worker pods with a different label convention can have a fully healthy remote cluster while the Logs tab shows:

```text
No pods matched label selector "app.kubernetes.io/component=worker" in namespace <ns>.
```

This is a framework integration bug, not a cluster bug.

## Observed Failure

In a downstream app's remote mode, the Logs tab showed:

```text
No pods matched label selector "app.kubernetes.io/component=worker" in namespace <app-namespace>.
```

But the live cluster had four healthy worker pods under:

```bash
kubectl --context <cluster-context> -n <app-namespace> get pods -l component=worker
```

Actual worker labels in the downstream app:

- `app=<downstream-app>`
- `component=worker`

So the Logs tab failure was caused by the selector default, not missing pods or broken logging.

## Current Code Path

The hard-coded fallback exists in two places in `packages/cli`:

### 1. CLI bootstrap default

[`packages/cli/src/bootstrap-env.js`](../../packages/cli/src/bootstrap-env.js):

```js
process.env.K8S_POD_LABEL = flags.label || process.env.K8S_POD_LABEL || "app.kubernetes.io/component=worker";
```

### 2. Runtime log transport fallback

[`packages/cli/src/node-sdk-transport.js`](../../packages/cli/src/node-sdk-transport.js):

```js
const labelSelector = process.env.K8S_POD_LABEL || "app.kubernetes.io/component=worker";
```

and:

```js
const k8sPodLabel = process.env.K8S_POD_LABEL || "app.kubernetes.io/component=worker";
```

Those are correct as a **framework fallback**, but not as the only remotely configurable option.

## Why this is a bug

PilotSwarm is explicitly positioned as a plugin/app framework. Apps already control:

- plugin metadata (`plugin.json`)
- session policy
- worker entrypoint
- manifests / namespaces / topology
- remote launcher env files

But the remote Logs tab still assumes the framework's own Kubernetes label convention unless the user manually passes `--label` or sets `K8S_POD_LABEL` in the shell.

That means:

1. **The app cannot declare its own worker discovery contract.**
2. **A healthy remote deployment can look broken in the TUI.**
3. **The failure is surprising** because the same app may work correctly for sessions, node map, history, and CMS-backed views while only live logs fail.
4. **The only current fix is out-of-band shell/env knowledge**, not app-owned configuration.

## What should happen instead

PilotSwarm should keep the framework fallback label selector, but it should also let apps configure the worker pod selector through app metadata or app config.

## Proposed fix

### Add an app-owned worker log selector config

Introduce a configuration field that the CLI/bootstrap layer can read before falling back to the framework default.

Possible homes:

1. `plugin.json`
2. `infra.json`
3. a small dedicated app runtime config file already read by the CLI

Example shape:

```json
{
  "kubernetes": {
    "workerPodLabelSelector": "component=worker"
  }
}
```

or, if `infra.json` is preferred:

```json
{
  "clusters": {
    "t2": {
      "name": "my-control-cluster",
      "namespace": "my-app"
    }
  },
  "kubernetes": {
    "workerPodLabelSelector": "component=worker"
  }
}
```

### Resolution order

Recommended priority order for the CLI:

1. explicit `--label`
2. explicit `K8S_POD_LABEL`
3. app/plugin-configured worker selector
4. framework fallback `app.kubernetes.io/component=worker`

This keeps current behavior intact for PilotSwarm's own examples while letting downstream apps opt into different label schemes without patching vendored CLI code.

### UX improvement

When no pods match, the warning should mention that the selector is configurable, for example:

```text
No pods matched label selector "..." in namespace "...".
Set --label / K8S_POD_LABEL or configure the app's worker pod selector.
```

## Downstream-app workaround used locally

As a local vendored workaround, one downstream app patched its vendored `pilotswarm-cli-local` fallback to default to:

```text
component=worker
```

That unblocks the downstream app locally, but it is **not** the right upstream fix because PilotSwarm's own AKS manifests and docs consistently use `app.kubernetes.io/component=worker`.

The upstream answer is configurability, not changing the framework default to match one downstream app.

## Verification

After the upstream fix:

1. An app using PilotSwarm's standard labels should work unchanged.
2. An app that declares `workerPodLabelSelector: "component=worker"` should have a functioning Logs tab with no shell-level `K8S_POD_LABEL` override.
3. The fallback warning should be clearer when selector mismatch occurs.

## Related

- PilotSwarm shipped manifests: [`deploy/k8s/worker-deployment.yaml`](../../deploy/k8s/worker-deployment.yaml)
- Current CLI fallback sites:
  - [`packages/cli/src/bootstrap-env.js`](../../packages/cli/src/bootstrap-env.js)
  - [`packages/cli/src/node-sdk-transport.js`](../../packages/cli/src/node-sdk-transport.js)

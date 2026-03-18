# Deploying to Azure Kubernetes Service (AKS)

This guide walks through deploying PilotSwarm workers to AKS for production multi-node operation.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Your App (Client)                                                   │
│  PilotSwarmClient({ store: DATABASE_URL })                       │
│  → createSession, sendAndWait, on()                                  │
└────────────────────┬─────────────────────────────────────────────────┘
                     │ PostgreSQL
                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│  PostgreSQL (Azure Database for PostgreSQL)                           │
│  ┌─────────────────┐  ┌──────────────────┐                           │
│  │ duroxide schema  │  │ copilot_sessions │                           │
│  │ (orchestrations) │  │ (session catalog)│                           │
│  └─────────────────┘  └──────────────────┘                           │
└────────────────────┬─────────────────────────────────────────────────┘
                     │ PostgreSQL
                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│  AKS Worker Pods (N replicas)                                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                │
│  │ worker-1 │ │ worker-2 │ │ worker-3 │ │ worker-N │                │
│  │ polls PG │ │ polls PG │ │ polls PG │ │ polls PG │                │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘                │
│                                                                      │
│  Each pod: node examples/worker.js                                   │
│  → Picks up orchestrations from the queue                            │
│  → Runs LLM turns via Copilot SDK                                   │
│  → Dehydrates/hydrates sessions via Azure Blob Storage               │
└──────────────────────────────────────────────────────────────────────┘
```

## Prerequisites

- Azure CLI (`az`) installed and logged in
- `kubectl` configured for your AKS cluster
- An Azure Container Registry (ACR) for Docker images
- An Azure Database for PostgreSQL (Flexible Server)
- An Azure Storage Account (for session blob storage)

## WARNING: Runaway Deployments

**Before deploying**, always check for old worker pods in other namespaces that may still be connected to the same database:

```bash
kubectl get pods --all-namespaces -l app.kubernetes.io/component=worker --no-headers
```

Old workers from a previous namespace (e.g. `copilot-sdk` vs `copilot-runtime`) will process orchestrations with **stale orchestration code**, causing nondeterminism errors. Delete any old deployments before deploying:

```bash
kubectl delete deployment copilot-runtime-worker -n <old-namespace>
```

## Step 1: Create Kubernetes Resources

### Namespace

```bash
kubectl apply -f deploy/k8s/namespace.yaml
```

This creates the `copilot-runtime` namespace.

### Secrets

Store your credentials as a Kubernetes secret:

```bash
kubectl create secret generic copilot-runtime-secrets \
    -n copilot-runtime \
    --from-literal=DATABASE_URL="postgresql://user:pass@myserver.postgres.database.azure.com:5432/postgres?options=-csearch_path%3Dcopilot_runtime&sslmode=require" \
    --from-literal=GITHUB_TOKEN="ghp_xxxxxxxxxxxx" \
    --from-literal=AZURE_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=..." \
    --from-literal=AZURE_STORAGE_CONTAINER="copilot-sessions"
```

### Refresh GitHub Token

The GitHub token expires periodically. To update:

```bash
kubectl create secret generic copilot-runtime-secrets \
    -n copilot-runtime \
    --from-literal=DATABASE_URL="..." \
    --from-literal=GITHUB_TOKEN="$(gh auth token)" \
    --from-literal=AZURE_STORAGE_CONNECTION_STRING="..." \
    --from-literal=AZURE_STORAGE_CONTAINER="copilot-sessions" \
    --dry-run=client -o yaml | kubectl apply -f -
```

## Step 2: Build and Push Docker Image

### Login to ACR

```bash
az acr login --name <your-acr-name>
```

### Build and Push

```bash
# Build TypeScript first
npm run build

# Build and push Docker image
docker buildx build \
    --platform linux/amd64 \
    -f deploy/Dockerfile.worker \
    -t <your-acr-name>.azurecr.io/copilot-runtime-worker:latest \
    --push .
```

The Dockerfile (`deploy/Dockerfile.worker`) builds a minimal image:
- `node:24-slim` base
- Production dependencies only (`npm install --omit=dev`)
- Copies `dist/` and `examples/worker.js`
- Runs as non-root `node` user

## Step 3: Deploy Workers

### Edit the Deployment

Update `deploy/k8s/worker-deployment.yaml` with your ACR URL:

```yaml
containers:
  - name: worker
    image: <your-acr-name>.azurecr.io/copilot-runtime-worker:latest
```

### Apply

```bash
kubectl apply -f deploy/k8s/worker-deployment.yaml
```

### Verify

```bash
kubectl get pods -n copilot-runtime -l app.kubernetes.io/component=worker
```

Expected output:

```
NAME                                  READY   STATUS    RESTARTS   AGE
copilot-runtime-worker-xxxxx-aaaaa        1/1     Running   0          30s
copilot-runtime-worker-xxxxx-bbbbb        1/1     Running   0          30s
copilot-runtime-worker-xxxxx-ccccc        1/1     Running   0          30s
copilot-runtime-worker-xxxxx-ddddd        1/1     Running   0          30s
```

### Check Logs

```bash
kubectl logs -n copilot-runtime -l app.kubernetes.io/component=worker --prefix --tail=20
```

You should see:

```
[pod/copilot-runtime-worker-xxxxx/worker] [worker] Pod: copilot-runtime-worker-xxxxx
[pod/copilot-runtime-worker-xxxxx/worker] [worker] Started ✓ Polling for orchestrations...
```

## Step 4: Connect Your Client

From your application (anywhere with network access to the same PostgreSQL):

```typescript
import { PilotSwarmClient } from "pilotswarm-sdk";

const client = new PilotSwarmClient({
    store: process.env.DATABASE_URL,
    blobEnabled: true,
});
await client.start();

// Sessions are processed by AKS worker pods
const session = await client.createSession();
await session.send("Monitor this service every 5 minutes for the next 24 hours");

console.log(`Session ${session.sessionId} is running on AKS`);
```

Or use the TUI in remote mode:

```bash
npm run tui:remote
```

## Scaling

### Horizontal Scaling

Adjust the replica count:

```bash
kubectl scale deployment copilot-runtime-worker -n copilot-runtime --replicas=8
```

Workers are stateless — each polls the PostgreSQL queue for available work. duroxide ensures exactly-once execution.

### Resource Tuning

The default resource requests/limits in the deployment:

```yaml
resources:
    requests:
        cpu: "250m"
        memory: "512Mi"
    limits:
        cpu: "1000m"
        memory: "1Gi"
```

Each worker runs one LLM turn at a time. Increase CPU limits if tool execution is compute-heavy.

### Spot Instances

The deployment includes a toleration for Azure spot instances:

```yaml
tolerations:
    - key: "kubernetes.azure.com/scalesetpriority"
      operator: "Equal"
      value: "spot"
      effect: "NoSchedule"
```

Spot instances are safe because sessions are durable — if a spot node is evicted, the orchestration retries automatically on another node.

## Updating Workers

### Rolling Update

```bash
# Rebuild and push
npm run build
docker buildx build --platform linux/amd64 -f deploy/Dockerfile.worker \
    -t <your-acr-name>.azurecr.io/copilot-runtime-worker:latest --push .

# Restart pods (pulls latest image)
kubectl rollout restart deployment/copilot-runtime-worker -n copilot-runtime

# Wait for rollout to complete
kubectl rollout status deployment/copilot-runtime-worker -n copilot-runtime
```

In-flight orchestrations are safe during rollouts. If a worker is killed mid-turn, duroxide will retry the activity on another worker after the lock timeout.

### Database Reset

To wipe all orchestration and session state:

```bash
node --env-file=.env.remote scripts/db-reset.js --yes
```

This drops both the `duroxide` and `copilot_sessions` schemas. Use with caution — all in-flight sessions will be lost.

## Troubleshooting

### Workers Not Picking Up Work

```bash
# Check pods are running
kubectl get pods -n copilot-runtime -l app.kubernetes.io/component=worker

# Check logs for errors
kubectl logs -n copilot-runtime -l app.kubernetes.io/component=worker --tail=50

# Verify database connectivity
kubectl exec -n copilot-runtime deploy/copilot-runtime-worker -- \
    node -e "console.log('DB OK')" --env-file=/dev/null
```

### Session Stuck in "running"

A session may be stuck if the activity timed out. Check the orchestration status:

```bash
# From your machine
node --env-file=.env.remote -e "
    import { PilotSwarmClient } from './dist/index.js';
    const c = new PilotSwarmClient({ store: process.env.DATABASE_URL });
    await c.start();
    const s = await c.resumeSession('SESSION_ID');
    console.log(await s.getInfo());
    await c.stop();
"
```

### GitHub Token Expired

If workers log authentication errors, refresh the secret:

```bash
kubectl create secret generic copilot-runtime-secrets -n copilot-runtime \
    --from-literal=GITHUB_TOKEN="$(gh auth token)" \
    --dry-run=client -o yaml | kubectl apply -f -

# Restart workers to pick up new secret
kubectl rollout restart deployment/copilot-runtime-worker -n copilot-runtime
```

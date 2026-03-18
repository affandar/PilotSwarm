---
name: deployment-safety
description: Deployment best practices — canary patterns, rollback triggers, and health check interpretation.
---

# Deployment Safety

## Pre-Flight Checks

Before any deployment, verify:

1. **Service health**: All health checks passing (status = "healthy")
2. **Error rate baseline**: Current error rate < 2% (deploying into an already-degraded service is risky)
3. **CPU headroom**: CPU < 70% (deployment causes brief CPU spikes)
4. **No active incidents**: Check if the service is currently under investigation
5. **Recent deploys**: No other deployment to the same service in the last 10 minutes

## Rollback Triggers

Automatically recommend rollback if ANY of these occur post-deploy:

| Metric | Threshold | Window |
|--------|-----------|--------|
| Error rate increase | > 2% above baseline | 2 minutes |
| Health check failure | Any check fails | Immediate |
| CPU spike | > 95% sustained | 1 minute |
| Response time increase | > 50% above baseline | 2 minutes |

## Deployment Monitoring Pattern

```
Deploy → Wait 30s → Check metrics → Wait 30s → Check metrics → Verdict
```

- Minimum 2 check cycles before declaring success
- If first check shows degradation, wait for second check to confirm
- If both checks show degradation, recommend rollback

## Rollback Procedure

1. Call `rollback_service` with the deployment ID
2. Wait 30 seconds for rollback to complete
3. Verify health checks are passing again
4. Report final status to the user

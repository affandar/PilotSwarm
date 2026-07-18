---
name: deploy-runbook
description: Steps for a safe production rollout — build, canary, verify, roll back.
---

# Deploy Runbook

A capability-profiles demo skill. When loaded, follow this order for a rollout:

1. Build and push the image.
2. Roll out to a canary and watch health for 5 minutes.
3. Verify the public surface changed (asset hash / health endpoint).
4. Roll forward or roll back based on the canary signal.

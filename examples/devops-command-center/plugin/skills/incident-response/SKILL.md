---
name: incident-response
description: Domain knowledge for investigating production incidents — triage steps, correlation patterns, and escalation criteria.
---

# Incident Response

## Triage Checklist

When investigating an incident, follow this order:

1. **Identify the blast radius** — which services are affected?
2. **Check health endpoints** — are services responding?
3. **Review error rates** — sudden spikes indicate the incident start time
4. **Check CPU/memory** — resource exhaustion is a common root cause
5. **Search logs** — look for exceptions, timeouts, connection errors

## Common Root Causes

| Symptom | Likely Cause | Investigation Steps |
|---------|-------------|-------------------|
| High error rate + normal CPU | Upstream dependency failure | Check downstream service health, look for timeout errors in logs |
| High CPU + high error rate | Resource exhaustion | Check for memory leaks, runaway queries, or traffic spikes |
| Intermittent errors | Network issues or partial deploy | Check if errors correlate with specific pods, look for connection reset logs |
| Cascading failures across services | Shared dependency down | Identify the common downstream service, check database/cache health |

## Correlation Patterns

- **Time correlation**: If service A errors spike 30s before service B, A likely caused B's issues
- **Error type correlation**: Same exception across services = shared dependency
- **Traffic correlation**: Error rate proportional to traffic = capacity issue

## Escalation Criteria

- Error rate > 10% for 5+ minutes → **P1** (page on-call)
- Service completely down → **P0** (all-hands)
- Data integrity issues → **P0** (immediate escalation)
- Performance degraded but functional → **P2** (next business day)

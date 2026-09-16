# PilotSwarm AKS catalog

This deployment-specific catalog removes Claude models from GitHub Copilot and uses
`github-copilot:gpt-5.4` as the file default. The cluster runtime default was also
set to that model on 2026-09-08. Shared image defaults and other deployments are
unchanged.

Run `bash scripts/apply-aks-model-catalog.sh` from the repository to create/update
the ConfigMap and mount it into worker, portal, and MCP deployments. The helper is
pinned to context `pilotswarm-aks`, namespace `copilot-runtime`; it preserves images
and all unrelated deployment fields. The three legacy deployment scripts invoke it
only when targeting this context and namespace.

After catalog-only updates, allow file reload or restart the affected deployments
and verify their model catalogs. Existing sessions are not migrated.

Rollback: restore the prior catalog and default from the operator backup. To return
to image catalogs entirely, remove the PS_MODEL_PROVIDERS_PATH override and
aks-model-catalog volume/mount from each deployment, and remove these deploy hooks.

# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in PilotSwarm, please **do not** open a
public issue. Instead, report it privately so we can fix it before details
become public.

**Preferred channel:** open a [private security advisory](https://github.com/affandar/PilotSwarm/security/advisories/new)
on GitHub. Advisories let us discuss the issue, prepare a fix, and request a
CVE if appropriate, all without exposing details prematurely.

If GitHub Security Advisories are not available to you, please email the
maintainer (the email associated with commits in this repository).

In your report, please include:

- a description of the vulnerability and its impact
- steps to reproduce, or a proof-of-concept
- the affected version(s) — typically the most recent `pilotswarm-sdk` /
  `pilotswarm-cli` release on npm, or a specific commit SHA
- any suggested mitigation if you have one

We will acknowledge receipt within 5 business days and aim to provide a
preliminary assessment within 14 days.

## Supported Versions

PilotSwarm is **experimental** software under active development. Only the
latest release on `main` is supported. There is no LTS or back-port policy at
this stage.

## Scope

The following are in scope for security reports:

- Vulnerabilities in the `pilotswarm-sdk` runtime (worker activities,
  orchestration, session manager, CMS catalog).
- Vulnerabilities in the `pilotswarm-cli` and shared UI packages.
- Authentication or authorization bypasses in the portal package.
- Privilege escalations via tools, sub-agents, or MCP server integrations.
- Secret leakage via logs, telemetry, or persisted artifacts.

Out of scope:

- Vulnerabilities in upstream dependencies that have not been patched
  upstream — please report those to the upstream maintainer first. We will
  apply a fix once available.
- Issues in deployment topologies (Kubernetes, Postgres, blob stores) that
  reflect operator misconfiguration rather than a defect in PilotSwarm code.
- Denial-of-service attacks that require unrestricted local access to a
  worker process.

## Handling Sensitive Data In Reports

PilotSwarm sessions can contain prompts, tool outputs, and credentials. When
sharing reproductions, please redact:

- API keys, tokens, and connection strings (`DATABASE_URL`, GitHub PATs,
  Azure keys, etc.)
- Real user emails and identifying information
- Private prompts or model outputs that you do not want preserved in advisory
  history

If you need a private channel to share unredacted material, mention that in
the advisory and we will arrange an out-of-band exchange.

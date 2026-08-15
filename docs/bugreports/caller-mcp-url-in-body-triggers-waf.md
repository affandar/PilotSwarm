# Caller-attached MCP server URLs in the request body trigger WAF blocks

## Summary

When a client submits a session and attaches its **own** MCP server(s) — the
"bring your own server" path — the fully-qualified external server URL(s) travel
inside the POST body of `/api/v1/sessions` (PilotSwarm portal) / `/api/jobs`
(MAF), carried by the SDK fields:

- `SubmitRequest.mcp_servers` → forwarded as `callerMcpServers`
- `SubmitRequest.additional_mcp_server_urls`

With the portal behind Azure Front Door Premium + the Microsoft
DefaultRuleSet 2.1 in **Prevention** mode and `requestBodyCheck: Enabled`
(the default in this repo's bicep), the WAF inspects the JSON body, matches the
embedded `https://…` URL against its RFI/SSRF and generic-attack rules, the
cumulative anomaly score crosses the block threshold, and the request is
rejected with the generic AFD `403 "The request is blocked."` page **before it
ever reaches the portal**. Auth is never the problem — the caller's bearer is
valid; the payload is rejected on pattern, not identity.

This is the same class of interaction documented in
[`portal-cookie-payloads-trigger-waf.md`](./portal-cookie-payloads-trigger-waf.md),
**but with a critical difference** (see "Why this is not just a false positive").

## Reproduction

1. Deploy the portal behind AFD with the managed rule sets in Prevention mode.
2. Run the SDK caller-attached-MCP example against the public AFD endpoint:

   ```
   python examples/submit_with_caller_mcp.py \
     --base-url https://<afd-endpoint> --model azure-foundry:gpt-5.6-sol
   ```

   The example attaches an external code-intelligence MCP server
   (`https://your-mcp-server.example.com/`) via `mcp_servers`.
3. Observe:

   ```
   Submit failed: POST /api/v1/sessions failed (403):
   … <h2>The request is blocked.</h2> …
   20260814T130846Z-r1888f7546fphkdhhC1IADy33g00000003m0000000004xnr
   ```

4. The identical submit succeeds when AFD is bypassed (direct in-cluster
   port-forward to `svc/pilotswarm-portal`), confirming the block is the WAF,
   not the application.

Confirm the matched rule(s) via Log Analytics
(`AzureDiagnostics | where Category == "FrontDoorWebApplicationFirewallLog"`,
filter on the `trackingReference_g` from the error page). Expected culprits are
the RFI / SSRF family (e.g. `…-RFI-931130` "possible remote file inclusion —
off-domain URL reference") plus generic scoring rules that tip
`949110 Inbound Anomaly Score Exceeded`.

## Why this is NOT just a false positive

The cookie case is pure UI state with zero security relevance, so excluding it
from the WAF is unambiguously correct. **A caller-supplied external MCP URL is
different: it is a real capability grant.** The worker will open an outbound
connection to whatever URL the caller puts in the body. That is a textbook
Server-Side Request Forgery (SSRF) surface. So the WAF match is not simply
"wrong" — it is a (blunt) signal firing on a genuinely sensitive field.

The takeaway is therefore **not** "add a body exclusion and move on." Blindly
excluding the MCP fields from the WAF would remove one weak SSRF signal without
adding any real control. The correct fix moves the security decision to a layer
that can actually make it — an egress allowlist — and only *then* relaxes the
WAF, because the WAF's body scan was always a poor SSRF control (it only blocks
URLs that happen to look malicious to a regex; it does nothing about a
perfectly "clean-looking" URL pointing at `169.254.169.254`).

## Current status: PoC

The caller-attached-MCP flow works end-to-end (verified against the cluster with
AFD bypassed) but is **blocked on the public endpoint today**. It is shipped as
a **proof-of-concept example only**. Repo-declared MCP servers
(`submit_with_repo_mcp.py`) are the supported production path and are **not**
blocked — precisely because the server URL lives server-side in the fleet
`*.mcp.json`, never in the request body.

## Proposed long-term design (the story going forward)

A layered, defense-in-depth design. #1 is the primary fix; #2/#3 are the real
SSRF controls; #4 is a transitional measure gated behind #1.

1. **Server-by-reference, not server-by-URL (primary fix).**
   Introduce an MCP **server registry / allowlist** owned by the portal.
   Callers attach a server by a pre-registered **ID / short name**, not a raw
   URL; the portal resolves ID → vetted URL + downstream audience server-side.
   Effect:
   - Raw external URLs leave the request body entirely → the WAF has nothing to
     match, and no per-field exclusion is needed.
   - The set of reachable hosts becomes a closed, admin-curated allowlist.
   - Per-audience delegated auth still works — the registry stores the audience,
     so the existing `additional_mcp_server_urls` → OAuth-protected-resource
     discovery collapses into a registry lookup.
   This mirrors how repo-declared servers already work (and why they are not
   blocked). "Bring your own server" becomes "**register** your server once
   (admin-reviewed), then **reference** it by name."

2. **Portal / worker egress allowlist + SSRF guard (the real control).**
   At MCP-client connect time — whether the URL came from the registry or,
   transitionally, from the body — enforce:
   - scheme allowlist (`https` only),
   - host allowlist (registry-backed),
   - hard denial of link-local / metadata / private targets:
     `169.254.0.0/16` (incl. `169.254.169.254`), `::1`/`127.0.0.0/8`,
     `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `*.internal`,
     `*.svc.cluster.local`.
   This is the purpose-built SSRF defense the WAF body-scan was only weakly
   approximating.

3. **Network egress policy at the worker/AKS layer (backstop).**
   NSG / Azure Firewall / Cilium egress policy so that even a mis-allowlisted
   URL cannot reach internal control planes or the node metadata endpoint.
   Belt-and-suspenders behind #2.

4. **Transitional WAF exclusion — only until #1 ships, scoped + documented.**
   If the caller-attached-in-body path must work on the public endpoint before
   the registry lands, add a **scoped** exclusion for the MCP config fields
   (`RequestBodyPostArgNames` / JSON-path selectors for `mcpServers`,
   `callerMcpServers`, `additional_mcp_server_urls`) in
   `frontdoor-waf-policy.bicep`, mirroring the existing JWT/cookie exclusion
   pattern. This is **only safe because** #2 and #3 now carry the SSRF load.
   Include an explicit removal trigger:
   `// TODO(remove after MCP server registry #<work-item> ships): callers will
   reference servers by ID, so URLs no longer appear in the body.`

After #1 ships, the transitional exclusion (#4) is removed and the security
posture is *stronger* than today — the WAF regains full body inspection, and
SSRF is enforced by an allowlist that actually understands the threat.

## Related WAF mechanics worth remembering

- `requestBodyCheck: Enabled` is what brings the JSON body into scope for the
  managed rules; body-arg exclusions must be declared at
  `RequestBodyPostArgNames` (not `RequestHeaderNames` / `RequestCookieNames`).
- AFD WAF policy changes can take 5–10 minutes to propagate to all edge POPs
  even after the API call returns success.
- The 403 "request is blocked" page's tracking reference is the join key into
  `FrontDoorWebApplicationFirewallLog` for identifying exactly which rule(s)
  fired.

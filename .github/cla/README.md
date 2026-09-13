# CLA administration

Use the hosted [CLA Assistant](https://cla-assistant.io/) with `CLA.md` and the
`metadata` file in this directory. No GitHub Actions workflow or repository PAT is
needed for this integration. The separate
[`contributor-assistant/github-action`](https://github.com/contributor-assistant/github-action)
project is archived and is not used here.

## Rollout

1. Review `CLA.md`, particularly the personal recipient, employer authority,
   historical contributions, commercial sublicensing, and successor provisions.
   This adapted agreement has not received legal review.
2. Publish a public GitHub Gist containing **exactly** the reviewed `CLA.md` and
   `metadata`. Record its URL and revision below. Do not edit an active Gist
   casually: CLA Assistant can require new signatures when its contents change.
3. Sign in to CLA Assistant as the repository administrator, review its permissions
   and service terms, and link `affandar/PilotSwarm` to that Gist. Scope repository
   access to PilotSwarm wherever the service allows it.
4. Verify on a real contributor PR that an unsigned contributor produces a failing
   CLA status, the signing form displays the correct text and fields, and the
   contributor's own acceptance changes it to passing. Check author/coauthor
   coverage; review unmapped commit identities manually. Never sign for another
   contributor or import a human account merely to bypass signing.
5. Add the exact status context emitted by the service as a required status check
   on `main`, require pull requests, and prevent direct pushes from bypassing the
   check. Use a dedicated CLA ruleset; preserve unrelated repository rules. Do not
   enable a required status before confirming that the service actually emits it.
6. Once live, remove the rollout paragraph from `CONTRIBUTING.md`, merge the
   documentation, and record validation evidence below. Export signature records
   after the initial rollout and periodically afterward to private maintainer
   storage; do not commit legal names or employer records to this public repo.

## Activation record

- Proposed Gist: <https://gist.github.com/affandar/e55e6c48caadf3392811ccca48b05be9>
- Gist revision: `a699621c9157e843c414ce5b3d5ce6db1de032ad`.
- Repository linked: GitHub OAuth authorized and `affandar/PilotSwarm` appears in
  the CLA Assistant dashboard with the intended Gist (2026-09-13 UTC).
- Activation blocker: after linking and requesting a PR recheck, GitHub's hooks
  API still returns no webhook, PR #78 has no CLA status, and the signing page
  stays on a loading indicator without showing the agreement/version. Dashboard
  linkage alone is not evidence that the bot is operational. Retry/repair the
  hosted integration before enabling enforcement or soliciting signatures.
- Observed status context / source: pending first live check.
- Unsigned-to-signed test: pending an actual contributor's acceptance.
- Required merge check: pending verified integration.
- Agreement legal review: not performed.

## Existing contributors

Inventory merged PR authors, commit authors, and coauthors, including directly
pushed commits. GitHub's contributors endpoint alone is not a complete authorship
audit. Resolve multiple accounts and unmapped identities with their owners; do not
infer employment from usernames or email domains. Track evidence of actual
acceptance of this agreement version, not acceptance of Microsoft or other CLAs.

Ask each contributor to use the signing page once the service is active. Keep a
private record linking their signature/version to the relevant historical PRs or
commits. An unanswered request or a new requirement does not itself establish
agreement to cover historical contributions.

The owner is the agreement recipient; document that separately from an external
signature. Do not blanket-exempt Microsoft employees or accounts matching `*bot*`.
If a specific dependency bot needs an exception, review its provenance and document
the exception separately from real signature records. Human-authored content
submitted through an AI agent still needs coverage from the responsible human.

## Sources

- [Hosted service setup and signature exports](https://github.com/cla-assistant/cla-assistant)
- [Custom signing fields](https://github.com/cla-assistant/cla-assistant#request-more-information-from-the-cla-signer)
- [Agreement source, dedicated to CC0](https://opensource.microsoft.com/pdf/microsoft-contribution-license-agreement.pdf)

# Finance Research Lab

An uploadable PilotSwarm agent package for source-backed stock and finance
research. It contains a coordinating research lead and five specialist agents.

It doubles as the multi-agent worked example in
[Building an Agent Package for PilotSwarm](../../../docs/building-agent-packages.md),
which is the reference for the manifest, agent, skill, and worker-tool
contracts this package implements.

## Agents

| Agent | Focus |
|---|---|
| `finance-research-lead` | Coordinates a full research memo and specialist work |
| `equity-fundamentals` | Business model, filings, statements, and earnings quality |
| `valuation-analyst` | DCF, multiples, assumptions, and sensitivity analysis |
| `market-catalyst-scout` | News, earnings, events, and thesis-changing catalysts |
| `investment-risk-auditor` | Downside cases, balance-sheet risk, governance, and red flags |
| `macro-sector-strategist` | Rates, FX, commodities, sector structure, and macro transmission |

## Data tools

- `finance_symbol_search` and `finance_news_search` use Yahoo Finance public
  search endpoints.
- `finance_market_data` uses the Yahoo Finance chart endpoint.
- `finance_sec_facts` uses SEC EDGAR company facts for US registrants.
- `finance_ratio_math` performs deterministic ratio and growth calculations.
- `finance_dcf` performs a transparent unlevered DCF with a sensitivity grid.

The public data endpoints are best-effort and can rate-limit or change. Agents
are instructed to verify material claims against primary filings, investor
relations releases, exchange notices, or regulator publications.

For SEC requests, set a descriptive user agent with contact information:

```sh
export SEC_USER_AGENT="Your Name your-email@example.com"
```

## Validate and upload

From the PilotSwarm repository root:

```sh
pilotswarm agents validate ./examples/agent-packages/finance-research-lab
pilotswarm agents push ./examples/agent-packages/finance-research-lab --user
```

Use `--shared` instead of `--user` when the package should be available to
everyone. Package identities are immutable, so bump the prerelease version
(`0.1.0-dev.2`, `0.1.0-dev.3`, and so on) before uploading changed content.

## Smoke tests

1. Start `finance-research-lead` and ask:
   `Build a source-backed research memo on MSFT as of today, including the bull
   case, bear case, valuation scenarios, catalysts, and disconfirming evidence.`
2. Start `equity-fundamentals` and ask:
   `Use the finance tools to summarize AAPL revenue, margins, cash flow, and
   balance-sheet trends. Show periods, units, filing dates, and sources.`
3. Start `valuation-analyst` and ask:
   `Build an illustrative five-year DCF for a company with 1000 revenue, 8%
   fading growth, a 24% EBIT margin, 10% discount rate, 3% perpetual growth,
   100 net debt, and 50 diluted shares.`
4. Start `market-catalyst-scout` and ask:
   `Find recent NVDA catalysts, then open the primary sources behind the most
   material items and separate confirmed events from speculation.`

This package is for research and testing, not personalized investment advice.

const HTTP_TIMEOUT_MS = 20_000;
const YAHOO_HEADERS = {
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; PilotSwarm Finance Research Lab/0.1)",
};
const SEC_HEADERS = {
    Accept: "application/json",
    "Accept-Encoding": "gzip, deflate",
    "User-Agent": process.env.SEC_USER_AGENT
        || "PilotSwarm Finance Research Lab/0.1 github.com/affandar/PilotSwarm",
};

const MARKET_RANGES = new Set(["5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "max"]);
const MARKET_INTERVALS = new Set(["1d", "1wk", "1mo"]);
const SEC_FORMS = new Set(["10-K", "10-Q", "20-F", "40-F", "6-K"]);

const SEC_METRICS = {
    revenue: {
        label: "Revenue",
        unit: "USD",
        tags: [
            "RevenueFromContractWithCustomerExcludingAssessedTax",
            "Revenues",
            "SalesRevenueNet",
        ],
    },
    operatingIncome: {
        label: "Operating income",
        unit: "USD",
        tags: ["OperatingIncomeLoss"],
    },
    netIncome: {
        label: "Net income",
        unit: "USD",
        tags: ["NetIncomeLoss", "ProfitLoss"],
    },
    assets: {
        label: "Assets",
        unit: "USD",
        tags: ["Assets"],
    },
    liabilities: {
        label: "Liabilities",
        unit: "USD",
        tags: ["Liabilities"],
    },
    equity: {
        label: "Stockholders' equity",
        unit: "USD",
        tags: [
            "StockholdersEquity",
            "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
        ],
    },
    cash: {
        label: "Cash and cash equivalents",
        unit: "USD",
        tags: [
            "CashAndCashEquivalentsAtCarryingValue",
            "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
        ],
    },
    longTermDebt: {
        label: "Long-term debt",
        unit: "USD",
        tags: [
            "LongTermDebtAndFinanceLeaseObligationsNoncurrent",
            "LongTermDebtNoncurrent",
        ],
    },
    operatingCashFlow: {
        label: "Operating cash flow",
        unit: "USD",
        tags: ["NetCashProvidedByUsedInOperatingActivities"],
    },
    capitalExpenditures: {
        label: "Capital expenditures",
        unit: "USD",
        tags: ["PaymentsToAcquirePropertyPlantAndEquipment"],
    },
    dilutedEps: {
        label: "Diluted earnings per share",
        unit: "USD/shares",
        tags: ["EarningsPerShareDiluted"],
    },
    dilutedShares: {
        label: "Diluted weighted-average shares",
        unit: "shares",
        tags: ["WeightedAverageNumberOfDilutedSharesOutstanding"],
    },
};

const DEFAULT_SEC_METRICS = Object.keys(SEC_METRICS);
let secTickerCache = null;
let secTickerCacheAt = 0;

function requireText(value, name, maxLength = 200) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${name} must be a non-empty string`);
    }
    const text = value.trim();
    if (text.length > maxLength) {
        throw new Error(`${name} must be at most ${maxLength} characters`);
    }
    return text;
}

function requireNumber(value, name) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        throw new Error(`${name} must be a finite number`);
    }
    return number;
}

function boundedInteger(value, name, minimum, maximum, defaultValue) {
    const number = value === undefined ? defaultValue : Number(value);
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
        throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
    }
    return number;
}

function boundedPercent(value, name, minimum, maximum, defaultValue) {
    const number = value === undefined ? defaultValue : requireNumber(value, name);
    if (number < minimum || number > maximum) {
        throw new Error(`${name} must be from ${minimum} to ${maximum}`);
    }
    return number;
}

function normalizeSymbol(value) {
    const symbol = requireText(value, "symbol", 32).toUpperCase();
    if (!/^[A-Z0-9.^=_-]+$/.test(symbol)) {
        throw new Error("symbol contains unsupported characters");
    }
    return symbol;
}

function round(value, digits = 4) {
    if (!Number.isFinite(value)) return null;
    const factor = 10 ** digits;
    return Math.round((value + Number.EPSILON) * factor) / factor;
}

function numberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function isoFromUnix(value) {
    if (value === null || value === undefined || value === "") return null;
    const seconds = Number(value);
    return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

async function fetchJson(url, headers) {
    const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`upstream request failed with HTTP ${response.status}: ${url}`);
    }
    return response.json();
}

function yahooSearchUrl(query, quotesCount, newsCount) {
    const url = new URL("https://query1.finance.yahoo.com/v1/finance/search");
    url.searchParams.set("q", query);
    url.searchParams.set("quotesCount", String(quotesCount));
    url.searchParams.set("newsCount", String(newsCount));
    url.searchParams.set("enableFuzzyQuery", "false");
    url.searchParams.set("quotesQueryId", "tss_match_phrase_query");
    return url.toString();
}

function marketStats(rows, interval) {
    const closes = rows
        .map((row) => row.adjustedClose ?? row.close)
        .filter((value) => Number.isFinite(value) && value > 0);
    if (closes.length === 0) {
        return {
            observations: 0,
            periodReturnPct: null,
            annualizedVolatilityPct: null,
            maxDrawdownPct: null,
        };
    }

    const logReturns = [];
    let peak = closes[0];
    let maxDrawdown = 0;
    for (let index = 0; index < closes.length; index += 1) {
        const close = closes[index];
        peak = Math.max(peak, close);
        maxDrawdown = Math.min(maxDrawdown, (close / peak) - 1);
        if (index > 0) {
            logReturns.push(Math.log(close / closes[index - 1]));
        }
    }

    let annualizedVolatilityPct = null;
    if (logReturns.length > 1) {
        const mean = logReturns.reduce((sum, value) => sum + value, 0) / logReturns.length;
        const variance = logReturns.reduce((sum, value) => sum + ((value - mean) ** 2), 0)
            / (logReturns.length - 1);
        const periodsPerYear = interval === "1wk" ? 52 : interval === "1mo" ? 12 : 252;
        annualizedVolatilityPct = Math.sqrt(variance * periodsPerYear) * 100;
    }

    return {
        observations: closes.length,
        firstClose: round(closes[0], 6),
        lastClose: round(closes.at(-1), 6),
        periodReturnPct: round(((closes.at(-1) / closes[0]) - 1) * 100, 4),
        annualizedVolatilityPct: round(annualizedVolatilityPct, 4),
        maxDrawdownPct: round(maxDrawdown * 100, 4),
    };
}

async function getSecTickers() {
    const now = Date.now();
    if (secTickerCache && now - secTickerCacheAt < 6 * 60 * 60 * 1000) {
        return secTickerCache;
    }
    const url = "https://www.sec.gov/files/company_tickers.json";
    const payload = await fetchJson(url, SEC_HEADERS);
    secTickerCache = Object.values(payload)
        .filter((entry) => entry && entry.ticker && entry.cik_str)
        .map((entry) => ({
            ticker: String(entry.ticker).toUpperCase(),
            cik: String(entry.cik_str).padStart(10, "0"),
            title: String(entry.title || ""),
        }));
    secTickerCacheAt = now;
    return secTickerCache;
}

function selectSecMetric(companyFacts, metricName, periods) {
    const definition = SEC_METRICS[metricName];
    const taxonomy = companyFacts?.facts?.["us-gaap"] || {};
    for (const tag of definition.tags) {
        const fact = taxonomy[tag];
        if (!fact?.units || typeof fact.units !== "object") continue;
        const unit = fact.units[definition.unit]
            ? definition.unit
            : Object.keys(fact.units)[0];
        if (!unit) continue;

        const rows = fact.units[unit]
            .filter((row) => row?.val !== null
                && row?.val !== undefined
                && Number.isFinite(Number(row.val))
                && SEC_FORMS.has(row?.form))
            .sort((left, right) => {
                const leftKey = `${left.end || ""}:${left.filed || ""}`;
                const rightKey = `${right.end || ""}:${right.filed || ""}`;
                return rightKey.localeCompare(leftKey);
            });
        const framedRows = rows.filter((row) => row.frame);
        const candidates = framedRows.length >= Math.min(2, periods) ? framedRows : rows;
        const seen = new Set();
        const selected = [];
        for (const row of candidates) {
            const key = row.frame
                || `${row.start || ""}:${row.end || ""}:${row.fp || ""}:${row.form || ""}`;
            if (seen.has(key)) continue;
            seen.add(key);
            selected.push({
                value: Number(row.val),
                start: row.start || null,
                end: row.end || null,
                fiscalYear: row.fy ?? null,
                fiscalPeriod: row.fp || null,
                form: row.form || null,
                filed: row.filed || null,
                frame: row.frame || null,
                accession: row.accn || null,
            });
            if (selected.length >= periods) break;
        }

        return {
            metric: metricName,
            label: definition.label,
            tag,
            unit,
            description: fact.description || null,
            periods: selected,
        };
    }
    return {
        metric: metricName,
        label: definition.label,
        tag: null,
        unit: definition.unit,
        description: null,
        periods: [],
    };
}

function calculateDcf(inputs) {
    const revenue = requireNumber(inputs.revenue, "revenue");
    if (revenue <= 0) throw new Error("revenue must be greater than zero");

    const years = boundedInteger(inputs.years, "years", 1, 10, 5);
    const startGrowth = boundedPercent(inputs.revenueGrowthPct, "revenueGrowthPct", -99, 300, 8) / 100;
    const endGrowth = boundedPercent(
        inputs.terminalRevenueGrowthPct,
        "terminalRevenueGrowthPct",
        -99,
        300,
        startGrowth * 100,
    ) / 100;
    const startMargin = boundedPercent(inputs.ebitMarginPct, "ebitMarginPct", -100, 100, 20) / 100;
    const endMargin = boundedPercent(
        inputs.terminalEbitMarginPct,
        "terminalEbitMarginPct",
        -100,
        100,
        startMargin * 100,
    ) / 100;
    const taxRate = boundedPercent(inputs.taxRatePct, "taxRatePct", 0, 100, 21) / 100;
    const depreciationRate = boundedPercent(
        inputs.depreciationPctRevenue,
        "depreciationPctRevenue",
        0,
        100,
        3,
    ) / 100;
    const capexRate = boundedPercent(inputs.capexPctRevenue, "capexPctRevenue", 0, 100, 4) / 100;
    const nwcRate = boundedPercent(
        inputs.nwcInvestmentPctRevenueGrowth,
        "nwcInvestmentPctRevenueGrowth",
        -100,
        100,
        5,
    ) / 100;
    const discountRate = boundedPercent(inputs.discountRatePct, "discountRatePct", 0.01, 100, 10) / 100;
    const perpetualGrowth = boundedPercent(
        inputs.perpetualGrowthPct,
        "perpetualGrowthPct",
        -99,
        99,
        3,
    ) / 100;
    if (discountRate <= perpetualGrowth) {
        throw new Error("discountRatePct must be greater than perpetualGrowthPct");
    }

    const netDebt = inputs.netDebt === undefined ? 0 : requireNumber(inputs.netDebt, "netDebt");
    const dilutedShares = requireNumber(inputs.dilutedShares, "dilutedShares");
    if (dilutedShares <= 0) throw new Error("dilutedShares must be greater than zero");

    const projections = [];
    let priorRevenue = revenue;
    for (let year = 1; year <= years; year += 1) {
        const position = years === 1 ? 0 : (year - 1) / (years - 1);
        const growth = startGrowth + ((endGrowth - startGrowth) * position);
        const margin = startMargin + ((endMargin - startMargin) * position);
        const projectedRevenue = priorRevenue * (1 + growth);
        const ebit = projectedRevenue * margin;
        const nopat = ebit * (1 - taxRate);
        const depreciation = projectedRevenue * depreciationRate;
        const capex = projectedRevenue * capexRate;
        const nwcInvestment = (projectedRevenue - priorRevenue) * nwcRate;
        const freeCashFlow = nopat + depreciation - capex - nwcInvestment;
        const discountFactor = (1 + discountRate) ** year;
        projections.push({
            year,
            revenueGrowthPct: round(growth * 100, 4),
            revenue: round(projectedRevenue, 4),
            ebitMarginPct: round(margin * 100, 4),
            ebit: round(ebit, 4),
            nopat: round(nopat, 4),
            depreciation: round(depreciation, 4),
            capex: round(capex, 4),
            nwcInvestment: round(nwcInvestment, 4),
            freeCashFlow: round(freeCashFlow, 4),
            presentValue: round(freeCashFlow / discountFactor, 4),
        });
        priorRevenue = projectedRevenue;
    }

    const finalCashFlow = projections.at(-1).freeCashFlow;
    const terminalValue = finalCashFlow * (1 + perpetualGrowth) / (discountRate - perpetualGrowth);
    const terminalPresentValue = terminalValue / ((1 + discountRate) ** years);
    const explicitPresentValue = projections.reduce((sum, row) => sum + row.presentValue, 0);
    const enterpriseValue = explicitPresentValue + terminalPresentValue;
    const equityValue = enterpriseValue - netDebt;
    const perShareValue = equityValue / dilutedShares;

    return {
        assumptions: {
            revenue,
            years,
            revenueGrowthPct: startGrowth * 100,
            terminalRevenueGrowthPct: endGrowth * 100,
            ebitMarginPct: startMargin * 100,
            terminalEbitMarginPct: endMargin * 100,
            taxRatePct: taxRate * 100,
            depreciationPctRevenue: depreciationRate * 100,
            capexPctRevenue: capexRate * 100,
            nwcInvestmentPctRevenueGrowth: nwcRate * 100,
            discountRatePct: discountRate * 100,
            perpetualGrowthPct: perpetualGrowth * 100,
            netDebt,
            dilutedShares,
        },
        projections,
        explicitPresentValue: round(explicitPresentValue, 4),
        terminalValue: round(terminalValue, 4),
        terminalPresentValue: round(terminalPresentValue, 4),
        terminalValuePctEnterpriseValue: round((terminalPresentValue / enterpriseValue) * 100, 4),
        enterpriseValue: round(enterpriseValue, 4),
        equityValue: round(equityValue, 4),
        perShareValue: round(perShareValue, 4),
    };
}

function dcfSensitivity(inputs, base) {
    const discountRates = [-2, -1, 0, 1, 2]
        .map((delta) => base.assumptions.discountRatePct + delta)
        .filter((value) => value > 0 && value <= 100);
    const perpetualGrowthRates = [-1, 0, 1]
        .map((delta) => base.assumptions.perpetualGrowthPct + delta)
        .filter((value) => value >= -99 && value <= 99);
    const rows = [];
    for (const perpetualGrowthPct of perpetualGrowthRates) {
        const values = [];
        for (const discountRatePct of discountRates) {
            if (discountRatePct <= perpetualGrowthPct) {
                values.push({ discountRatePct, perShareValue: null });
                continue;
            }
            const scenario = calculateDcf({
                ...inputs,
                discountRatePct,
                perpetualGrowthPct,
            });
            values.push({
                discountRatePct,
                perShareValue: scenario.perShareValue,
            });
        }
        rows.push({ perpetualGrowthPct, values });
    }
    return rows;
}

export default {
    createTools: ({ workerNodeId }) => [
        {
            name: "finance_symbol_search",
            description: "Search for market symbols and listings by company, fund, index, or ticker name.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Company, security, fund, index, or ticker to resolve.",
                    },
                    limit: {
                        type: "integer",
                        description: "Maximum matches to return, from 1 to 20. Defaults to 8.",
                    },
                },
                required: ["query"],
                additionalProperties: false,
            },
            handler: async ({ query, limit = 8 } = {}) => {
                const normalizedQuery = requireText(query, "query");
                const boundedLimit = boundedInteger(limit, "limit", 1, 20, 8);
                const url = yahooSearchUrl(normalizedQuery, boundedLimit, 0);
                const payload = await fetchJson(url, YAHOO_HEADERS);
                const results = (payload.quotes || [])
                    .filter((quote) => quote?.symbol)
                    .slice(0, boundedLimit)
                    .map((quote) => ({
                        symbol: quote.symbol,
                        name: quote.longname || quote.shortname || quote.name || null,
                        exchange: quote.exchange || null,
                        exchangeDisplay: quote.exchDisp || null,
                        quoteType: quote.quoteType || null,
                        sector: quote.sector || null,
                        industry: quote.industry || null,
                    }));
                return {
                    query: normalizedQuery,
                    fetchedAt: new Date().toISOString(),
                    source: { provider: "Yahoo Finance search", url },
                    workerNodeId: workerNodeId || null,
                    results,
                };
            },
        },
        {
            name: "finance_news_search",
            description: "Search recent finance news leads by company, ticker, sector, person, or topic. Fetch primary sources before relying on a result.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Focused finance news search query.",
                    },
                    limit: {
                        type: "integer",
                        description: "Maximum news results to return, from 1 to 30. Defaults to 10.",
                    },
                },
                required: ["query"],
                additionalProperties: false,
            },
            handler: async ({ query, limit = 10 } = {}) => {
                const normalizedQuery = requireText(query, "query");
                const boundedLimit = boundedInteger(limit, "limit", 1, 30, 10);
                const url = yahooSearchUrl(normalizedQuery, 3, boundedLimit);
                const payload = await fetchJson(url, YAHOO_HEADERS);
                const results = (payload.news || [])
                    .slice(0, boundedLimit)
                    .map((item) => ({
                        title: item.title || null,
                        publisher: item.publisher || null,
                        link: item.link || null,
                        publishedAt: isoFromUnix(item.providerPublishTime),
                        relatedTickers: Array.isArray(item.relatedTickers) ? item.relatedTickers : [],
                        type: item.type || null,
                    }));
                return {
                    query: normalizedQuery,
                    fetchedAt: new Date().toISOString(),
                    source: { provider: "Yahoo Finance news search", url },
                    workerNodeId: workerNodeId || null,
                    results,
                };
            },
        },
        {
            name: "finance_market_data",
            description: "Fetch timestamped historical price, volume, dividends, splits, return, volatility, and drawdown data for a market symbol.",
            parameters: {
                type: "object",
                properties: {
                    symbol: {
                        type: "string",
                        description: "Yahoo Finance symbol, such as MSFT, BRK-B, ^GSPC, EURUSD=X, or CL=F.",
                    },
                    range: {
                        type: "string",
                        enum: [...MARKET_RANGES],
                        description: "History range. Defaults to 1y.",
                    },
                    interval: {
                        type: "string",
                        enum: [...MARKET_INTERVALS],
                        description: "Sampling interval. Defaults to 1d.",
                    },
                },
                required: ["symbol"],
                additionalProperties: false,
            },
            handler: async ({ symbol, range = "1y", interval = "1d" } = {}) => {
                const normalizedSymbol = normalizeSymbol(symbol);
                if (!MARKET_RANGES.has(range)) throw new Error(`unsupported range: ${range}`);
                if (!MARKET_INTERVALS.has(interval)) throw new Error(`unsupported interval: ${interval}`);

                const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(normalizedSymbol)}`);
                url.searchParams.set("range", range);
                url.searchParams.set("interval", interval);
                url.searchParams.set("events", "div,splits");
                url.searchParams.set("includeAdjustedClose", "true");
                const payload = await fetchJson(url.toString(), YAHOO_HEADERS);
                const chart = payload?.chart;
                if (chart?.error) {
                    throw new Error(`market data provider error: ${chart.error.description || chart.error.code}`);
                }
                const result = chart?.result?.[0];
                if (!result) throw new Error(`no market data returned for ${normalizedSymbol}`);

                const timestamps = result.timestamp || [];
                const quote = result.indicators?.quote?.[0] || {};
                const adjusted = result.indicators?.adjclose?.[0]?.adjclose || [];
                const rows = timestamps.map((timestamp, index) => ({
                    date: isoFromUnix(timestamp),
                    open: numberOrNull(quote.open?.[index]),
                    high: numberOrNull(quote.high?.[index]),
                    low: numberOrNull(quote.low?.[index]),
                    close: numberOrNull(quote.close?.[index]),
                    adjustedClose: numberOrNull(adjusted[index]),
                    volume: numberOrNull(quote.volume?.[index]),
                })).filter((row) => row.close !== null || row.adjustedClose !== null);

                const limitedRows = rows.slice(-1_000);
                const dividends = Object.values(result.events?.dividends || {})
                    .map((event) => ({
                        date: isoFromUnix(event.date),
                        amount: numberOrNull(event.amount),
                    }))
                    .sort((left, right) => String(left.date).localeCompare(String(right.date)));
                const splits = Object.values(result.events?.splits || {})
                    .map((event) => ({
                        date: isoFromUnix(event.date),
                        numerator: numberOrNull(event.numerator),
                        denominator: numberOrNull(event.denominator),
                        splitRatio: event.splitRatio || null,
                    }))
                    .sort((left, right) => String(left.date).localeCompare(String(right.date)));

                return {
                    symbol: result.meta?.symbol || normalizedSymbol,
                    fetchedAt: new Date().toISOString(),
                    source: { provider: "Yahoo Finance chart", url: url.toString() },
                    workerNodeId: workerNodeId || null,
                    meta: {
                        currency: result.meta?.currency || null,
                        exchangeName: result.meta?.exchangeName || null,
                        instrumentType: result.meta?.instrumentType || null,
                        timezone: result.meta?.exchangeTimezoneName || result.meta?.timezone || null,
                        regularMarketPrice: numberOrNull(result.meta?.regularMarketPrice),
                        regularMarketTime: isoFromUnix(result.meta?.regularMarketTime),
                        previousClose: numberOrNull(
                            result.meta?.previousClose ?? result.meta?.chartPreviousClose,
                        ),
                        dataGranularity: result.meta?.dataGranularity || interval,
                    },
                    range,
                    interval,
                    stats: marketStats(rows, interval),
                    availableObservations: rows.length,
                    truncated: rows.length > limitedRows.length,
                    prices: limitedRows,
                    dividends,
                    splits,
                };
            },
        },
        {
            name: "finance_sec_facts",
            description: "Fetch selected structured US-GAAP company facts from SEC EDGAR for an exact US-listed ticker.",
            parameters: {
                type: "object",
                properties: {
                    ticker: {
                        type: "string",
                        description: "Exact SEC ticker, such as AAPL or MSFT.",
                    },
                    metrics: {
                        type: "array",
                        items: {
                            type: "string",
                            enum: DEFAULT_SEC_METRICS,
                        },
                        description: "Optional metric names. Omit to return the default metric set.",
                    },
                    periods: {
                        type: "integer",
                        description: "Maximum periods per metric, from 1 to 16. Defaults to 8.",
                    },
                },
                required: ["ticker"],
                additionalProperties: false,
            },
            handler: async ({ ticker, metrics, periods = 8 } = {}) => {
                const normalizedTicker = requireText(ticker, "ticker", 20).toUpperCase();
                const boundedPeriods = boundedInteger(periods, "periods", 1, 16, 8);
                const selectedMetrics = metrics === undefined ? DEFAULT_SEC_METRICS : metrics;
                if (!Array.isArray(selectedMetrics) || selectedMetrics.length === 0) {
                    throw new Error("metrics must be a non-empty array when provided");
                }
                for (const metric of selectedMetrics) {
                    if (!SEC_METRICS[metric]) throw new Error(`unsupported SEC metric: ${metric}`);
                }

                const tickers = await getSecTickers();
                const company = tickers.find((entry) => entry.ticker === normalizedTicker);
                if (!company) {
                    throw new Error(`ticker ${normalizedTicker} was not found in the SEC company ticker catalog`);
                }
                const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${company.cik}.json`;
                const payload = await fetchJson(url, SEC_HEADERS);
                return {
                    ticker: company.ticker,
                    cik: company.cik,
                    entityName: payload.entityName || company.title,
                    fetchedAt: new Date().toISOString(),
                    source: { provider: "SEC EDGAR company facts", url },
                    workerNodeId: workerNodeId || null,
                    warning: "Duration facts can mix quarterly, year-to-date, and annual values. Inspect start, end, fiscalPeriod, form, frame, and filing date before comparing periods.",
                    metrics: selectedMetrics.map((metric) => selectSecMetric(payload, metric, boundedPeriods)),
                };
            },
        },
        {
            name: "finance_ratio_math",
            description: "Perform deterministic finance arithmetic for ratios, margins, percentage changes, CAGR, enterprise value, and per-share values.",
            parameters: {
                type: "object",
                properties: {
                    operation: {
                        type: "string",
                        enum: ["ratio", "margin", "percent_change", "cagr", "enterprise_value", "per_share"],
                    },
                    numerator: { type: "number" },
                    denominator: { type: "number" },
                    profit: { type: "number" },
                    revenue: { type: "number" },
                    beginning: { type: "number" },
                    ending: { type: "number" },
                    periods: { type: "number" },
                    marketCap: { type: "number" },
                    totalDebt: { type: "number" },
                    cash: { type: "number" },
                    value: { type: "number" },
                    dilutedShares: { type: "number" },
                },
                required: ["operation"],
                additionalProperties: false,
            },
            handler: async (args = {}) => {
                const operation = requireText(args.operation, "operation", 40);
                let result;
                if (operation === "ratio") {
                    const numerator = requireNumber(args.numerator, "numerator");
                    const denominator = requireNumber(args.denominator, "denominator");
                    if (denominator === 0) throw new Error("denominator must not be zero");
                    const value = numerator / denominator;
                    result = { value: round(value, 8), percent: round(value * 100, 4) };
                } else if (operation === "margin") {
                    const profit = requireNumber(args.profit, "profit");
                    const revenue = requireNumber(args.revenue, "revenue");
                    if (revenue === 0) throw new Error("revenue must not be zero");
                    const value = profit / revenue;
                    result = { value: round(value, 8), percent: round(value * 100, 4) };
                } else if (operation === "percent_change") {
                    const beginning = requireNumber(args.beginning, "beginning");
                    const ending = requireNumber(args.ending, "ending");
                    if (beginning === 0) throw new Error("beginning must not be zero");
                    const value = (ending / beginning) - 1;
                    result = { value: round(value, 8), percent: round(value * 100, 4) };
                } else if (operation === "cagr") {
                    const beginning = requireNumber(args.beginning, "beginning");
                    const ending = requireNumber(args.ending, "ending");
                    const periods = requireNumber(args.periods, "periods");
                    if (beginning <= 0 || ending < 0 || periods <= 0) {
                        throw new Error("CAGR requires beginning > 0, ending >= 0, and periods > 0");
                    }
                    const value = (ending / beginning) ** (1 / periods) - 1;
                    result = { value: round(value, 8), percent: round(value * 100, 4) };
                } else if (operation === "enterprise_value") {
                    const marketCap = requireNumber(args.marketCap, "marketCap");
                    const totalDebt = requireNumber(args.totalDebt, "totalDebt");
                    const cash = requireNumber(args.cash, "cash");
                    result = { enterpriseValue: round(marketCap + totalDebt - cash, 4) };
                } else if (operation === "per_share") {
                    const value = requireNumber(args.value, "value");
                    const dilutedShares = requireNumber(args.dilutedShares, "dilutedShares");
                    if (dilutedShares <= 0) throw new Error("dilutedShares must be greater than zero");
                    result = { perShareValue: round(value / dilutedShares, 8) };
                } else {
                    throw new Error(`unsupported operation: ${operation}`);
                }
                return {
                    operation,
                    workerNodeId: workerNodeId || null,
                    result,
                };
            },
        },
        {
            name: "finance_dcf",
            description: "Run a transparent unlevered DCF with fading growth and EBIT margin assumptions, terminal value, and a discount-rate/perpetual-growth sensitivity grid.",
            parameters: {
                type: "object",
                properties: {
                    revenue: { type: "number", description: "Base-period revenue in any consistent currency unit." },
                    years: { type: "integer", description: "Explicit forecast years, from 1 to 10. Defaults to 5." },
                    revenueGrowthPct: { type: "number", description: "Year-one revenue growth in percentage points." },
                    terminalRevenueGrowthPct: { type: "number", description: "Final explicit-year revenue growth in percentage points." },
                    ebitMarginPct: { type: "number", description: "Year-one EBIT margin in percentage points." },
                    terminalEbitMarginPct: { type: "number", description: "Final explicit-year EBIT margin in percentage points." },
                    taxRatePct: { type: "number", description: "Cash tax rate in percentage points." },
                    depreciationPctRevenue: { type: "number", description: "Depreciation as a percentage of revenue." },
                    capexPctRevenue: { type: "number", description: "Capital expenditure as a percentage of revenue." },
                    nwcInvestmentPctRevenueGrowth: { type: "number", description: "Incremental working-capital investment as a percentage of the revenue change." },
                    discountRatePct: { type: "number", description: "WACC or discount rate in percentage points." },
                    perpetualGrowthPct: { type: "number", description: "Perpetual growth rate in percentage points." },
                    netDebt: { type: "number", description: "Debt minus cash and non-operating investments, in the same units as revenue." },
                    dilutedShares: { type: "number", description: "Diluted shares in units consistent with the desired per-share output." },
                },
                required: ["revenue", "dilutedShares"],
                additionalProperties: false,
            },
            handler: async (args = {}) => {
                const base = calculateDcf(args);
                return {
                    fetchedAt: new Date().toISOString(),
                    workerNodeId: workerNodeId || null,
                    units: "All currency values use the same unit supplied for revenue and netDebt.",
                    ...base,
                    sensitivity: dcfSensitivity(args, base),
                };
            },
        },
    ],
};

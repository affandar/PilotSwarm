import type {
    JobDiscovery,
    JobGeneratorDefinitionRow,
    JobGeneratorRow,
    JobGeneratorSourceType,
} from "pilotswarm-sdk";
import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const AZURE_DEVOPS_SCOPE = "499b84ac-1321-427f-aa17-267ca6975798/.default";
const ICM_MCP_ENDPOINT = "https://icm-mcp-prod.azure-api.net/v1/";
const ICM_MCP_SCOPE = "api://icmmcpapi-prod/.default";
const ICM_MAX_PAGES = 100;
const ICM_SESSION_CLOSE_TIMEOUT_MS = 10_000;
const execFileAsync = promisify(execFile);

interface AdoProjectDefaults {
    organization: string;
    project: string;
}

type AdoDefaultsResolver = () => Promise<AdoProjectDefaults>;

let cachedAdoDefaults: Promise<AdoProjectDefaults> | undefined;

function organizationName(value: string): string {
    try {
        const url = new URL(value);
        if (url.hostname.toLowerCase() === "dev.azure.com") {
            return decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] || "");
        }
        if (url.hostname.toLowerCase().endsWith(".visualstudio.com")) {
            return url.hostname.split(".")[0];
        }
    } catch {
        // A plain organization name is already in the desired form.
    }
    return value.trim();
}

async function resolveAdoDefaultsFromCli(): Promise<AdoProjectDefaults> {
    cachedAdoDefaults ??= (async () => {
        const { stdout } = process.platform === "win32"
            ? await execFileAsync(
                process.env.ComSpec || "cmd.exe",
                ["/d", "/s", "/c", "az devops configure -l"],
                { windowsHide: true },
            )
            : await execFileAsync("az", ["devops", "configure", "-l"]);
        const values = new Map<string, string>();
        for (const line of stdout.split(/\r?\n/)) {
            const match = /^\s*([a-z_]+)\s*=\s*(.*?)\s*$/i.exec(line);
            if (match) values.set(match[1].toLowerCase(), match[2]);
        }
        const organization = organizationName(values.get("organization") || "");
        const project = values.get("project")?.trim() || "";
        if (!organization || !project) {
            throw new Error(
                "Azure DevOps defaults are incomplete; configure both organization and project",
            );
        }
        return { organization, project };
    })();
    return cachedAdoDefaults;
}

export interface EvaluationResult {
    discoveries: JobDiscovery[];
    watermark?: unknown;
}

export interface EvaluationContext {
    generator: JobGeneratorRow;
    definition: JobGeneratorDefinitionRow;
    watermark: unknown;
}

export interface SourceEvaluator {
    readonly type: JobGeneratorSourceType;
    evaluate(context: EvaluationContext): Promise<EvaluationResult>;
}

export type FetchLike = typeof fetch;

interface HttpEvaluatorOptions {
    endpoint?: string;
    token?: string;
    fetch?: FetchLike;
}

interface AdoWiqlEvaluatorOptions extends HttpEvaluatorOptions {
    direct?: boolean;
    credential?: TokenCredential;
    defaultsResolver?: AdoDefaultsResolver;
}

interface IcmEvaluatorOptions extends HttpEvaluatorOptions {
    direct?: boolean;
    credential?: TokenCredential;
    maxPages?: number;
    sessionCloseTimeoutMs?: number;
}

abstract class HttpSourceEvaluator implements SourceEvaluator {
    abstract readonly type: JobGeneratorSourceType;
    protected readonly endpoint?: string;
    protected readonly token?: string;
    protected readonly fetchImpl: FetchLike;

    constructor(options: HttpEvaluatorOptions) {
        this.endpoint = options.endpoint?.trim() || undefined;
        this.token = options.token?.trim() || undefined;
        this.fetchImpl = options.fetch ?? fetch;
    }

    async evaluate(context: EvaluationContext): Promise<EvaluationResult> {
        if (!this.endpoint) throw new Error(`${this.constructor.name} endpoint is required`);
        const response = await this.fetchImpl(this.endpoint, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
            },
            body: JSON.stringify({
                generatorId: context.generator.generatorId,
                definitionId: context.definition.definitionId,
                config: context.definition.sourceConfig,
                watermark: context.watermark,
            }),
        });
        if (!response.ok) {
            throw new Error(`${this.type} evaluator request failed: HTTP ${response.status} ${await response.text()}`);
        }
        return this.parse(await response.json(), context.definition.sourceConfig);
    }

    protected abstract parse(body: unknown, config: Record<string, unknown>): EvaluationResult;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function stableKey(value: unknown, label: string): string {
    const key = String(value ?? "").trim();
    if (!key) throw new Error(`${label} result is missing a stable key`);
    return key;
}

function arrayFrom(body: Record<string, unknown>, names: string[]): unknown[] {
    for (const name of names) {
        if (Array.isArray(body[name])) return body[name] as unknown[];
    }
    return [];
}

export function parseAdoWiqlResponse(body: unknown): EvaluationResult {
    const root = record(body);
    const rows = arrayFrom(root, ["workItems", "value", "items"]);
    return {
        discoveries: rows.map((value) => {
            const item = record(value);
            const fields = record(item.fields);
            return {
                key: stableKey(item.id ?? item.key ?? fields["System.Id"], "ADO WIQL"),
                payload: item,
            };
        }),
        watermark: root.watermark,
    };
}

export function parseIcmResponse(body: unknown): EvaluationResult {
    const root = record(body);
    if (root.success === false) {
        throw new Error(`IcM search failed: ${String(root.error ?? root.message ?? "unknown error")}`);
    }
    const rows = arrayFrom(root, ["incidents", "value", "items"]);
    return {
        discoveries: rows.map((value) => {
            const item = record(value);
            return {
                key: stableKey(
                    item.incidentId ?? item.IncidentId ?? item.incident_id ?? item.id ?? item.key,
                    "IcM",
                ),
                payload: item,
            };
        }),
        watermark: root.watermark,
    };
}

export function parseKustoResponse(body: unknown, keyColumn = "key"): EvaluationResult {
    const root = record(body);
    const directRows = arrayFrom(root, ["items", "value"]);
    if (directRows.length > 0) {
        return {
            discoveries: directRows.map((value) => {
                const item = record(value);
                return {
                    key: stableKey(item[keyColumn] ?? item.key ?? item.id, "Kusto"),
                    payload: item,
                };
            }),
            watermark: root.watermark,
        };
    }

    const table = record(arrayFrom(root, ["Tables", "tables"])[0]);
    const columns = arrayFrom(table, ["Columns", "columns"]).map((column) => {
        const value = record(column);
        return String(value.ColumnName ?? value.columnName ?? value.name ?? "");
    });
    const rows = arrayFrom(table, ["Rows", "rows"]);
    return {
        discoveries: rows.map((rowValue) => {
            if (!Array.isArray(rowValue)) throw new Error("Kusto table row must be an array");
            const payload = Object.fromEntries(columns.map((column, index) => [column, rowValue[index]]));
            return {
                key: stableKey(payload[keyColumn] ?? payload.key ?? payload.id, "Kusto"),
                payload,
            };
        }),
        watermark: root.watermark,
    };
}

export class AdoWiqlEvaluator extends HttpSourceEvaluator {
    readonly type = "ado_wiql" as const;
    private readonly direct: boolean;
    private readonly credential?: TokenCredential;
    private readonly defaultsResolver: AdoDefaultsResolver;

    constructor(options: AdoWiqlEvaluatorOptions) {
        super(options);
        this.direct = options.direct ?? !this.endpoint;
        this.credential = options.credential;
        this.defaultsResolver = options.defaultsResolver ?? resolveAdoDefaultsFromCli;
    }

    override async evaluate(context: EvaluationContext): Promise<EvaluationResult> {
        if (!this.direct) return super.evaluate(context);
        const wiql = typeof context.definition.sourceConfig.wiql === "string"
            ? context.definition.sourceConfig.wiql.trim()
            : "";
        if (!wiql) throw new Error("ADO WIQL definition requires sourceConfig.wiql");
        let organization = typeof context.definition.sourceConfig.organization === "string"
            ? context.definition.sourceConfig.organization.trim()
            : "";
        let project = typeof context.definition.sourceConfig.project === "string"
            ? context.definition.sourceConfig.project.trim()
            : "";
        if (!this.endpoint && (!organization || !project)) {
            const defaults = await this.defaultsResolver();
            organization ||= defaults.organization;
            project ||= defaults.project;
        }
        const endpoint = this.endpoint || (
            organization && project
                ? `https://dev.azure.com/${encodeURIComponent(organizationName(organization))}/${encodeURIComponent(project)}/_apis/wit/wiql?api-version=7.1`
                : ""
        );
        if (!endpoint) {
            throw new Error(
                "ADO WIQL requires sourceConfig organization/project or configured az devops defaults",
            );
        }
        const headers: Record<string, string> = { "content-type": "application/json" };
        const credentialToken = this.token
            ? undefined
            : await this.credential?.getToken(AZURE_DEVOPS_SCOPE);
        const token = this.token ?? credentialToken?.token;
        if (token) headers.authorization = "Bearer ".concat(token);
        const response = await this.fetchImpl(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({ query: wiql }),
        });
        if (!response.ok) {
            throw new Error(`ado_wiql evaluator request failed: HTTP ${response.status} ${await response.text()}`);
        }
        return parseAdoWiqlResponse(await response.json());
    }

    protected parse(body: unknown): EvaluationResult {
        return parseAdoWiqlResponse(body);
    }
}

function mcpToolBody(result: Record<string, unknown>): Record<string, unknown> {
    if (result.isError === true) {
        const message = Array.isArray(result.content)
            ? result.content
                .map((value) => record(value).text)
                .filter((value): value is string => typeof value === "string")
                .join("\n")
            : "";
        throw new Error(`IcM MCP search_incidents failed: ${message || "tool error"}`);
    }
    const structured = record(result.structuredContent);
    if (Object.keys(structured).length > 0) return structured;
    if (Array.isArray(result.content)) {
        for (const value of result.content) {
            const block = record(value);
            if (block.type !== "text" || typeof block.text !== "string") continue;
            try {
                const parsed = record(JSON.parse(block.text));
                if (Object.keys(parsed).length > 0) return parsed;
            } catch {
                // Continue looking for a structured JSON content block.
            }
        }
    }
    throw new Error("IcM MCP search_incidents returned no structured response");
}

function icmSearchRequest(config: Record<string, unknown>): Record<string, unknown> {
    const nested = record(config.incidentAdvancedSearchRequest);
    const request = Object.keys(nested).length > 0 ? nested : config;
    if (Object.keys(request).length === 0) {
        throw new Error("IcM definition requires sourceConfig search filters");
    }
    return { ...request };
}

async function withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    label: string,
    onTimeout?: () => void,
): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<T>((_resolve, reject) => {
                timer = setTimeout(() => {
                    onTimeout?.();
                    reject(new Error(`${label} timed out after ${timeoutMs}ms`));
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export class IcmEvaluator extends HttpSourceEvaluator {
    readonly type = "icm" as const;
    private readonly direct: boolean;
    private readonly credential?: TokenCredential;
    private readonly mcpEndpoint: string;
    private readonly maxPages: number;
    private readonly sessionCloseTimeoutMs: number;

    constructor(options: IcmEvaluatorOptions = {}) {
        super(options);
        this.direct = options.direct ?? !this.endpoint;
        this.credential = options.credential
            ?? (this.direct && !this.token ? new DefaultAzureCredential() : undefined);
        this.mcpEndpoint = this.endpoint ?? ICM_MCP_ENDPOINT;
        this.maxPages = options.maxPages ?? ICM_MAX_PAGES;
        this.sessionCloseTimeoutMs = options.sessionCloseTimeoutMs
            ?? ICM_SESSION_CLOSE_TIMEOUT_MS;
        if (!Number.isInteger(this.maxPages) || this.maxPages <= 0) {
            throw new Error("IcM maxPages must be a positive integer");
        }
        if (!Number.isInteger(this.sessionCloseTimeoutMs) || this.sessionCloseTimeoutMs <= 0) {
            throw new Error("IcM sessionCloseTimeoutMs must be a positive integer");
        }
    }

    override async evaluate(context: EvaluationContext): Promise<EvaluationResult> {
        if (!this.direct) return super.evaluate(context);
        const baseRequest = icmSearchRequest(context.definition.sourceConfig);
        const credentialToken = this.token
            ? undefined
            : await this.credential?.getToken(ICM_MCP_SCOPE);
        const token = this.token ?? credentialToken?.token;
        if (!token) throw new Error("IcM MCP authentication did not return an access token");

        const headers: Record<string, string> = {
            accept: "application/json, text/event-stream",
            authorization: "Bearer ".concat(token),
            "content-type": "application/json",
        };
        let result: EvaluationResult | undefined;
        let evaluationError: unknown;
        const transport = new StreamableHTTPClientTransport(new URL(this.mcpEndpoint), {
            requestInit: { headers },
            fetch: this.fetchImpl,
        });
        const client = new McpClient({
            name: "PilotSwarm-JobGenerator",
            version: "0.1.0",
        });
        try {
            await client.connect(transport);
            const discoveries: JobDiscovery[] = [];
            const seenTokens = new Set<string>();
            const configuredMaxItems = Number(
                context.definition.guardrails.maxItemsPerCycle ?? 0,
            );
            const maxItems = Number.isFinite(configuredMaxItems) && configuredMaxItems > 0
                ? configuredMaxItems
                : undefined;
            let nextPageToken = typeof baseRequest.nextPageToken === "string"
                ? baseRequest.nextPageToken
                : undefined;
            if (nextPageToken) seenTokens.add(nextPageToken);
            let pageCount = 0;
            do {
                pageCount += 1;
                if (pageCount > this.maxPages) {
                    throw new Error(`IcM search exceeded the ${this.maxPages}-page limit`);
                }
                const configuredTop = Number(baseRequest.top);
                const requestedTop = Number.isInteger(configuredTop) && configuredTop > 0
                    ? configuredTop
                    : undefined;
                const boundedTop = maxItems === undefined
                    ? requestedTop
                    : Math.min(
                        requestedTop ?? maxItems + 1,
                        maxItems - discoveries.length + 1,
                    );
                const request = {
                    ...baseRequest,
                    ...(boundedTop ? { top: boundedTop } : {}),
                    ...(nextPageToken ? { nextPageToken } : {}),
                };
                const response = await client.callTool({
                    name: "search_incidents",
                    arguments: {
                        incidentAdvancedSearchRequest: request,
                    },
                });
                const page = mcpToolBody(response as Record<string, unknown>);
                discoveries.push(...parseIcmResponse(page).discoveries);
                if (maxItems !== undefined && discoveries.length > maxItems) {
                    throw new Error(
                        `IcM query returned more than maxItemsPerCycle=${maxItems}`,
                    );
                }
                const tokenValue = typeof page.nextPageToken === "string" && page.nextPageToken.trim()
                    ? page.nextPageToken.trim()
                    : undefined;
                if (!tokenValue) {
                    nextPageToken = undefined;
                    break;
                }
                if (seenTokens.has(tokenValue)) {
                    throw new Error("IcM MCP returned a repeated pagination token");
                }
                seenTokens.add(tokenValue);
                nextPageToken = tokenValue;
                if (maxItems !== undefined && discoveries.length >= maxItems) {
                    throw new Error(
                        `IcM query returned more than maxItemsPerCycle=${maxItems}`,
                    );
                }
            } while (nextPageToken);
            result = { discoveries };
        } catch (error) {
            evaluationError = error;
        }

        let closeError: unknown;
        const cleanupErrors: unknown[] = [];
        const sessionId = transport.sessionId;
        if (sessionId) {
            const closeController = new AbortController();
            try {
                const closeOperation = (async () => {
                    const response = await this.fetchImpl(this.mcpEndpoint, {
                        method: "DELETE",
                        headers: {
                            ...headers,
                            "mcp-session-id": sessionId,
                            ...(transport.protocolVersion
                                ? { "mcp-protocol-version": transport.protocolVersion }
                                : {}),
                        },
                        signal: closeController.signal,
                    });
                    await response.body?.cancel();
                    if (!response.ok && response.status !== 405) {
                        throw new Error(`IcM MCP session close failed: HTTP ${response.status}`);
                    }
                })();
                await withTimeout(
                    closeOperation,
                    this.sessionCloseTimeoutMs,
                    "IcM MCP session close",
                    () => closeController.abort(),
                );
            } catch (error) {
                cleanupErrors.push(error);
            }
        }
        try {
            await client.close();
        } catch (error) {
            cleanupErrors.push(error);
        }
        if (cleanupErrors.length === 1) closeError = cleanupErrors[0];
        if (cleanupErrors.length > 1) {
            closeError = new AggregateError(cleanupErrors, "IcM MCP session cleanup failed");
        }
        if (evaluationError && closeError) {
            throw new AggregateError(
                [evaluationError, closeError],
                "IcM evaluation and MCP session cleanup both failed",
            );
        }
        if (evaluationError) throw evaluationError;
        if (closeError) throw closeError;
        return result!;
    }

    protected parse(body: unknown): EvaluationResult {
        return parseIcmResponse(body);
    }
}

export class KustoEvaluator extends HttpSourceEvaluator {
    readonly type = "kusto" as const;
    protected parse(body: unknown, config: Record<string, unknown>): EvaluationResult {
        const keyColumn = typeof config.keyColumn === "string" && config.keyColumn.trim()
            ? config.keyColumn.trim()
            : "key";
        return parseKustoResponse(body, keyColumn);
    }
}

export function createEvaluatorsFromEnv(
    env: NodeJS.ProcessEnv = process.env,
    fetchImpl?: FetchLike,
): Map<JobGeneratorSourceType, SourceEvaluator> {
    const evaluators = new Map<JobGeneratorSourceType, SourceEvaluator>();
    const adoEndpoint = env.JOBGEN_ADO_WIQL_ENDPOINT?.trim() || undefined;
    const adoDirect = adoEndpoint
        ? ["1", "true", "yes", "on"].includes(
            (env.JOBGEN_ADO_WIQL_DIRECT || "").trim().toLowerCase(),
        )
        : true;
    evaluators.set("ado_wiql", new AdoWiqlEvaluator({
        endpoint: adoEndpoint,
        token: env.JOBGEN_ADO_WIQL_TOKEN,
        direct: adoDirect,
        credential: adoDirect && !env.JOBGEN_ADO_WIQL_TOKEN?.trim()
            ? new DefaultAzureCredential()
            : undefined,
        fetch: fetchImpl,
    }));
    const icmEndpoint = env.JOBGEN_ICM_ENDPOINT?.trim() || undefined;
    const icmDirect = icmEndpoint
        ? ["1", "true", "yes", "on"].includes(
            (env.JOBGEN_ICM_DIRECT || "").trim().toLowerCase(),
        )
        : true;
    evaluators.set("icm", new IcmEvaluator({
        endpoint: icmEndpoint,
        token: env.JOBGEN_ICM_TOKEN,
        direct: icmDirect,
        credential: icmDirect && !env.JOBGEN_ICM_TOKEN?.trim()
            ? new DefaultAzureCredential()
            : undefined,
        fetch: fetchImpl,
    }));
    if (env.JOBGEN_KUSTO_ENDPOINT?.trim()) {
        evaluators.set("kusto", new KustoEvaluator({
            endpoint: env.JOBGEN_KUSTO_ENDPOINT,
            token: env.JOBGEN_KUSTO_TOKEN,
            fetch: fetchImpl,
        }));
    }
    return evaluators;
}

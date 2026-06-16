/**
 * Horizon Harvester — Mock Knowledge Source
 *
 * A tiny, deterministic "documentation site" for a fictional company
 * (Northwind Robotics). The harvester agent ingests these documents into the
 * durable facts store and builds a knowledge graph from the entities and
 * relationships they describe; the librarian agent answers questions over the
 * result. No real network calls.
 *
 * Register on the worker with: worker.registerTools(createSourceTools())
 */

import { defineTool } from "pilotswarm-sdk";

// ─── Mock documentation corpus ───────────────────────────────────
// Each document embeds a few clear entities (services, teams, people) and
// relationships (ownership, leadership, dependencies) so the harvester has
// something concrete to extract into graph nodes and edges.

const DOCUMENTS = [
    {
        id: "svc-checkout-api",
        title: "Service: checkout-api",
        content: [
            "checkout-api is the customer-facing checkout service for Northwind Robotics.",
            "It is owned by the Platform team. checkout-api depends on inventory-svc for",
            "stock checks and on telemetry-pipeline for emitting order events.",
            "On-call rotation is led by the Platform team lead, Dana Reyes.",
        ].join(" "),
    },
    {
        id: "svc-inventory",
        title: "Service: inventory-svc",
        content: [
            "inventory-svc tracks warehouse stock levels for Northwind Robotics.",
            "It is owned by the Fulfillment team. inventory-svc depends on",
            "robotics-control to reconcile physical counts from the warehouse robots.",
            "The Fulfillment team is led by Marcus Lin.",
        ].join(" "),
    },
    {
        id: "svc-robotics-control",
        title: "Service: robotics-control",
        content: [
            "robotics-control coordinates the autonomous warehouse robots.",
            "It is owned by the Hardware team and is led operationally by Priya Nair.",
            "robotics-control depends on telemetry-pipeline to stream sensor data.",
        ].join(" "),
    },
    {
        id: "svc-telemetry",
        title: "Service: telemetry-pipeline",
        content: [
            "telemetry-pipeline ingests events and sensor data across Northwind Robotics.",
            "It is owned by the Platform team. Many services depend on it, including",
            "checkout-api and robotics-control. The Platform team is led by Dana Reyes.",
        ].join(" "),
    },
    {
        id: "team-overview",
        title: "Team Directory",
        content: [
            "Northwind Robotics has three engineering teams. The Platform team owns",
            "checkout-api and telemetry-pipeline and is led by Dana Reyes. The Fulfillment",
            "team owns inventory-svc and is led by Marcus Lin. The Hardware team owns",
            "robotics-control and is led by Priya Nair.",
        ].join(" "),
    },
];

const DOC_BY_ID = new Map(DOCUMENTS.map((d) => [d.id, d]));

export function createSourceTools() {
    return [
        defineTool("list_knowledge_sources", {
            description:
                "List the documents available in the Northwind Robotics knowledge source. " +
                "Returns an array of { id, title }. Use this first, then fetch each one.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            handler: async () => {
                return {
                    documents: DOCUMENTS.map(({ id, title }) => ({ id, title })),
                };
            },
        }),

        defineTool("fetch_knowledge_source", {
            description:
                "Fetch the full text of one knowledge-source document by id. " +
                "Returns { id, title, content }.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string", description: "Document id from list_knowledge_sources." },
                },
                required: ["id"],
                additionalProperties: false,
            },
            handler: async ({ id }) => {
                const doc = DOC_BY_ID.get(id);
                if (!doc) {
                    return { error: `Unknown document id "${id}". Call list_knowledge_sources first.` };
                }
                return doc;
            },
        }),
    ];
}

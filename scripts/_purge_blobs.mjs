#!/usr/bin/env node
import { BlobServiceClient } from "@azure/storage-blob";

const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
const container = process.env.AZURE_STORAGE_CONTAINER || "copilot-sessions";
if (!connStr) { console.error("No AZURE_STORAGE_CONNECTION_STRING"); process.exit(1); }

const svc = BlobServiceClient.fromConnectionString(connStr);
const ctr = svc.getContainerClient(container);
let count = 0;
for await (const blob of ctr.listBlobsFlat()) {
    await ctr.deleteBlob(blob.name);
    count++;
}
console.log(`Purged ${count} blobs from ${container}`);

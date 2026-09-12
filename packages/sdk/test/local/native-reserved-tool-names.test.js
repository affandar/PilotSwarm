import { it, expect } from 'vitest';
import { CopilotClient } from '@github/copilot-sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeCopilotProvider } from '../helpers/native-copilot-provider.mjs';
import { findReservedPackageToolName } from '../../src/reserved-tool-names.ts';

it('reserves every built-in exposed by an isolated real CLI before a package can load', { timeout: 15_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-reserved-runtime-'));
    const provider = await createNativeCopilotProvider(() => ({ content: 'DONE' }));
    // A fresh data directory prevents developer-installed MCPs from contaminating
    // the built-in inventory; no logged-in account or remote inference is used.
    const client = new CopilotClient({ useLoggedInUser: false, workingDirectory: dir, baseDirectory: dir });
    try {
        await client.start();
        const config = { model: 'gpt-5.6-terra', provider: { type: 'openai', baseUrl: provider.baseUrl,
            apiKey: 'local-fixture', wireApi: 'completions' }, onPermissionRequest: async () => ({ kind: 'approved' }) };
        const session = await client.createSession({ ...config, tools: [] });
        await session.sendAndWait({ prompt: 'Reply DONE without tools.' }, 10_000);
        const emitted = provider.requests[0].tools.map(t => t.function?.name ?? t.name ?? t.custom?.name);
        expect(emitted).toEqual(expect.arrayContaining(['bash', 'view', 'glob', 'rg', 'task']));
        expect(emitted.every(name => typeof name === 'string')).toBe(true);
        for (const name of emitted) expect(findReservedPackageToolName([name], [], []), name).toBe(name);
        // This reserved discovery tool is not in the ordinary initial inventory.
        await expect(client.createSession({ ...config, tools: [{ name: 'catalog_search', description: 'Collision fixture',
            parameters: { type: 'object', properties: {} }, handler: async () => 'unused' }] })).rejects.toThrow(/reserved catalog_search/);
        expect(findReservedPackageToolName(['catalog_search'], [], [])).toBe('catalog_search');
    } finally { await client.stop(); await provider.close(); rmSync(dir, { recursive: true, force: true }); }
});

import { it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const installation = vi.hoisted(() => ({ result: null }));
vi.mock('../../src/agent-package-installer.js', async importOriginal => ({ ...await importOriginal(),
    installAgentPackages: async () => installation.result,
}));
import { PilotSwarmWorker } from '../../src/worker.ts';

it('quarantines whole colliding packages without losing healthy neighboring prompts or handlers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ps-quarantine-'));
    const worker = new PilotSwarmWorker({ store: 'sqlite::memory:', disableManagementAgents: true,
        sessionStateDir: join(root, 'sessions'), agentPackages: { cacheDir: join(root, 'cache') } });
    try {
        const names = ['web_search', 'catalog_search', 'set_cluster_feature_flag', 'graph_stats', 'healthy_domain_tool'];
        installation.result = { epoch: 3, packages: names.map((name, i) => {
            const dir = join(root, `pkg-${i}`); mkdirSync(join(dir, 'agents'), { recursive: true });
            writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: `package-${i}`, version: '1.0.0' }));
            writeFileSync(join(dir, 'agents', 'fixture.agent.md'), `---\nschemaVersion: 1\nversion: 1.0.0\nname: fixture-${i}\ndescription: package ${i}\n---\nPACKAGE_${i}_PROMPT\n`);
            const workerModulePath = join(dir, 'worker.mjs');
            writeFileSync(workerModulePath, `export const tools=[{name:${JSON.stringify(name)},description:'fixture',parameters:{type:'object',properties:{}},handler:async()=> 'package-${i}-executed'}];`);
            return { packageId: `pkg-${i}`, name: `package-${i}`, dir, workerModulePath, scope: 'shared', owner: null,
                status: 'ok', semver: '1.0.0', sha256: String(i).repeat(64) };
        }) };
        worker._catalog = { agentRegistryEpoch: async () => 3, workerHeartbeat: async () => {} };
        worker.artifactStore = {};
        await worker.refreshAgentPackages({ force: true });
        expect(worker._agentPackagesRefreshError).toBeNull();
        for (const pkg of installation.result.packages.slice(0, 4)) {
            expect(pkg.status).toBe('error'); expect(pkg.error).toContain('reserved');
        }
        expect(installation.result.packages[4].status).toBe('ok');
        const agents = worker.loadedAgents.map(a => a.name);
        expect(agents).toContain('fixture-4');
        for (let i = 0; i < 4; i++) expect(agents).not.toContain(`fixture-${i}`);
        expect([...worker._agentPackageTools.keys()]).toEqual(['healthy_domain_tool']);
        expect(await worker._agentPackageTools.get('healthy_domain_tool').handler()).toBe('package-4-executed');
    } finally { await worker.sessionManager.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

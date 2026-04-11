import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_UI_PACKAGES = ["pilotswarm-ui-core", "pilotswarm-ui-react"];

function copyTree(sourceDir, targetDir) {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        const sourcePath = path.join(sourceDir, entry.name);
        const targetPath = path.join(targetDir, entry.name);
        if (entry.isDirectory()) {
            copyTree(sourcePath, targetPath);
            continue;
        }
        fs.copyFileSync(sourcePath, targetPath);
    }
}

export function syncBundledWorkspaceUiPackages({ cliPackageDir = path.resolve(__dirname, "..") } = {}) {
    const packagesDir = path.resolve(cliPackageDir, "..");
    const syncedPackages = [];

    for (const packageName of BUNDLED_UI_PACKAGES) {
        const workspaceDir = path.join(packagesDir, packageName.replace("pilotswarm-", ""));
        const sourcePackageJson = path.join(workspaceDir, "package.json");
        const sourceReadme = path.join(workspaceDir, "README.md");
        const sourceSrcDir = path.join(workspaceDir, "src");
        if (!fs.existsSync(sourcePackageJson) || !fs.existsSync(sourceSrcDir)) {
            continue;
        }

        const targetDir = path.join(cliPackageDir, "node_modules", packageName);
        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.mkdirSync(targetDir, { recursive: true });
        fs.copyFileSync(sourcePackageJson, path.join(targetDir, "package.json"));
        if (fs.existsSync(sourceReadme)) {
            fs.copyFileSync(sourceReadme, path.join(targetDir, "README.md"));
        }
        copyTree(sourceSrcDir, path.join(targetDir, "src"));
        syncedPackages.push(packageName);
    }

    return syncedPackages;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const syncedPackages = syncBundledWorkspaceUiPackages();
    if (syncedPackages.length > 0) {
        console.log(`[sync-workspace-ui] synced ${syncedPackages.join(", ")}`);
    }
}

// Image build component (Phase 2, FR-006).
//
// docker buildx build --platform linux/amd64 --load → docker save → in-process
// zlib gzip → <staging>/<dockerImageRepo>.tar.gz. Output filename matches
// EV2's <repo>.tar.gz (CodeResearch Q4) so downstream tooling sees the same shape.

import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { join } from "node:path";
import { createGzip } from "node:zlib";
import { resolveCli, log, run, REPO_ROOT } from "./common.mjs";
import { SERVICE_IMAGE_INFO } from "./service-info.mjs";

// Build a service image and write a gzipped OCI/docker tarball to the staging dir.
// Returns the absolute path to the .tar.gz on disk.
export async function buildImage({ service, envName, imageTag, stagingDir: stage }) {
  const info = SERVICE_IMAGE_INFO[service];
  if (!info) {
    throw new Error(
      `Service '${service}' has no image to build (only worker/portal have container images).`,
    );
  }
  const { dockerImageRepo, dockerfile } = info;
  const localTag = `${dockerImageRepo}:${imageTag}`;
  const dockerfileAbs = join(REPO_ROOT, dockerfile);
  if (!existsSync(dockerfileAbs)) {
    throw new Error(`Dockerfile not found: ${dockerfileAbs}`);
  }

  // 0) Ensure host SDK dist exists. Dockerfile.worker copies
  // `packages/sdk/dist/` from the host (the npm-published image shape), so we
  // must compile TypeScript before `docker buildx build`. Build only the
  // service's required workspace (e.g. SDK for worker) — a full
  // `npm run build` would also try to build the portal/vite bundle, which
  // brings in extra Node-version constraints unrelated to this service.
  // Use run() (not runForeground) so Windows npm.cmd is wrapped via cmd.exe.
  const buildWorkspaces = info.buildWorkspaces ?? ["packages/sdk"];
  const tscMarker = join(REPO_ROOT, "node_modules", "typescript", "package.json");
  if (!existsSync(tscMarker)) {
    throw new Error(
      "TypeScript devDependency not found at node_modules/typescript.\n" +
        "Deploy build needs the SDK compiled (Dockerfile.worker copies packages/sdk/dist/).\n" +
        "Run from the repo root:\n" +
        "  npm install\n" +
        "Then re-run deploy.",
    );
  }
  for (const ws of buildWorkspaces) {
    log("info", `npm run build -w ${ws}`);
    run("npm", ["run", "build", "-w", ws]);
  }

  // 1) docker buildx build (platform pinned per repo Docker convention).
  log("info", `docker buildx build → ${localTag}`);
  await runForeground("docker", [
    "buildx",
    "build",
    "--platform",
    "linux/amd64",
    "--load",
    "-t",
    localTag,
    "-f",
    dockerfileAbs,
    REPO_ROOT,
  ]);

  // 2) docker save | zlib gzip → <staging>/<repo>.tar.gz (no host gzip CLI).
  const outPath = join(stage, `${dockerImageRepo}.tar.gz`);
  log("info", `docker save | zlib gzip → ${outPath}`);
  await pipedSaveToGzip(localTag, outPath);
  return outPath;
}

// runForeground: spawn with inherited stdio, no shell, no batch-file weirdness
// expected here (docker is a real .exe on Windows). Throws on non-zero exit.
function runForeground(name, args) {
  return new Promise((resolve, reject) => {
    const cli = resolveCli(name);
    const child = spawn(cli, args, {
      shell: false,
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} ${args.join(" ")} exited ${code}`));
    });
  });
}

// Pipe `docker save <tag>` stdout through zlib.createGzip() into a write stream.
// In-process compression — no host gzip / gunzip dependency (FR-006, repo
// instruction "no host gzip CLI required").
function pipedSaveToGzip(localTag, outPath) {
  return new Promise((resolve, reject) => {
    const docker = spawn(resolveCli("docker"), ["save", localTag], {
      shell: false,
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const gzip = createGzip();
    const out = createWriteStream(outPath);
    let dockerExit;
    let outFinished = false;
    let settled = false;

    const settle = () => {
      if (settled) return;
      if (dockerExit === undefined || !outFinished) return;
      settled = true;
      if (dockerExit === 0) resolve();
      else reject(new Error(`docker save exited ${dockerExit}`));
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    docker.on("error", fail);
    docker.on("close", (code) => {
      dockerExit = code;
      settle();
    });
    out.on("error", fail);
    out.on("finish", () => {
      outFinished = true;
      settle();
    });
    gzip.on("error", fail);

    docker.stdout.pipe(gzip).pipe(out);
  });
}

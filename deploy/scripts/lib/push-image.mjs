// Image push component (Phase 2, FR-007).
//
// In-process zlib.createGunzip() decompresses <staging>/<repo>.tar.gz to
// <staging>/<repo>.tar (no host `gunzip` CLI required), then passes the .tar
// directly to `oras cp --from-oci-layout <tar>:<tag> <acr>/<repo>:<tag>`
// (matches deploy/services/common/scripts/UploadContainer.sh:31 reference shape).
//
// Authenticates first via `az acr login --name <acrName>`. EC-7: aborts with
// a copy-pasteable hint if the prerequisite tarball is missing.

import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { run, log } from "./common.mjs";
import { SERVICE_IMAGE_INFO } from "./service-info.mjs";

export async function pushImage({ service, envName, imageTag, env, stagingDir: stage }) {
  const info = SERVICE_IMAGE_INFO[service];
  if (!info) {
    throw new Error(
      `Service '${service}' has no image to push (only worker/portal have container images).`,
    );
  }
  const { dockerImageRepo } = info;

  const acrName = env.ACR_NAME;
  const acrLoginServer = env.ACR_LOGIN_SERVER;
  if (!acrName || !acrLoginServer) {
    throw new Error(
      "ACR_NAME and ACR_LOGIN_SERVER must be set in the env map.\n" +
        "Either run --steps bicep first (BaseInfra outputs populate them), or seed them\n" +
        "in deploy/envs/local/<env>/env (FR-021).",
    );
  }

  const gzPath = join(stage, `${dockerImageRepo}.tar.gz`);
  if (!existsSync(gzPath)) {
    // EC-7: missing prerequisite tarball.
    throw new Error(
      `Image tarball not found at ${gzPath}.\n` +
        `Run --steps build first:\n` +
        `  npm run deploy -- ${service} ${envName} --steps build,push`,
    );
  }
  const tarPath = join(stage, `${dockerImageRepo}.tar`);

  log("info", `zlib gunzip → ${tarPath}`);
  await gunzipFile(gzPath, tarPath);

  log("info", `az acr login --name ${acrName}`);
  run("az", ["acr", "login", "--name", acrName]);

  const dest = `${acrLoginServer}/${dockerImageRepo}:${imageTag}`;
  log("info", `oras cp --from-oci-layout ${tarPath}:${imageTag} → ${dest}`);
  run("oras", ["cp", "--from-oci-layout", `${tarPath}:${imageTag}`, dest]);
  log("ok", `Pushed ${dest}`);
}

// In-process gunzip: avoids any host `gunzip` CLI (matches CodeResearch §7).
function gunzipFile(srcPath, dstPath) {
  return new Promise((resolve, reject) => {
    const src = createReadStream(srcPath);
    const dst = createWriteStream(dstPath);
    const gz = createGunzip();
    src.on("error", reject);
    gz.on("error", reject);
    dst.on("error", reject);
    dst.on("finish", resolve);
    src.pipe(gz).pipe(dst);
  });
}

import { access } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

async function exists(url) {
  try {
    await access(fileURLToPath(url));
    return true;
  } catch {
    return false;
  }
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
    const tsUrl = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
    if (await exists(tsUrl)) {
      return { url: tsUrl.href, shortCircuit: true };
    }
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const url = new URL(specifier, context.parentURL ?? pathToFileURL(process.cwd()).href);
    if (url.pathname.endsWith(".ts") && await exists(url)) {
      return { url: url.href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

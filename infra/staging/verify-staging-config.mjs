import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StagingManifestError, verifyRenderedConfigs } from "./render-staging-config.mjs";

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const manifestPath = option(args, "--manifest");
  const outDir = option(args, "--out-dir");
  const intent = option(args, "--intent") || "dry-run";
  if (!manifestPath || !outDir) throw new Error("usage: node infra/staging/verify-staging-config.mjs --manifest <path> --out-dir <path> --intent <dry-run|deploy>");
  const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
  const paths = await verifyRenderedConfigs(manifest, resolve(outDir), intent);
  process.stdout.write(`${paths.join("\n")}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof StagingManifestError ? error.code : error.message}\n`);
    process.exitCode = 1;
  });
}

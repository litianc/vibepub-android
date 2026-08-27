#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = process.env.VIBEPUB_REPOSITORY_ROOT
  ? path.resolve(process.cwd(), process.env.VIBEPUB_REPOSITORY_ROOT)
  : path.resolve(scriptDirectory, "..");
const configuredVersionFile = process.env.VIBEPUB_ANDROID_VERSION_FILE;
const versionFile = configuredVersionFile
  ? path.resolve(process.cwd(), configuredVersionFile)
  : path.join(repositoryRoot, "android", "version.properties");
const configuredCertificateFile = process.env.VIBEPUB_ANDROID_CERTIFICATE_FILE;
const certificateFile = configuredCertificateFile
  ? path.resolve(process.cwd(), configuredCertificateFile)
  : path.join(repositoryRoot, "android", "release-certificate.sha256");
const maximumAndroidVersionCode = 2_100_000_000;

function parseVersionText(text, source = versionFile) {
  const values = new Map();
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error(`${source}:${index + 1} must use KEY=VALUE syntax`);
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (values.has(key)) throw new Error(`${source}:${index + 1} repeats ${key}`);
    values.set(key, value);
  }

  const allowedKeys = new Set(["VERSION_NAME", "VERSION_CODE"]);
  for (const key of values.keys()) {
    if (!allowedKeys.has(key)) throw new Error(`${source} contains unsupported key ${key}`);
  }

  const versionName = values.get("VERSION_NAME");
  const semanticMatch = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(versionName ?? "");
  if (!semanticMatch) throw new Error(`${source} VERSION_NAME must use major.minor.patch`);

  const versionCodeText = values.get("VERSION_CODE") ?? "";
  if (!/^[1-9]\d*$/.test(versionCodeText)) {
    throw new Error(`${source} VERSION_CODE must be a positive integer`);
  }
  const versionCode = Number(versionCodeText);
  if (!Number.isSafeInteger(versionCode) || versionCode > maximumAndroidVersionCode) {
    throw new Error(`${source} VERSION_CODE must not exceed ${maximumAndroidVersionCode}`);
  }
  return { versionName, versionCode, semanticParts: semanticMatch.slice(1).map(Number) };
}

function readVersion() {
  return parseVersionText(readFileSync(versionFile, "utf8"));
}

function checkVersionCodeIncrease(current, previous, previousLabel) {
  if (current.versionCode <= previous.versionCode) {
    throw new Error(
      `VERSION_CODE ${current.versionCode} must be greater than ${previous.versionCode} from ${previousLabel}`,
    );
  }
  console.log(
    `Android version bump OK: ${previous.versionName} (${previous.versionCode}) -> ` +
      `${current.versionName} (${current.versionCode})`,
  );
}

function readVersionAtGitRef(gitRef) {
  const refCheck = spawnSync("git", ["rev-parse", "--verify", gitRef], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (refCheck.status !== 0) throw new Error(`Git ref '${gitRef}' does not exist`);

  const result = spawnSync("git", ["show", `${gitRef}:android/version.properties`], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return parseVersionText(result.stdout, `${gitRef}:android/version.properties`);
}

function readPublishedManagedVersion(releasesFile) {
  const releases = JSON.parse(readFileSync(releasesFile, "utf8"));
  if (!Array.isArray(releases)) throw new Error(`${releasesFile} must contain a JSON array`);

  const artifactPattern =
    /^VibePub-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-([1-9]\d*)-([0-9a-f]{7,40})\.apk$/;
  let highestVersion = null;
  for (const release of releases) {
    const publishedAt = release?.published_at;
    if (
      release?.draft !== false ||
      typeof publishedAt !== "string" ||
      Number.isNaN(Date.parse(publishedAt)) ||
      !Array.isArray(release.assets)
    ) {
      continue;
    }
    for (const asset of release.assets) {
      if (asset?.state !== "uploaded") continue;
      const match = artifactPattern.exec(asset?.name ?? "");
      if (match) {
        let version;
        try {
          version = parseVersionText(
            `VERSION_NAME=${match[1]}\nVERSION_CODE=${match[2]}\n`,
            asset.name,
          );
        } catch {
          continue;
        }
        if (highestVersion === null || version.versionCode > highestVersion.versionCode) {
          highestVersion = version;
        }
      }
    }
  }
  return highestVersion;
}

function replaceVersion(versionName, versionCode) {
  const updated = readFileSync(versionFile, "utf8")
    .replace(/^\s*VERSION_NAME\s*=.*$/m, `VERSION_NAME=${versionName}`)
    .replace(/^\s*VERSION_CODE\s*=.*$/m, `VERSION_CODE=${versionCode}`);
  writeFileSync(versionFile, updated, "utf8");
}

function resolveGitCommit(value) {
  let commit = value?.trim().toLowerCase();
  if (!commit) {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error("Could not read the current Git commit");
    commit = result.stdout.trim().toLowerCase();
  }
  if (!/^[0-9a-f]{7,40}$/.test(commit)) {
    throw new Error("Git commit must be 7 to 40 hexadecimal characters");
  }
  return commit.slice(0, 12);
}

function artifactName(version, commit) {
  return `VibePub-${version.versionName}-${version.versionCode}-${commit}.apk`;
}

function runApkTool(command, arguments_, label) {
  const result = spawnSync(command, arguments_, { encoding: "utf8" });
  if (result.error) {
    throw new Error(`${label} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    throw new Error(`${label} failed: ${detail}`);
  }
  return result.stdout;
}

function verifyApk(apkPath, gitCommit) {
  if (!existsSync(apkPath)) throw new Error(`APK not found: ${apkPath}`);
  const version = readVersion();
  const commit = resolveGitCommit(gitCommit);
  const expectedFilename = artifactName(version, commit);
  if (path.basename(apkPath) !== expectedFilename) {
    throw new Error(`APK filename ${path.basename(apkPath)} does not match ${expectedFilename}`);
  }

  const aapt = process.env.VIBEPUB_AAPT || "aapt";
  const badging = runApkTool(aapt, ["dump", "badging", apkPath], "aapt badging");
  const versionName = /\bversionName='([^']+)'/.exec(badging)?.[1];
  const versionCodeText = /\bversionCode='([^']+)'/.exec(badging)?.[1];
  if (versionName !== version.versionName) {
    throw new Error(`APK versionName ${versionName ?? "missing"} does not match ${version.versionName}`);
  }
  if (versionCodeText !== String(version.versionCode)) {
    throw new Error(`APK versionCode ${versionCodeText ?? "missing"} does not match ${version.versionCode}`);
  }

  const manifest = runApkTool(
    aapt,
    ["dump", "xmltree", apkPath, "AndroidManifest.xml"],
    "aapt manifest",
  );
  const embeddedCommit =
    /android:name[^\n]*="cn\.litianc\.vibepub\.GIT_COMMIT"[\s\S]{0,500}?android:value[^\n]*="([0-9a-f]{7,40})"/.exec(
      manifest,
    )?.[1];
  if (embeddedCommit !== commit) {
    throw new Error(`APK embedded Git commit ${embeddedCommit ?? "missing"} does not match ${commit}`);
  }

  const expectedFingerprint = readFileSync(certificateFile, "utf8").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedFingerprint)) {
    throw new Error(`${certificateFile} must contain one SHA-256 certificate fingerprint`);
  }
  const apksigner = process.env.VIBEPUB_APKSIGNER || "apksigner";
  const certificateOutput = runApkTool(
    apksigner,
    ["verify", "--print-certs", apkPath],
    "APK signature verification",
  );
  const fingerprints = [
    ...certificateOutput.matchAll(/Signer #\d+ certificate SHA-256 digest:\s*([0-9a-f]{64})/gi),
  ].map((match) => match[1].toLowerCase());
  if (fingerprints.length !== 1 || fingerprints[0] !== expectedFingerprint) {
    throw new Error("APK signing certificate fingerprint does not match the pinned release certificate");
  }

  console.log(`APK identity OK: ${expectedFilename}`);
}

function incrementVersion(version, increment) {
  const [major, minor, patch] = version.semanticParts;
  switch (increment) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
    default:
      throw new Error(`Unknown increment '${increment}'. Use patch, minor, or major.`);
  }
}

function usage() {
  console.log(`Usage:
  node scripts/manage-android-version.mjs show
  node scripts/manage-android-version.mjs check
  node scripts/manage-android-version.mjs bump <patch|minor|major>
  node scripts/manage-android-version.mjs check-against <version-file>
  node scripts/manage-android-version.mjs check-git-ref <git-ref>
  node scripts/manage-android-version.mjs check-releases <releases-json-file>
  node scripts/manage-android-version.mjs artifact-name [git-commit]
  node scripts/manage-android-version.mjs github-output [git-commit]
  node scripts/manage-android-version.mjs verify-apk <apk-path> <git-commit>`);
}

try {
  const [command = "show", argument, secondArgument] = process.argv.slice(2);
  if (command === "show") {
    const version = readVersion();
    console.log(`${version.versionName} (${version.versionCode})`);
  } else if (command === "check") {
    const version = readVersion();
    console.log(`Android version OK: ${version.versionName} (${version.versionCode})`);
  } else if (command === "check-against") {
    if (!argument) throw new Error("check-against requires a version file");
    const baselineFile = path.resolve(process.cwd(), argument);
    checkVersionCodeIncrease(
      readVersion(),
      parseVersionText(readFileSync(baselineFile, "utf8"), baselineFile),
      baselineFile,
    );
  } else if (command === "check-git-ref") {
    if (!argument) throw new Error("check-git-ref requires a git ref");
    const previous = readVersionAtGitRef(argument);
    if (previous === null) {
      console.log(`Android version OK: ${argument} has no managed version file`);
    } else {
      checkVersionCodeIncrease(readVersion(), previous, argument);
    }
  } else if (command === "check-releases") {
    if (!argument) throw new Error("check-releases requires a releases JSON file");
    const releasesFile = path.resolve(process.cwd(), argument);
    const previous = readPublishedManagedVersion(releasesFile);
    if (previous === null) {
      console.log("Android version OK: no published managed Android release");
    } else {
      checkVersionCodeIncrease(readVersion(), previous, "published managed Android releases");
    }
  } else if (command === "artifact-name") {
    console.log(artifactName(readVersion(), resolveGitCommit(argument)));
  } else if (command === "github-output") {
    const version = readVersion();
    const commit = resolveGitCommit(argument);
    console.log(`version_name=${version.versionName}`);
    console.log(`version_code=${version.versionCode}`);
    console.log(`git_commit=${commit}`);
    console.log(`artifact_name=${artifactName(version, commit)}`);
  } else if (command === "verify-apk") {
    if (!argument || !secondArgument) throw new Error("verify-apk requires an APK path and Git commit");
    verifyApk(path.resolve(process.cwd(), argument), secondArgument);
  } else if (command === "bump") {
    if (!argument) throw new Error("bump requires patch, minor, or major");
    const version = readVersion();
    if (version.versionCode >= maximumAndroidVersionCode) {
      throw new Error(`VERSION_CODE cannot exceed ${maximumAndroidVersionCode}`);
    }
    replaceVersion(incrementVersion(version, argument), version.versionCode + 1);
    const updated = readVersion();
    console.log(`${updated.versionName} (${updated.versionCode})`);
  } else if (["help", "--help", "-h"].includes(command)) {
    usage();
  } else {
    throw new Error(`Unknown command '${command}'`);
  }
} catch (error) {
  console.error(`Android version error: ${error.message}`);
  process.exitCode = 1;
}

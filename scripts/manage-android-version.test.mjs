import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(scriptDirectory, "manage-android-version.mjs");

function createFixture(t, versionName = "1.2.3", versionCode = 7) {
  const directory = mkdtempSync(path.join(tmpdir(), "vibepub-version-"));
  const file = path.join(directory, "version.properties");
  writeFileSync(
    file,
    `# Fixture\nVERSION_NAME=${versionName}\nVERSION_CODE=${versionCode}\n`,
    "utf8",
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return file;
}

function createRawFixture(t, contents) {
  const directory = mkdtempSync(path.join(tmpdir(), "vibepub-version-"));
  const file = path.join(directory, "version.properties");
  writeFileSync(file, contents, "utf8");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return file;
}

function createReleasesFixture(t, releases) {
  const directory = mkdtempSync(path.join(tmpdir(), "vibepub-releases-"));
  const file = path.join(directory, "releases.json");
  writeFileSync(file, `${JSON.stringify(releases, null, 2)}\n`, "utf8");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return file;
}

function createApkFixture(t, options = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "vibepub-apk-"));
  const commit = options.commit ?? "0123456789ab";
  const apk = path.join(
    directory,
    options.filename ?? `VibePub-1.2.3-7-${commit}.apk`,
  );
  const certificateFile = path.join(directory, "release-certificate.sha256");
  const aapt = path.join(directory, "aapt");
  const apksigner = path.join(directory, "apksigner");
  writeFileSync(apk, "fixture", "utf8");
  writeFileSync(
    certificateFile,
    `${options.expectedFingerprint ?? "a".repeat(64)}\n`,
    "utf8",
  );
  writeFileSync(
    aapt,
    `#!/usr/bin/env bash
if [[ "$2" == "badging" ]]; then
  echo "package: name='cn.litianc.vibepub' versionCode='${options.versionCode ?? 7}' versionName='${options.versionName ?? "1.2.3"}'"
else
  cat <<'EOF'
      E: meta-data
        A: android:name="cn.litianc.vibepub.GIT_COMMIT"
        A: android:value="${options.embeddedCommit ?? commit}"
EOF
fi
`,
    "utf8",
  );
  writeFileSync(
    apksigner,
    `#!/usr/bin/env bash
echo "Signer #1 certificate SHA-256 digest: ${options.actualFingerprint ?? "a".repeat(64)}"
`,
    "utf8",
  );
  chmodSync(aapt, 0o755);
  chmodSync(apksigner, 0o755);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { apk, certificateFile, aapt, apksigner };
}

function runApkVerification(file, fixture, commit = "0123456789abcdef") {
  return spawnSync(process.execPath, [scriptPath, "verify-apk", fixture.apk, commit], {
    cwd: scriptDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      VIBEPUB_ANDROID_VERSION_FILE: file,
      VIBEPUB_ANDROID_CERTIFICATE_FILE: fixture.certificateFile,
      VIBEPUB_AAPT: fixture.aapt,
      VIBEPUB_APKSIGNER: fixture.apksigner,
    },
  });
}

function runVersionCommand(file, ...arguments_) {
  return spawnSync(process.execPath, [scriptPath, ...arguments_], {
    cwd: scriptDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      VIBEPUB_ANDROID_VERSION_FILE: file,
    },
  });
}

function runVersionCommandInRepository(file, repository, ...arguments_) {
  return spawnSync(process.execPath, [scriptPath, ...arguments_], {
    cwd: repository,
    encoding: "utf8",
    env: {
      ...process.env,
      VIBEPUB_ANDROID_VERSION_FILE: file,
      VIBEPUB_REPOSITORY_ROOT: repository,
    },
  });
}

function runGit(repository, ...arguments_) {
  const result = spawnSync("git", arguments_, { cwd: repository, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function createVersionRepository(t, baselineVersion) {
  const repository = mkdtempSync(path.join(tmpdir(), "vibepub-version-git-"));
  const androidDirectory = path.join(repository, "android");
  const versionFile = path.join(androidDirectory, "version.properties");
  mkdirSync(androidDirectory);
  runGit(repository, "init", "--quiet");
  runGit(repository, "config", "user.email", "version-test@example.com");
  runGit(repository, "config", "user.name", "Version Test");
  if (baselineVersion) writeFileSync(versionFile, baselineVersion, "utf8");
  else writeFileSync(path.join(repository, "README.md"), "Initial\n", "utf8");
  runGit(repository, "add", ".");
  runGit(repository, "commit", "--quiet", "-m", "baseline");
  const baselineRef = runGit(repository, "rev-parse", "HEAD");
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  return { repository, versionFile, baselineRef };
}

test("show reports the version from the public version source", (t) => {
  const file = createFixture(t);
  const result = runVersionCommand(file, "show");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "1.2.3 (7)");
});

test("patch bump increments the version name and code together", (t) => {
  const file = createFixture(t);
  const result = runVersionCommand(file, "bump", "patch");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(file, "utf8"),
    "# Fixture\nVERSION_NAME=1.2.4\nVERSION_CODE=8\n",
  );
  assert.equal(result.stdout.trim(), "1.2.4 (8)");
});

test("check rejects malformed, duplicate, unsupported, and unsafe metadata", (t) => {
  const cases = [
    ["VERSION_NAME=1.2\nVERSION_CODE=7\n", /major\.minor\.patch/],
    ["VERSION_NAME=1.2.3\nVERSION_NAME=1.2.4\nVERSION_CODE=7\n", /repeats VERSION_NAME/],
    ["VERSION_NAME=1.2.3\nVERSION_CODE=7\nCHANNEL=prod\n", /unsupported key CHANNEL/],
    ["VERSION_NAME=1.2.3\nVERSION_CODE=0\n", /positive integer/],
    ["VERSION_NAME=1.2.3\nVERSION_CODE=2100000001\n", /must not exceed/],
  ];

  for (const [contents, expectedError] of cases) {
    const result = runVersionCommand(createRawFixture(t, contents), "check");
    assert.equal(result.status, 1);
    assert.match(result.stderr, expectedError);
  }
});

test("check-against requires only the version code to strictly increase", (t) => {
  const current = createFixture(t, "1.2.3", 8);
  const older = createFixture(t, "1.2.3", 7);
  const sameCode = createFixture(t, "1.2.2", 8);

  const success = runVersionCommand(current, "check-against", older);
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /1\.2\.3 \(7\) -> 1\.2\.3 \(8\)/);

  const duplicateCode = runVersionCommand(current, "check-against", sameCode);
  assert.equal(duplicateCode.status, 1);
  assert.match(duplicateCode.stderr, /VERSION_CODE 8 must be greater/);
});

test("artifact-name binds the version and Git commit into the APK filename", (t) => {
  const file = createFixture(t);
  const result = runVersionCommand(file, "artifact-name", "0123456789abcdef");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "VibePub-1.2.3-7-0123456789ab.apk");

  const invalid = runVersionCommand(file, "artifact-name", "not-a-commit");
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Git commit must be/);
});

test("minor and major bumps reset lower parts and never overflow version code", (t) => {
  const minorFile = createFixture(t);
  const majorFile = createFixture(t);
  const maximumFile = createFixture(t, "1.2.3", 2_100_000_000);

  assert.equal(runVersionCommand(minorFile, "bump", "minor").status, 0);
  assert.match(readFileSync(minorFile, "utf8"), /VERSION_NAME=1\.3\.0\nVERSION_CODE=8/);

  assert.equal(runVersionCommand(majorFile, "bump", "major").status, 0);
  assert.match(readFileSync(majorFile, "utf8"), /VERSION_NAME=2\.0\.0\nVERSION_CODE=8/);

  const overflow = runVersionCommand(maximumFile, "bump", "patch");
  assert.equal(overflow.status, 1);
  assert.match(overflow.stderr, /cannot exceed/);
  assert.match(readFileSync(maximumFile, "utf8"), /VERSION_NAME=1\.2\.3\nVERSION_CODE=2100000000/);
});

test("github-output emits one consistent release identity", (t) => {
  const file = createFixture(t);
  const result = runVersionCommand(file, "github-output", "0123456789abcdef");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trim(),
    [
      "version_name=1.2.3",
      "version_code=7",
      "git_commit=0123456789ab",
      "artifact_name=VibePub-1.2.3-7-0123456789ab.apk",
    ].join("\n"),
  );
});

test("check-git-ref rejects equal or lower committed version codes", (t) => {
  const { repository, versionFile, baselineRef } = createVersionRepository(
    t,
    "VERSION_NAME=1.2.3\nVERSION_CODE=7\n",
  );

  writeFileSync(versionFile, "VERSION_NAME=1.2.3\nVERSION_CODE=8\n", "utf8");
  const higher = runVersionCommandInRepository(versionFile, repository, "check-git-ref", baselineRef);
  assert.equal(higher.status, 0, higher.stderr);

  writeFileSync(versionFile, "VERSION_NAME=1.2.4\nVERSION_CODE=7\n", "utf8");
  const equal = runVersionCommandInRepository(versionFile, repository, "check-git-ref", baselineRef);
  assert.equal(equal.status, 1);
  assert.match(equal.stderr, /VERSION_CODE 7 must be greater than 7/);

  writeFileSync(versionFile, "VERSION_NAME=2.0.0\nVERSION_CODE=6\n", "utf8");
  const lower = runVersionCommandInRepository(versionFile, repository, "check-git-ref", baselineRef);
  assert.equal(lower.status, 1);
  assert.match(lower.stderr, /VERSION_CODE 6 must be greater than 7/);
});

test("check-git-ref accepts the first committed version source", (t) => {
  const { repository, versionFile, baselineRef } = createVersionRepository(t, null);
  writeFileSync(versionFile, "VERSION_NAME=0.2.0\nVERSION_CODE=3\n", "utf8");

  const result = runVersionCommandInRepository(versionFile, repository, "check-git-ref", baselineRef);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /has no managed version file/);
});

test("check-releases accepts candidate commits before the first managed release", (t) => {
  const current = createFixture(t, "0.2.0", 3);
  const releases = createReleasesFixture(t, [
    {
      draft: false,
      published_at: "2026-06-30T14:05:21Z",
      assets: [{ name: "app-debug.apk", state: "uploaded" }],
    },
    {
      draft: true,
      published_at: "2026-08-25T10:00:00Z",
      assets: [{ name: "VibePub-0.1.9-9-0123456789ab.apk", state: "uploaded" }],
    },
  ]);

  const result = runVersionCommand(current, "check-releases", releases);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no published managed Android release/);
});

test("check-releases compares against the highest published managed version code", (t) => {
  const current = createFixture(t, "1.0.0", 10);
  const releases = createReleasesFixture(t, [
    {
      draft: false,
      published_at: "2026-08-25T10:00:00Z",
      assets: [{ name: "VibePub-0.9.0-7-111111111111.apk", state: "uploaded" }],
    },
    {
      draft: false,
      published_at: "2026-08-20T10:00:00Z",
      prerelease: true,
      assets: [{ name: "VibePub-0.8.0-9-222222222222.apk", state: "uploaded" }],
    },
    {
      draft: true,
      published_at: "2026-08-26T10:00:00Z",
      assets: [{ name: "VibePub-2.0.0-99-333333333333.apk", state: "uploaded" }],
    },
  ]);

  const higher = runVersionCommand(current, "check-releases", releases);
  assert.equal(higher.status, 0, higher.stderr);
  assert.match(higher.stdout, /VERSION_CODE.*9.*10|\(9\).*\(10\)/);

  writeFileSync(current, "VERSION_NAME=1.0.1\nVERSION_CODE=9\n", "utf8");
  const equal = runVersionCommand(current, "check-releases", releases);
  assert.equal(equal.status, 1);
  assert.match(equal.stderr, /VERSION_CODE 9 must be greater than 9/);

  writeFileSync(current, "VERSION_NAME=2.0.0\nVERSION_CODE=8\n", "utf8");
  const stale = runVersionCommand(current, "check-releases", releases);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /VERSION_CODE 8 must be greater than 9/);
});

test("check-releases ignores unpublished releases and assets that are still uploading", (t) => {
  const current = createFixture(t, "1.0.0", 8);
  const releases = createReleasesFixture(t, [
    {
      draft: false,
      published_at: null,
      assets: [{ name: "VibePub-2.0.0-90-444444444444.apk", state: "uploaded" }],
    },
    {
      draft: false,
      published_at: "2026-08-25T10:00:00Z",
      assets: [{ name: "VibePub-2.0.0-80-555555555555.apk", state: "uploading" }],
    },
    {
      draft: false,
      prerelease: true,
      published_at: "2026-08-24T10:00:00Z",
      assets: [{ name: "VibePub-0.9.0-7-666666666666.apk", state: "uploaded" }],
    },
  ]);

  const result = runVersionCommand(current, "check-releases", releases);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\(7\).*\(8\)/);
});

test("check-releases ignores malformed managed-looking asset names", (t) => {
  const current = createFixture(t, "0.2.0", 3);
  const releases = createReleasesFixture(t, [
    {
      draft: false,
      published_at: "2026-08-25T10:00:00Z",
      assets: [
        { name: "VibePub-1.0.0-2100000001-777777777777.apk", state: "uploaded" },
        { name: "VibePub-01.0.0-99-888888888888.apk", state: "uploaded" },
      ],
    },
  ]);

  const result = runVersionCommand(current, "check-releases", releases);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no published managed Android release/);
});

test("verify-apk accepts one final APK identity", (t) => {
  const versionFile = createFixture(t);
  const fixture = createApkFixture(t);

  const result = runApkVerification(versionFile, fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /APK identity OK: VibePub-1\.2\.3-7-0123456789ab\.apk/);
});

test("verify-apk reports a missing APK inspection tool clearly", (t) => {
  const versionFile = createFixture(t);
  const fixture = createApkFixture(t);
  fixture.aapt = path.join(path.dirname(fixture.aapt), "missing-aapt");

  const result = runApkVerification(versionFile, fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /aapt badging failed:.*ENOENT/);
  assert.doesNotMatch(result.stderr, /Cannot read properties of undefined/);
});

test("verify-apk rejects mismatched metadata, filename, commit, and signing certificate", (t) => {
  const versionFile = createFixture(t);
  const cases = [
    [{ versionName: "1.2.4" }, /versionName 1\.2\.4 does not match 1\.2\.3/],
    [{ versionCode: 8 }, /versionCode 8 does not match 7/],
    [{ embeddedCommit: "fedcba987654" }, /embedded Git commit fedcba987654 does not match/],
    [{ filename: "VibePub-1.2.3-7-fedcba987654.apk" }, /APK filename/],
    [{ actualFingerprint: "b".repeat(64) }, /signing certificate fingerprint/],
  ];

  for (const [options, expectedError] of cases) {
    const result = runApkVerification(versionFile, createApkFixture(t, options));
    assert.equal(result.status, 1);
    assert.match(result.stderr, expectedError);
  }
});
